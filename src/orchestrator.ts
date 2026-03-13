import type { AgentConfig, RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import {
  hasApprovedIssues,
  findReadyForProdIssues,
  findOpenPromotionPR,
  createPromotionPR,
} from "./github.js";
import { implementApprovedIssues, type ImplementationResult } from "./agent.js";
import { reconcileRepo } from "./reconciler.js";
import { verifyPRExists } from "./github.js";

const MAX_RETRIES = 2;

let implementing: string | null = null; // repo name, or null
let abortController: AbortController | null = null;

// Per-repo consecutive batch failure count
const failureCount = new Map<string, number>();

export interface OrchestratorState {
  implementing: string | null;
  repos: Record<string, { failures: number }>;
}

export function getState(config: AgentConfig): OrchestratorState {
  const repos: OrchestratorState["repos"] = {};
  for (const repo of config.repos) {
    repos[repo.name] = {
      failures: failureCount.get(repo.name) ?? 0,
    };
  }
  return { implementing, repos };
}

export function getAbortController(): AbortController | null {
  return abortController;
}

export async function runCycle(
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number
): Promise<ImplementationResult | null> {
  const cycleLogger = logger.child({ cycle: cycleNumber, phase: "poll" });

  if (implementing !== null) {
    cycleLogger.info(`Busy implementing ${implementing}, skipping cycle`);
    return null;
  }

  let totalProcessed = 0;
  let lastResult: ImplementationResult | null = null;

  // --- Phase 0: Reconcile orphaned commits (features ahead of develop with no PR) ---
  for (const repoConfig of config.repos) {
    const reconLogger = logger.child({ cycle: cycleNumber, repo: repoConfig.name, phase: "reconcile" });
    try {
      const result = reconcileRepo(repoConfig, reconLogger);
      if (result.reconciled) {
        reconLogger.info(
          `Reconciled ${result.commitCount} orphaned commit(s) — PR created: ${result.prUrl}`,
          { issues: result.issueNumbers },
        );
        totalProcessed++;
      }
    } catch (err) {
      reconLogger.error("Reconciliation failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Phase 1: Implement approved issues (one batch per repo) ---
  for (const repoConfig of config.repos) {
    const result = await tryBatchImplementation(repoConfig, logger, cycleNumber);
    if (result) {
      totalProcessed++;
      lastResult = result;
    }
  }

  // --- Phase 2: Create promotion PRs for repos with ready-for-prod issues ---
  for (const repoConfig of config.repos) {
    const promotionCount = tryPromotion(repoConfig, logger, cycleNumber);
    totalProcessed += promotionCount;
  }

  if (totalProcessed === 0) {
    cycleLogger.info("No work across all repos");
  } else {
    cycleLogger.info(`Cycle complete — processed ${totalProcessed} item(s)`);
  }

  return lastResult;
}

async function tryBatchImplementation(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number
): Promise<ImplementationResult | null> {
  const repoName = repoConfig.name;
  const repoLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "implement" });

  // Check if this repo has exceeded batch failure retries
  const failures = failureCount.get(repoName) ?? 0;
  if (failures >= MAX_RETRIES) {
    repoLogger.debug(`Skipping ${repoName} — ${failures} consecutive batch failures`);
    return null;
  }

  // Gate: are there approved issues to implement?
  const hasWork = hasApprovedIssues(repoConfig, repoLogger);
  if (!hasWork) {
    // Reset failure count when there's no work (issues were resolved externally)
    if (failures > 0) failureCount.set(repoName, 0);
    return null;
  }

  // Gate: is there already an open feature PR? If so, skill already ran — wait for review.
  const hasFeaturePR = verifyPRExists(
    repoConfig.githubRepo,
    repoConfig.featureBranch,
    repoConfig.baseBranch,
    repoConfig.repoPath,
  );
  if (hasFeaturePR) {
    repoLogger.debug(`Open PR exists for ${repoConfig.featureBranch} → ${repoConfig.baseBranch} — skipping`);
    return null;
  }

  // Invoke the skill — one Claude session implements all approved issues
  implementing = repoName;
  abortController = new AbortController();
  repoLogger.info(`Triggering batch implementation for ${repoName}`);

  try {
    const result = await implementApprovedIssues(repoConfig, repoLogger, abortController.signal);

    if (result.success) {
      failureCount.set(repoName, 0);
      repoLogger.info(`Batch implementation succeeded`, { prUrl: result.prUrl });
    } else {
      const newCount = failures + 1;
      failureCount.set(repoName, newCount);
      repoLogger.warn(`Batch implementation failed (${newCount}/${MAX_RETRIES}): ${result.error}`);
    }

    return result;
  } finally {
    implementing = null;
    abortController = null;
  }
}

function tryPromotion(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number
): number {
  const repoName = repoConfig.name;
  const promoLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "promote" });

  // Main-only repos (like docs) don't have develop → main promotion
  if (repoConfig.baseBranch === "main" && repoConfig.featureBranch === "main") {
    return 0;
  }

  const issues = findReadyForProdIssues(repoConfig.githubRepo, repoConfig.repoPath, promoLogger);
  if (issues.length === 0) return 0;

  promoLogger.info(`Found ${issues.length} issue(s) ready for prod release`);

  // Don't create a duplicate promotion PR
  const existingPR = findOpenPromotionPR(repoConfig.githubRepo, "main", repoConfig.repoPath);
  if (existingPR) {
    promoLogger.warn(`Promotion PR already open — #${existingPR.number}: ${existingPR.url}`);
    return 0;
  }

  const prUrl = createPromotionPR(
    repoConfig.githubRepo,
    "main",
    issues,
    repoConfig.repoPath,
  );

  if (prUrl) {
    promoLogger.info(`Promotion PR created: ${prUrl}`, {
      issues: issues.map((i) => i.number),
    });
    return 1;
  } else {
    promoLogger.warn("Failed to create promotion PR");
    return 0;
  }
}
