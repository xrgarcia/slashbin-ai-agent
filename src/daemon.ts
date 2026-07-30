import type { AgentConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { runRepoPass, setConcurrencyLimit, getActiveRunCount, getActiveRunRepos, getQueuedRepoCount, abortAllRuns } from "./orchestrator.js";
import { BridgeClient, type BridgeConfig } from "./bridge-client.js";
import { configureIssueCache } from "./github.js";

export interface DaemonOptions {
  configPath?: string;
  repoFilter?: string;
}

export interface DaemonHandle {
  stop(): Promise<void>;
}

export function startDaemon(config: AgentConfig, logger: Logger, options?: DaemonOptions): DaemonHandle {
  let cycleNumber = 0;
  let stopping = false;
  let sleepResolve: (() => void) | null = null;
  let activeConfig = config;

  // --- Discord Bridge ---
  let bridge: BridgeClient | null = null;
  const bridgeUrl = process.env.DISCORD_BRIDGE_URL || "ws://127.0.0.1:9800";
  const discordBotId = process.env.DISCORD_BOT_ID;
  const statusChannel = process.env.DISCORD_STATUS_CHANNEL;
  if (discordBotId && statusChannel) {
    const bridgeConfig: BridgeConfig = {
      url: bridgeUrl,
      agentId: "foreman",
      discordBotId,
      channels: {
        status: statusChannel,
        listen: [],  // Foreman is status-only — does not respond to commands
      },
    };
    bridge = new BridgeClient(bridgeConfig, logger);
    bridge.connect();
    logger.info("Discord bridge client initialized", { url: bridgeUrl, statusChannel });
  } else {
    logger.debug("Discord bridge disabled — DISCORD_BOT_ID and DISCORD_STATUS_CHANNEL not set");
  }

  // One open-issue snapshot per repo per cycle, instead of one GraphQL request
  // per discovery lookup. See the block comment above `getOpenIssues`.
  configureIssueCache({
    ttlMs: config.issueCacheTtlMs,
    snapshotLimit: config.issueSnapshotLimit,
  });

  // A TTL at or above the poll interval means a cycle can be served entirely
  // from the previous cycle's snapshot, so an externally-applied `approved`
  // waits an extra cycle. Legal, but almost never intended — say so.
  if (config.issueCacheTtlMs >= config.pollIntervalMs) {
    logger.warn(
      "issueCacheTtlMs >= pollIntervalMs — a cycle may reuse the previous cycle's issue snapshot, delaying pickup of externally-applied labels by one cycle",
      { issueCacheTtlMs: config.issueCacheTtlMs, pollIntervalMs: config.pollIntervalMs },
    );
  }

  const repoNames = config.repos.map((r) => r.name).join(", ");
  logger.info("Daemon starting", {
    repos: repoNames,
    repoCount: config.repos.length,
    pollInterval: `${config.pollIntervalMs / 1000}s`,
    maxConcurrentRepos: config.maxConcurrentRepos,
    issueCacheTtlMs: config.issueCacheTtlMs,
    // Requests/hour the discovery phases will now spend, so the budget is
    // visible in the log rather than something you have to rediscover.
    estDiscoveryGraphQlPerHour: Math.round(
      config.repos.length * (3600_000 / config.pollIntervalMs),
    ),
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

  /**
   * Hot-reload config from disk. Picks up new repos added to .ai-agent.json
   * without requiring a daemon restart. Logs changes when repos are added/removed.
   */
  function reloadConfig(): AgentConfig {
    try {
      let fresh = loadConfig(options?.configPath);

      // Apply repo filter if specified
      if (options?.repoFilter) {
        const match = fresh.repos.find((r) => r.name === options.repoFilter);
        if (match) {
          fresh = { ...fresh, repos: [match] };
        }
      }

      // Log repo changes
      const oldNames = new Set(activeConfig.repos.map((r) => r.name));
      const newNames = new Set(fresh.repos.map((r) => r.name));

      for (const name of newNames) {
        if (!oldNames.has(name)) {
          logger.info(`Config reload: added repo "${name}"`);
        }
      }
      for (const name of oldNames) {
        if (!newNames.has(name)) {
          logger.info(`Config reload: removed repo "${name}"`);
        }
      }

      return fresh;
    } catch (err) {
      logger.warn("Config reload failed, using previous config", {
        error: err instanceof Error ? err.message : String(err),
      });
      return activeConfig;
    }
  }

  // --- One independent loop per repo -------------------------------------
  //
  // Each repo polls, works and sleeps on its OWN schedule. There is no
  // fleet-wide barrier, so a 40-minute review on one service no longer delays
  // every other service's next turn — which was still true after repos were
  // merely made concurrent WITHIN a shared cycle (2026-07-29: the fleet went
  // quiet for 24 minutes behind a single slashbin-io-worker review).
  //
  // What still bounds the fleet is the concurrency slot limiter in the
  // orchestrator: a repo acquires a slot for the duration of its pass. Twenty
  // repos waking at once queue for slots instead of opening twenty Claude
  // sessions.
  const repoLoops = new Map<string, { stop: () => void }>();

  const startRepoLoop = (repoName: string): void => {
    let loopStopping = false;
    let wake: (() => void) | null = null;

    const run = async (): Promise<void> => {
      const repoLogger = logger.child({ repo: repoName });
      while (!stopping && !loopStopping) {
        // Re-resolve from the live config each pass so a hot-reloaded setting
        // (branches, budgets, reviewEnabled) applies without a restart. A repo
        // dropped from the config ends its own loop.
        const repoConfig = activeConfig.repos.find((r) => r.name === repoName);
        if (!repoConfig) {
          repoLogger.info("Repo no longer in config — stopping its loop");
          repoLoops.delete(repoName);
          return;
        }

        let didWork = false;
        try {
          const result = await runRepoPass(repoConfig, activeConfig, logger);
          didWork = result.processed > 0;
          if (bridge) {
            for (const event of result.events) {
              bridge.sendStatus(`**FOREMAN:** ${event.message}`, event.level);
            }
          }
        } catch (err) {
          // Never let one repo's failure end its loop — that would take the
          // service permanently off the fleet with no signal beyond silence.
          repoLogger.error("Repo pass failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          bridge?.sendStatus(
            `**FOREMAN:** ${repoName} pass error — ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }

        if (didWork) continue; // more to do — go straight round again
        if (stopping || loopStopping) return;

        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(() => {
            wake = null;
            resolve();
          }, activeConfig.pollIntervalMs);
        });
      }
    };

    repoLoops.set(repoName, {
      stop: () => {
        loopStopping = true;
        if (wake) {
          wake();
          wake = null;
        }
      },
    });

    void run();
  };

  // Supervisor: hot-reload config and reconcile the set of running loops.
  const supervisor = async (): Promise<void> => {
    while (!stopping) {
      cycleNumber++;
      activeConfig = reloadConfig();
      setConcurrencyLimit(activeConfig.maxConcurrentRepos);

      for (const repo of activeConfig.repos) {
        if (!repoLoops.has(repo.name)) startRepoLoop(repo.name);
      }
      for (const [name, handle] of repoLoops) {
        if (!activeConfig.repos.some((r) => r.name === name)) handle.stop();
      }

      await new Promise<void>((resolve) => {
        sleepResolve = resolve;
        setTimeout(() => {
          sleepResolve = null;
          resolve();
        }, activeConfig.pollIntervalMs);
      });
    }
  };

  void supervisor();

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;

    logger.info("Shutting down...");

    // Wake the supervisor and every repo loop so none sits out a poll interval
    // before noticing the shutdown.
    if (sleepResolve) {
      sleepResolve();
      sleepResolve = null;
    }
    for (const handle of repoLoops.values()) handle.stop();

    // If currently implementing, drain before aborting.
    //
    // This used to wait a flat 60s and then abort. That silently contradicted
    // the systemd unit, which sets TimeoutStopSec=1800 precisely so a restart
    // does NOT kill work mid-flight — systemd would wait 30 minutes while the
    // daemon gave up after one, SIGTERMing the `claude` child and leaving a
    // half-built branch behind. An implementation run is budgeted
    // maxDurationMs (30 min by default), so the drain window has to match that
    // budget, not undercut it by 30x.
    //
    // Override with AI_AGENT_SHUTDOWN_DRAIN_MS when you deliberately want a
    // fast, work-destroying stop.
    // maxDurationMs is resolved per-repo, not globally, so take the largest
    // budget any watched repo could be mid-way through.
    const longestRun = config.repos.reduce((m, r) => Math.max(m, r.maxDurationMs), 0);
    const drainMs =
      Number(process.env.AI_AGENT_SHUTDOWN_DRAIN_MS) ||
      Math.max(longestRun, config.reviewMaxDurationMs);
    // Several repos can be mid-run at once now, so drain ALL of them. Waiting on
    // a single controller would have returned as soon as the first one finished
    // and left the rest to be SIGKILLed with half-built branches — the exact
    // outcome TimeoutStopSec=1800 exists to prevent.
    if (getActiveRunCount() > 0) {
      logger.info(
        `Waiting for ${getActiveRunCount()} in-progress run(s) to finish (${Math.round(drainMs / 1000)}s timeout)...`,
        { repos: getActiveRunRepos(), queued: getQueuedRepoCount() },
      );
      const deadline = Date.now() + drainMs;
      while (getActiveRunCount() > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (getActiveRunCount() > 0) {
        logger.warn("Drain window elapsed — aborting in-progress run(s)", { repos: getActiveRunRepos() });
        abortAllRuns();
      }
    }

    bridge?.shutdown();
    logger.info("Shutdown complete");
  };

  return { stop };
}
