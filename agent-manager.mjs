#!/usr/bin/env node
import { spawn, execSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, openSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY_POINT = join(__dirname, "dist", "cli.js");

// Parse command and --repo flag
const args = process.argv.slice(2);
const command = args[0];
const repoIdx = args.indexOf("--repo");
const repoName = repoIdx !== -1 ? args[repoIdx + 1] : null;

// Namespace PID/log files by repo name for per-repo daemon mode
const suffix = repoName ? `-${repoName}` : "";
const PID_FILE = join(__dirname, `.agent${suffix}.pid`);
const LOG_FILE = join(__dirname, `agent${suffix}.log`);

const isWindows = process.platform === "win32";

function readPid() {
  try {
    return parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  } catch {
    return null;
  }
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    if (isWindows) {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: "utf8" });
      return out.includes(String(pid));
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanPid() {
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

function start() {
  const pid = readPid();
  if (isRunning(pid)) {
    console.log(`Agent${repoName ? ` (${repoName})` : ""} is already running (PID ${pid})`);
    process.exit(1);
  }
  cleanPid();

  if (!existsSync(ENTRY_POINT)) {
    console.error("dist/cli.js not found. Run 'npm run build' first.");
    process.exit(1);
  }

  // Pass --repo flag through to the CLI
  const cliArgs = [ENTRY_POINT];
  if (repoName) {
    cliArgs.push("--repo", repoName);
  }

  const logFd = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, cliArgs, {
    cwd: __dirname,
    stdio: ["ignore", logFd, logFd],
    detached: !isWindows,
    env: process.env,
  });

  writeFileSync(PID_FILE, String(child.pid));

  if (!isWindows) child.unref();

  // Wait briefly and confirm the process is still alive
  setTimeout(() => {
    if (isRunning(child.pid)) {
      console.log(`Agent${repoName ? ` (${repoName})` : ""} started (PID ${child.pid})`);
      console.log(`Logs: ${LOG_FILE}`);
    } else {
      console.error("Agent failed to start. Check logs for details.");
      cleanPid();
      process.exit(1);
    }
    process.exit(0);
  }, 2000);
}

function stop() {
  const pid = readPid();
  if (!isRunning(pid)) {
    console.log(`Agent${repoName ? ` (${repoName})` : ""} is not running`);
    cleanPid();
    return;
  }

  console.log(`Stopping agent${repoName ? ` (${repoName})` : ""} (PID ${pid})...`);
  try {
    if (isWindows) {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGINT");
    }
  } catch (err) {
    console.error(`Failed to stop: ${err.message}`);
    process.exit(1);
  }

  // Wait for graceful shutdown (up to 65s — daemon has 60s internal timeout)
  const deadline = Date.now() + 65000;
  const poll = setInterval(() => {
    if (!isRunning(pid) || Date.now() > deadline) {
      clearInterval(poll);
      if (isRunning(pid)) {
        console.log("Graceful shutdown timed out, force killing...");
        try {
          if (isWindows) {
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
          } else {
            process.kill(pid, "SIGKILL");
          }
        } catch { /* already dead */ }
      }
      cleanPid();
      console.log("Agent stopped");
    }
  }, 200);
}

function restart() {
  const pid = readPid();
  if (isRunning(pid)) {
    stop();
    const deadline = Date.now() + 66000;
    const poll = setInterval(() => {
      if (!isRunning(pid) || Date.now() > deadline) {
        clearInterval(poll);
        start();
      }
    }, 200);
  } else {
    cleanPid();
    start();
  }
}

function status() {
  const pid = readPid();
  if (isRunning(pid)) {
    console.log(`Agent${repoName ? ` (${repoName})` : ""} is running (PID ${pid})`);

    // Show uptime on Linux
    if (!isWindows) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const startTicks = parseInt(stat.split(" ")[21], 10);
        const uptime = readFileSync("/proc/uptime", "utf8");
        const systemUptime = parseFloat(uptime.split(" ")[0]);
        const clkTck = 100;
        const processUptime = systemUptime - startTicks / clkTck;
        const hours = Math.floor(processUptime / 3600);
        const mins = Math.floor((processUptime % 3600) / 60);
        console.log(`Uptime: ${hours}h ${mins}m`);
      } catch {
        // /proc not available (macOS) — skip uptime
      }
    }

    // Show last 5 log lines
    try {
      const log = readFileSync(LOG_FILE, "utf8").trim().split("\n");
      const tail = log.slice(-5);
      console.log("\nRecent logs:");
      tail.forEach((l) => console.log(`  ${l}`));
    } catch { /* no log file */ }
  } else {
    console.log(`Agent${repoName ? ` (${repoName})` : ""} is not running`);
    if (pid) {
      console.log(`(stale PID file referenced ${pid})`);
      cleanPid();
    }
  }
}

function logs() {
  const lines = parseInt(args[1], 10) || 30;
  try {
    const log = readFileSync(LOG_FILE, "utf8").trim().split("\n");
    log.slice(-lines).forEach((l) => console.log(l));
  } catch {
    console.log("No log file found");
  }
}

switch (command) {
  case "start":
    start();
    break;
  case "stop":
    stop();
    break;
  case "restart":
    restart();
    break;
  case "status":
    status();
    break;
  case "logs":
    logs();
    break;
  default:
    console.log(`Usage: node agent-manager.mjs <command> [--repo <name>]

Commands:
  start     Start the agent daemon in the background
  stop      Stop the running agent gracefully (waits for in-progress work)
  restart   Stop and start the agent
  status    Show whether the agent is running + recent logs
  logs [N]  Show last N lines of agent log (default: 30)

Options:
  --repo <name>  Target a specific repo (uses namespaced PID/log files)
                 Enables running one daemon per repo simultaneously`);
    process.exit(command ? 1 : 0);
}
