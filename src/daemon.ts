import type { AgentConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { runCycle, getAbortController } from "./orchestrator.js";

export interface DaemonHandle {
  stop(): Promise<void>;
}

export function startDaemon(config: AgentConfig, logger: Logger): DaemonHandle {
  let cycleNumber = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let stopping = false;

  const run = async () => {
    cycleNumber++;
    try {
      await runCycle(config, logger, cycleNumber);
    } catch (err) {
      logger.error("Unexpected error in cycle", {
        cycle: cycleNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const repoNames = config.repos.map((r) => r.name).join(", ");
  logger.info("Daemon starting", {
    repos: repoNames,
    repoCount: config.repos.length,
    pollInterval: `${config.pollIntervalMs / 1000}s`,
  });

  for (const repo of config.repos) {
    logger.info(`  repo: ${repo.name}`, {
      githubRepo: repo.githubRepo,
      repoPath: repo.repoPath,
      triggerLabel: repo.triggerLabel,
      baseBranch: repo.baseBranch,
      featureBranch: repo.featureBranch,
    });
  }

  // Run first cycle immediately
  run();

  // Schedule subsequent cycles
  interval = setInterval(run, config.pollIntervalMs);

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;

    logger.info("Shutting down...");

    if (interval) {
      clearInterval(interval);
      interval = null;
    }

    // If currently implementing, abort with timeout
    const ac = getAbortController();
    if (ac) {
      logger.info("Waiting for in-progress implementation to finish (60s timeout)...");
      const deadline = Date.now() + 60_000;
      while (getAbortController() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (getAbortController()) {
        logger.warn("Aborting in-progress implementation");
        ac.abort();
      }
    }

    logger.info("Shutdown complete");
  };

  return { stop };
}
