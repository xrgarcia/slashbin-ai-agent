import type { AgentConfig, RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import {
  findActionableIssues,
  findAllApprovedActionableIssues,
  hasPendingRevisions,
  findPendingRevisions,
  transitionRevisionLabels,
  transitionImplementationLabels,
  getReferencedIssuesFromOpenPR,
  findReadyForProdIssues,
  findOpenPromotionPR,
  createPromotionPR,
  updatePromotionPR,
  checkBranchDrift,
  findOpenSyncPR,
  createSyncPR,
  countBranchDiffFiles,
  stripReadyForProdLabel,
  type PendingRevisionInfo,
} from "./github.js";
import { implementApprovedIssues, revisePRFeedback, type ImplementationResult, type RevisionResult } from "./agent.js";
import { reconcileRepo } from "./reconciler.js";
import { verifyPRExists } from "./github.js";
import { loadRepoState, saveRepoState } from "./state.js";

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
        events.push({ message: `Reconciled ${repoConfig.githubRepo} — ${result.commitCount} orphaned commit(s), PR: ${result.prUrl}`, level: "info" });
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
    const revisionInfo = await tryRevision(repoConfig, logger, cycleNumber);
    if (revisionInfo) {
      events.push({ message: `Revised ${repoConfig.githubRepo} PR #${revisionInfo.pr.number} (issues: ${revisionInfo.issueNumbers.map(n => `#${n}`).join(", ")})`, level: "info" });
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

  // --- Phase 3: Reconcile branch drift (main → develop) for any repo with
  //    post-promotion merge commits. Runs independently of promotion work so
  //    drift is cleared even when no ready-for-prod issues exist. ---
  for (const repoConfig of config.repos) {
    if (repoConfig.baseBranch === "main" && repoConfig.featureBranch === "main") continue;
    const synced = trySyncDrift(repoConfig, logger, cycleNumber);
    if (synced) {
      events.push({ message: `Branch sync on ${repoConfig.githubRepo} (main → develop) — merged`, level: "info" });
      totalProcessed++;
    }
  }

  // --- Phase 4: Create promotion PRs for repos with ready-for-prod issues ---
  for (const repoConfig of config.repos) {
    const promotionResult = tryPromotion(repoConfig, logger, cycleNumber);
    if (promotionResult === "promoted") {
      events.push({ message: `Promotion PR created on ${repoConfig.githubRepo} (develop → main)`, level: "info" });
      totalProcessed++;
    } else if (promotionResult === "synced") {
      events.push({ message: `Branch sync on ${repoConfig.githubRepo} (main → develop) — merged, promotion will follow`, level: "info" });
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
  let actionableIssues = findActionableIssues(repoConfig, repoLogger);
  if (actionableIssues.length === 0) {
    // Reset failure count when there's no work (issues were resolved externally)
    if (failures > 0) failureCount.set(repoName, 0);
    return null;
  }

  // Filter out issues already tracked as implemented in persistent state.
  // This prevents infinite loops where the Foreman re-implements the same
  // issues because the PR check in findActionableIssues didn't match.
  const repoState = loadRepoState(repoName);
  const alreadyImplemented = new Set(repoState.implemented);
  actionableIssues = actionableIssues.filter((n) => !alreadyImplemented.has(n));
  if (actionableIssues.length === 0) {
    repoLogger.info(`All actionable issues already implemented (state filter) — skipping`);
    if (failures > 0) failureCount.set(repoName, 0);
    return null;
  }

  // Filter out issues the agent recently chose to skip (investigation-only,
  // blocked-on-external-verification, etc.). Back off for SKIP_BACKOFF_MS so
  // we don't burn an agent run every cycle correctly doing nothing.
  // Skipped entries are cleared automatically when the issue is re-implemented
  // (success path) or when the back-off expires.
  const skippedMap = repoState.skipped ?? {};
  const SKIP_BACKOFF_MS = 30 * 60 * 1000; // 30 min
  const now = Date.now();
  const stillBackedOff: number[] = [];
  actionableIssues = actionableIssues.filter((n) => {
    const entry = skippedMap[n];
    if (!entry) return true;
    const age = now - new Date(entry.lastSkippedAt).getTime();
    if (Number.isNaN(age) || age >= SKIP_BACKOFF_MS) return true;
    stillBackedOff.push(n);
    return false;
  });
  if (stillBackedOff.length > 0) {
    repoLogger.debug(`Backing off ${stillBackedOff.length} previously-skipped issue(s): ${stillBackedOff.map(n => `#${n}`).join(", ")}`);
  }
  if (actionableIssues.length === 0) {
    if (failures > 0) failureCount.set(repoName, 0);
    return null;
  }

  // Emit event: issues picked up
  events?.push({ message: `Picked up ${actionableIssues.length} issue(s) on ${repoConfig.githubRepo}: ${actionableIssues.map(n => `#${n}`).join(", ")}`, level: "info" });

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

      // Filter to only issues the implementation skill actually addressed in
      // the resulting PR. The canonical implement-approved-issues skill picks
      // ONE issue per invocation, AND it picks from the entire approved set
      // (priority + smaller-scope-first), not necessarily from the Foreman's
      // discovery batch. So the labeling-eligible set is the broader
      // "all-approved-and-actionable" set — not just `actionableIssues`
      // (which is also PR-uncovered + capped at MAX_BATCH_SIZE).
      //
      // Three cases for the intersection of `referencedAll ∩ allActionable`:
      //   1. matched.length > 0 → label the matched subset.
      //   2. referencedAll === null (gh lookup failed) → conservative
      //      fallback: label the discovery batch (`actionableIssues`), since
      //      we can't tell what shipped. Over-labeling is recoverable (EM
      //      cleanup); under-labeling stalls.
      //   3. matched.length === 0 (parser succeeded, found zero matches in
      //      the broader actionable set) → SKIP labeling + state-update
      //      entirely. The open PR exists but doesn't reference any
      //      currently-actionable approved issue. Labeling discovery-batch
      //      issues here would create self-locked issues (state filter sees
      //      them as `implemented`, no real PR to revise), requiring manual
      //      EM cleanup every cycle. (slashbin-ai-foreman#16)
      //
      // Widening to allActionable (vs just actionableIssues) is the
      // slashbin-ai-foreman#18 fix: if the skill picked an out-of-batch
      // approved issue, the resulting PR still gets correctly labeled.
      const referencedAll = getReferencedIssuesFromOpenPR(
        repoConfig.githubRepo,
        repoConfig.featureBranch,
        repoConfig.baseBranch,
        repoConfig.repoPath,
        repoLogger,
      );
      const allActionable = findAllApprovedActionableIssues(repoConfig, repoLogger);
      const labelingCandidates = Array.from(new Set([...actionableIssues, ...allActionable]));
      const matched = referencedAll
        ? labelingCandidates.filter((n) => referencedAll.includes(n))
        : null;

      if (matched !== null && matched.length === 0) {
        // Case 3: empty intersection — skip labeling + state-update, log
        // warning, exit cleanly. Next cycle re-discovers and retries.
        repoLogger.warn(
          `Open PR found but its body/title/commits do not reference any actionable approved issue (discovery batch: #${actionableIssues.join(", #")}; broader set: #${labelingCandidates.join(", #")}) — skipping label + state update so the next cycle can retry. Investigate the skill's PR formatting if this recurs.`,
        );
        return null;
      }

      const issuesActuallyImplemented =
        matched && matched.length > 0 ? matched : actionableIssues;
      if (matched && matched.length > 0) {
        const fromBatch = matched.filter((n) => actionableIssues.includes(n));
        const fromBroader = matched.filter((n) => !actionableIssues.includes(n));
        const dropped = actionableIssues.filter((n) => !matched.includes(n));
        if (fromBroader.length > 0) {
          repoLogger.info(
            `Skill implemented ${matched.length} issue(s) — ${fromBatch.length} from discovery batch, ${fromBroader.length} from broader actionable set (skill priority differs from Foreman batch order)`,
            { implemented: matched, fromBatch, fromBroader, deferred: dropped },
          );
        } else if (matched.length < actionableIssues.length) {
          repoLogger.info(
            `Skill implemented ${matched.length}/${actionableIssues.length} discovered issues — labeling only the implemented set`,
            { implemented: matched, deferred: dropped },
          );
        }
      } else if (referencedAll === null) {
        repoLogger.warn(
          `getReferencedIssuesFromOpenPR returned null (lookup failed) — labeling full discovery batch as conservative fallback (#${actionableIssues.join(", #")})`,
        );
      }

      // Persist implemented issue numbers to prevent re-implementation loops
      const updatedState = loadRepoState(repoName);
      for (const issueNum of issuesActuallyImplemented) {
        if (!updatedState.implemented.includes(issueNum)) {
          updatedState.implemented.push(issueNum);
        }
        // Clear any prior skip record — if it's now implemented, the prior
        // "blocked on investigation" state is resolved.
        if (updatedState.skipped) delete updatedState.skipped[issueNum];
      }
      saveRepoState(repoName, updatedState);

      // Add "pr under review" label so EM knows PRs are ready for review
      transitionImplementationLabels(repoConfig.githubRepo, issuesActuallyImplemented, repoConfig.repoPath, repoLogger);

      repoLogger.info(`Batch implementation succeeded — tracked ${issuesActuallyImplemented.map(n => `#${n}`).join(", ")} in state`, { prUrl: result.prUrl });
      events?.push({ message: `Feature PR on ${repoConfig.githubRepo}: ${result.prUrl || "(commits added to existing PR)"}`, level: "info" });
    } else if (result.skipped) {
      // Deliberate no-op by the agent (e.g., issue body says "investigate first").
      // Record per-issue skip timestamps so the back-off filter at the top of
      // this function suppresses retries for SKIP_BACKOFF_MS.
      // Do NOT increment failureCount — this isn't an error.
      const updatedState = loadRepoState(repoName);
      if (!updatedState.skipped) updatedState.skipped = {};
      const skippedSet = result.skippedIssues && result.skippedIssues.length > 0
        ? result.skippedIssues
        : actionableIssues;
      const reason = result.skipReason ?? "no reason given";
      const stamp = new Date().toISOString();
      for (const issueNum of skippedSet) {
        updatedState.skipped[issueNum] = { lastSkippedAt: stamp, reason };
      }
      saveRepoState(repoName, updatedState);
      // Reset the failure counter — an explicit skip is not a failure.
      failureCount.set(repoName, 0);
      lastFailureReason.delete(repoName);
      failureHitMaxAt.delete(repoName);
      repoLogger.info(`Batch implementation skipped by agent: ${reason} (issues: ${skippedSet.map(n => `#${n}`).join(", ")})`);
      events?.push({ message: `Implementation skipped on ${repoConfig.githubRepo}: ${reason}`, level: "info" });
    } else {
      const newCount = (failureCount.get(repoName) ?? 0) + 1;
      failureCount.set(repoName, newCount);
      if (newCount >= MAX_RETRIES) {
        failureHitMaxAt.set(repoName, cycleNumber);
      }
      lastFailureReason.set(repoName, result.error || "unknown");
      repoLogger.warn(`Batch implementation failed (${newCount}/${MAX_RETRIES}): ${result.error}`);
      events?.push({ message: `Implementation failed on ${repoConfig.githubRepo}: ${result.error}`, level: "error" });
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
): Promise<PendingRevisionInfo | null> {
  const repoName = repoConfig.name;
  const revLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "revision" });

  // Check if this repo has exceeded revision failure retries
  const failures = revisionFailureCount.get(repoName) ?? 0;
  if (failures >= MAX_RETRIES) {
    revLogger.debug(`Skipping ${repoName} revision — ${failures} consecutive failures`);
    return null;
  }

  // Gate: are there issues with pending review feedback + an open feature PR?
  const pending = findPendingRevisions(repoConfig, revLogger);
  if (!pending) {
    if (failures > 0) revisionFailureCount.set(repoName, 0);
    return null;
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
      return pending;
    } else {
      const newCount = failures + 1;
      revisionFailureCount.set(repoName, newCount);
      revLogger.warn(`PR revision failed (${newCount}/${MAX_RETRIES}): ${result.error}`);
    }

    return null;
  } finally {
    implementing = null;
    abortController = null;
  }
}

function trySyncDrift(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number
): boolean {
  const syncLogger = logger.child({ cycle: cycleNumber, repo: repoConfig.name, phase: "sync" });

  const drift = checkBranchDrift(repoConfig.githubRepo, repoConfig.repoPath, syncLogger);
  if (!drift || drift.developBehindMain === 0) return false;

  const existing = findOpenSyncPR(repoConfig.githubRepo, repoConfig.repoPath, syncLogger);
  if (existing) {
    syncLogger.info(`Sync PR already open — #${existing.number}: ${existing.url}`);
    return false;
  }

  syncLogger.info(`develop is ${drift.developBehindMain} commit(s) behind main — creating sync PR`);
  const syncUrl = createSyncPR(repoConfig.githubRepo, drift.developBehindMain, repoConfig.repoPath, syncLogger);
  if (syncUrl) {
    syncLogger.info(`Sync PR created and auto-merged: ${syncUrl}`);
    return true;
  }
  syncLogger.warn("Failed to create sync PR");
  return false;
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

  // Check if a promotion PR already exists
  const existingPR = findOpenPromotionPR(repoConfig.githubRepo, "main", repoConfig.repoPath, promoLogger);
  if (existingPR) {
    // Check if the PR body is missing any current ready-for-prod issues
    const listedIssues = new Set(
      (existingPR.body.match(/#(\d+)/g) || []).map((m) => parseInt(m.slice(1), 10))
    );
    const missingIssues = issues.filter((i) => !listedIssues.has(i.number));

    if (missingIssues.length > 0) {
      const updated = updatePromotionPR(
        repoConfig.githubRepo, existingPR.number, issues, repoConfig.repoPath
      );
      if (updated) {
        promoLogger.info(
          `Updated promotion PR #${existingPR.number} — added ${missingIssues.length} issue(s): ${missingIssues.map((i) => `#${i.number}`).join(", ")}`
        );
      } else {
        promoLogger.warn(`Failed to update promotion PR #${existingPR.number}`);
      }
    } else {
      promoLogger.info(`Promotion PR #${existingPR.number} already includes all ${issues.length} issue(s)`);
    }
    return null;
  }

  // Guard: confirm develop actually has file changes main is missing before
  // creating the promotion PR. develop can be "ahead" of main by 1+ commits
  // purely from sync merge commits (main → develop) that carry no file diff.
  // In that case an issue still labeled `ready for prod release` (because the
  // EM verification script hasn't stripped it yet) would trigger a phantom
  // no-op promotion PR — the ping-pong bug.
  const diffFiles = countBranchDiffFiles(repoConfig.githubRepo, "main", "develop", repoConfig.repoPath, promoLogger);
  if (diffFiles === 0) {
    promoLogger.info(
      `Skipping promotion — develop has no file changes vs main despite ${issues.length} ready-for-prod issue(s). ` +
      `Likely a race with EM verification stripping labels after a recent promotion merged. Labels will clear on next verify cycle.`
    );
    return null;
  }
  if (diffFiles < 0) {
    promoLogger.warn("Could not compute branch diff — proceeding with promotion PR creation (best effort)");
  }

  const prUrl = createPromotionPR(
    repoConfig.githubRepo,
    "main",
    issues,
    repoConfig.repoPath,
    promoLogger,
  );

  if (prUrl) {
    promoLogger.info(`Promotion PR created: ${prUrl}`, {
      issues: issues.map((i) => i.number),
    });
    // Strip the `ready for prod release` label now that the promotion PR
    // owns these issues. Prevents the Foreman from treating the same issues
    // as still-to-promote on its next cycle (which races with the EM
    // verification script that normally strips labels at close time).
    stripReadyForProdLabel(
      repoConfig.githubRepo,
      issues.map((i) => i.number),
      repoConfig.repoPath,
      promoLogger,
    );
    return "promoted";
  } else {
    promoLogger.warn("Failed to create promotion PR");
    return null;
  }
}
