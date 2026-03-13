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
  --repo <name>    Only process this repo (must match a name in repos[])
  --once           Run a single poll cycle and exit
  --version        Print version and exit
  --help           Show this help message

Multi-repo: configure repos[] in .ai-agent.json. Each repo entry has its own
repoPath, githubRepo, baseBranch, featureBranch, triggerLabel, skillPath, prompt.
Top-level values are defaults. Use --repo to run one repo per daemon instance.

Single-repo (backward compat): omit repos[] and set repoPath/githubRepo directly.

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

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
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

  const configPath = getArg(args, "--config");
  const repoFilter = getArg(args, "--repo");
  const once = args.includes("--once");

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(`Configuration error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Filter to a single repo if --repo is specified
  if (repoFilter) {
    const match = config.repos.find((r) => r.name === repoFilter);
    if (!match) {
      const available = config.repos.map((r) => r.name).join(", ");
      console.error(`No repo named "${repoFilter}". Available: ${available}`);
      process.exit(1);
    }
    config = { ...config, repos: [match] };
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
