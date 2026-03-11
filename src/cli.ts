#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { startDaemon } from "./daemon.js";
import { runCycle } from "./orchestrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp(): void {
  console.log(`
slashbin-ai-agent v${getVersion()}

Usage: slashbin-ai-agent [options]

Options:
  --config <path>  Path to .ai-agent.json config file
  --once           Run a single poll cycle and exit
  --version        Print version and exit
  --help           Show this help message

Requires: Claude Code CLI and GitHub CLI (gh) installed and authenticated.

Environment variables:
  AI_AGENT_REPO_PATH        Path to local repo clone (default: .)
  AI_AGENT_GITHUB_REPO      GitHub repo owner/name
  AI_AGENT_TRIGGER_LABEL    Trigger label (default: approved)
  AI_AGENT_POLL_INTERVAL_MS Poll interval in ms (default: 300000)
  AI_AGENT_SKILL_PATH       Path to skill file
  AI_AGENT_BASE_BRANCH      PR target branch (default: develop)
  AI_AGENT_FEATURE_BRANCH   Commit branch (default: features)
  AI_AGENT_MAX_TURNS        Max agent turns (default: 30)
  AI_AGENT_LOG_FORMAT       json or text (default: text)
  AI_AGENT_LOG_LEVEL        debug, info, warn, error (default: info)
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--version")) {
    console.log(getVersion());
    process.exit(0);
  }

  if (args.includes("--help")) {
    printHelp();
    process.exit(0);
  }

  const configIdx = args.indexOf("--config");
  const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;
  const once = args.includes("--once");

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(`Configuration error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const logger = createLogger({
    format: config.logFormat,
    level: config.logLevel,
  });

  logger.info(`slashbin-ai-agent v${getVersion()}`);

  if (once) {
    // Single cycle mode
    try {
      const result = await runCycle(config, logger, 1);
      process.exit(result?.success === false ? 1 : 0);
    } catch (err) {
      logger.error("Cycle failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  } else {
    // Daemon mode
    const daemon = startDaemon(config, logger);

    const shutdown = async () => {
      await daemon.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    process.on("uncaughtException", (err) => {
      logger.error("Uncaught exception", { error: err.message });
      shutdown();
    });

    process.on("unhandledRejection", (reason) => {
      logger.error("Unhandled rejection", {
        error: reason instanceof Error ? reason.message : String(reason),
      });
    });
  }
}

main();
