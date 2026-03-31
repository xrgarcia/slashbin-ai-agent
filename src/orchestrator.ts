import type { AgentConfig, RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import {
  findActionableIssues,
  hasPendingRevisions,
  findPendingRevisions,
  transitionRevisionLabels,
  findReadyForProdIssues,
  findOpenPromotionPR,
  createPromotionPR,
  checkBranchDrift,
  findOpenSyncPR,
  createSyncPR,
} from "./github.js";
import { implementApprovedIssues, revisePRFeedback, type ImplementationResult, type RevisionResult } from "./agent.js";
import { reconcileRepo } from "./reconciler.js";
import { verifyPRExists } from "./github.js";

const MAX_RETRIES = 2;

let implementing: string | null = null; // repo name, or null
let abortController: AbortController | null = null;

// Per-repo consecutive batch failure count with cooldown
const failureCount = new Map<string, number>();
const failureHitMaxAt = new Map<string, number>(); // cycle when max was hit
const revisionFailureCount = new Map<string, number>();

const FAILURE_COOLDOWN_CYCLES = 3; // retry after this many idle cycles
const lastFailureReason = new Map<string, string>(); // per-repo last failure for retry context

export interface OrchestratorState {
  implementing: string | null;
  repos: Record<string, { failures: number; revisionFailures: number }>;
}

export function getState(config: AgentConfig): OrchestratorState {
  const repos: OrchestratorState["repos"] = {};
  for (const repo of config.repos) {
    repos[repo.name] = {
      failures: failureCount.get(repo.name) ?? 0,
      revisionFailures: revisionFailureCount.get(repo.name) ?? 0,
    };
  }
  return { implementing, repos };
}

export function getAbortController(): AbortController | null {
  return abortController;
}

export interface CycleEvent {
  message: string;
  level: "info" | "warn" | "error";
}

export interface CycleResult {
  didWork: boolean;
  lastImplementation: ImplementationResult | null;
  events: CycleEvent[];
}

export async function runCycle(
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number
): Promise<CycleResult> {
  const cycleLogger = logger.child({ cycle: cycleNumber, phase: "poll" });

  let totalProcessed = 0;
  let lastResult: ImplementationResult | null = null;
  const events: CycleEvent[] = [];

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
        events.push({ message: `Reconciled ${repoConfig.name} (features → develop) — PR: ${result.prUrl}`, level: "info" });
        totalProcessed++;
      }
    } catch (err) {
      reconLogger.error("Reconciliation failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Phase 1: Revise PRs with pending review feedback ---
  for (const repoConfig of config.repos) {
    const revised = await tryRevision(repoConfig, logger, cycleNumber);
    if (revised) {
      events.push({ message: `Revised PR on ${repoConfig.name} (features → develop, review feedback)`, level: "info" });
      totalProcessed++;
    }
  }

  // --- Phase 2: Implement approved issues (one batch per repo) ---
  for (const repoConfig of config.repos) {
    const result = await tryBatchImplementation(repoConfig, logger, cycleNumber, events);
    if (result) {
      totalProcessed++;
      lastResult = result;
    }
  }

  // --- Phase 3: Create promotion PRs for repos with ready-for-prod issues ---
  for (const repoConfig of config.repos) {
    const promotionResult = tryPromotion(repoConfig, logger, cycleNumber);
    if (promotionResult === "promoted") {
      events.push({ message: `Production promotion PR created on ${repoConfig.name} (develop → main)`, level: "info" });
      totalProcessed++;
    } else if (promotionResult === "synced") {
      events.push({ message: `Branch sync PR created and merged on ${repoConfig.name} (main → develop) — promotion will follow`, level: "info" });
      totalProcessed++;
    }
  }

  if (totalProcessed === 0) {
    cycleLogger.info("No work across all repos");
  } else {
    cycleLogger.info(`Cycle complete — processed ${totalProcessed} item(s)`);
  }

  return { didWork: totalProcessed > 0, lastImplementation: lastResult, events };
}

async function tryBatchImplementation(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number,
  events?: CycleEvent[]
): Promise<ImplementationResult | null> {
  const repoName = repoConfig.name;
  const repoLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "implement" });

  // Check if this repo has exceeded batch failure retries
  const failures = failureCount.get(repoName) ?? 0;
  if (failures >= MAX_RETRIES) {
    const hitAt = failureHitMaxAt.get(repoName) ?? cycleNumber;
    const cyclesSinceMax = cycleNumber - hitAt;
    if (cyclesSinceMax < FAILURE_COOLDOWN_CYCLES) {
      repoLogger.debug(`Skipping ${repoName} — ${failures} consecutive failures, cooldown ${cyclesSinceMax}/${FAILURE_COOLDOWN_CYCLES} cycles`);
      return null;
    }
    // Cooldown expired — reset and retry
    repoLogger.info(`Failure cooldown expired for ${repoName} — resetting and retrying`);
    failureCount.set(repoName, 0);
    failureHitMaxAt.delete(repoName);
  }

  // Gate: are there approved issues to implement?
  const actionableIssues = findActionableIssues(repoConfig, repoLogger);
  if (actionableIssues.length === 0) {
    // Reset failure count when there's no work (issues were resolved externally)
    if (failures > 0) failureCount.set(repoName, 0);
    return null;
  }

  // Emit event: issues picked up
  events?.push({ message: `Picked up ${actionableIssues.length} issue(s) on ${repoName}: ${actionableIssues.map(n => `#${n}`).join(", ")}`, level: "info" });

  // Gate: if there's a PR awaiting revision ("pr pending actions"), skip implementation.
  // The revision phase (Phase 1) handles these — running implementation would just
  // re-detect the same committed issues and loop without making progress.
  if (hasPendingRevisions(repoConfig, repoLogger)) {
    repoLogger.debug(`Skipping ${repoName} implementation — PR awaiting revision`);
    return null;
  }

  // Note: we do NOT gate on an open feature PR. The features branch accumulates
  // commits and an open PR auto-updates to include new commits. The skill handles
  // idempotency — it skips issues already committed on features. If no open PR
  // exists, the skill creates one. If one exists, new commits are added to it.

  // Invoke the skill — one Claude session implements all approved issues
  implementing = repoName;
  abortController = new AbortController();
  repoLogger.info(`Triggering batch implementation for ${repoName}`);

  try {
    const priorFailure = lastFailureReason.get(repoName) || null;
    const result = await implementApprovedIssues(repoConfig, repoLogger, abortController.signal, priorFailure, actionableIssues);

    if (result.success) {
      failureCount.set(repoName, 0);
      lastFailureReason.delete(repoName);
      failureHitMaxAt.delete(repoName);
      repoLogger.info(`Batch implementation succeeded`, { prUrl: result.prUrl });
      events?.push({ message: `Feature PR on ${repoName} (features → develop): ${result.prUrl || "(commits added)"}`, level: "info" });
    } else {
      const newCount = (failureCount.get(repoName) ?? 0) + 1;
      failureCount.set(repoName, newCount);
      if (newCount >= MAX_RETRIES) {
        failureHitMaxAt.set(repoName, cycleNumber);
      }
      lastFailureReason.set(repoName, result.error || "unknown");
      repoLogger.warn(`Batch implementation failed (${newCount}/${MAX_RETRIES}): ${result.error}`);
      events?.push({ message: `Implementation failed on ${repoName}: ${result.error}`, level: "error" });
    }

    return result;
  } finally {
    implementing = null;
    abortController = null;
  }
}

async function tryRevision(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number
): Promise<boolean> {
  const repoName = repoConfig.name;
  const revLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "revision" });

  // Check if this repo has exceeded revision failure retries
  const failures = revisionFailureCount.get(repoName) ?? 0;
  if (failures >= MAX_RETRIES) {
    revLogger.debug(`Skipping ${repoName} revision — ${failures} consecutive failures`);
    return false;
  }

  // Gate: are there issues with pending review feedback + an open feature PR?
  const pending = findPendingRevisions(repoConfig, revLogger);
  if (!pending) {
    if (failures > 0) revisionFailureCount.set(repoName, 0);
    return false;
  }

  // Invoke the revision skill with specific PR and issue context
  implementing = repoName;
  abortController = new AbortController();
  revLogger.info(`Triggering PR revision for ${repoName} — PR #${pending.pr.number}, issues: ${pending.issueNumbers.map(n => `#${n}`).join(", ")}`);

  try {
    const result = await revisePRFeedback(
      repoConfig, revLogger, abortController.signal,
      pending.pr.number, pending.issueNumbers,
    );

    if (result.success) {
      revisionFailureCount.set(repoName, 0);

      // Transition issue labels: "pr pending actions" → "pr under review"
      // The orchestrator owns this because the skill runs in the service repo
      // and may not have the right context to find the issue labels.
      transitionRevisionLabels(
        repoConfig.githubRepo,
        pending.issueNumbers,
        repoConfig.repoPath,
        revLogger,
      );

      revLogger.info("PR revision succeeded");
    } else {
      const newCount = failures + 1;
      revisionFailureCount.set(repoName, newCount);
      revLogger.warn(`PR revision failed (${newCount}/${MAX_RETRIES}): ${result.error}`);
    }

    return result.success;
  } finally {
    implementing = null;
    abortController = null;
  }
}

function tryPromotion(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number
): "promoted" | "synced" | null {
  const repoName = repoConfig.name;
  const promoLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "promote" });

  // Main-only repos (like docs) don't have develop → main promotion
  if (repoConfig.baseBranch === "main" && repoConfig.featureBranch === "main") {
    return null;
  }

  const issues = findReadyForProdIssues(repoConfig.githubRepo, repoConfig.repoPath, promoLogger);
  if (issues.length === 0) return null;

  promoLogger.info(`Found ${issues.length} issue(s) ready for prod release`);

  // Don't create a duplicate promotion PR
  const existingPR = findOpenPromotionPR(repoConfig.githubRepo, "main", repoConfig.repoPath);
  if (existingPR) {
    promoLogger.warn(`Promotion PR already open — #${existingPR.number}: ${existingPR.url}`);
    return null;
  }

  // Check for branch drift (develop behind main due to merge commits)
  const drift = checkBranchDrift(repoConfig.githubRepo, repoConfig.repoPath, promoLogger);
  if (drift && drift.developBehindMain > 0) {
    promoLogger.info(`develop is ${drift.developBehindMain} commit(s) behind main — sync required before promotion`);

    // Check if a sync PR already exists
    const existingSyncPR = findOpenSyncPR(repoConfig.githubRepo, repoConfig.repoPath);
    if (existingSyncPR) {
      promoLogger.info(`Sync PR already open — #${existingSyncPR.number}: ${existingSyncPR.url}`);
      return null;
    }

    const syncUrl = createSyncPR(repoConfig.githubRepo, drift.developBehindMain, repoConfig.repoPath, promoLogger);
    if (syncUrl) {
      promoLogger.info(`Sync PR created and auto-merged: ${syncUrl}`);
      return "synced";
    } else {
      promoLogger.warn("Failed to create sync PR");
      return null;
    }
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
    return "promoted";
  } else {
    promoLogger.warn("Failed to create promotion PR");
    return null;
  }
}
