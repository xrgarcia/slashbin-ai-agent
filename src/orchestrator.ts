import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentConfig, RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import {
  findActionableIssues,
  findAllApprovedActionableIssues,
  hasPendingRevisions,
  findPendingRevisions,
  findPRsNeedingReview,
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
  tryMergeSyncPR,
  countBranchDiffFiles,
  stripReadyForProdLabel,
  type PendingRevisionInfo,
} from "./github.js";
import { implementApprovedIssues, revisePRFeedback, reviewOpenPRs, type ImplementationResult, type RevisionResult } from "./agent.js";
import { reconcileRepo, checkLocalBranchDivergence } from "./reconciler.js";
import {
  verifyPRExists,
  findStuckMergedIssues,
  findIssuesMergedToBase,
  transitionToReadyForProd,
  findIssuesStillUnderReview,
  resolveDeadZone,
  transitionReviewOutcomeLabel,
  snapshotEmGate,
  restoreEmGate,
  EM_GATE_LABEL,
} from "./github.js";
import type { ReviewTrailer } from "./agent.js";
import { loadRepoState, saveRepoState } from "./state.js";

const MAX_RETRIES = 2;

// Agent runs in flight, keyed by repo name. Repos progress CONCURRENTLY (one
// queue per service — see runCycle), so "the" in-flight run stopped being a
// single thing; a lone `abortController` would have tracked whichever repo
// started last and let a restart SIGKILL every other repo's half-built branch.
// One entry per repo, at most — a repo's own phases stay strictly sequential
// because they share one git working clone.
const activeRuns = new Map<string, AbortController>();

// Per-repo consecutive batch failure count with cooldown
const failureCount = new Map<string, number>();
const failureHitMaxAt = new Map<string, number>(); // cycle when max was hit
const revisionFailureCount = new Map<string, number>();
const reviewFailureCount = new Map<string, number>();
const reviewFailureHitMaxAt = new Map<string, number>();

// Last cycle on which each repo checked whether an empty ready-for-prod set is
// actually a stall. Rate-limits one compare API call per repo; see tryPromotion.
const lastStallCheckCycle = new Map<string, number>();
const STALL_CHECK_CYCLE_INTERVAL = 12;

/** Per-repo set of issue numbers already alerted as dead-zoned, so a STANDING
 *  condition alerts once instead of every reconcile cycle. Cleared per-issue when
 *  the issue leaves the dead-zone, so a genuine re-entry alerts again. */
const deadZoneAlerted = new Map<string, Set<number>>();

/** Per-repo set of issue numbers we already attempted to auto-recover, so a
 *  repo whose verification is INDETERMINATE (unmapped service, verifier crash)
 *  does not re-spend a multi-minute deploy poll on every cycle, forever. */
const deadZoneRecoveryAttempted = new Map<string, Set<number>>();

/** Ceiling on one dead-zone re-verification. The verifier polls a Railway
 *  deployment, so minutes are normal and hanging forever is not. */
const RECOVERY_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

const FAILURE_COOLDOWN_CYCLES = 3; // retry after this many idle cycles
const lastFailureReason = new Map<string, string>(); // per-repo last failure for retry context

/**
 * Repair one dead-zoned issue by re-running the post-merge verification the
 * failed review never completed, then labeling from ITS verdict.
 *
 * This is not a rubber stamp, which is the objection that kept the dead zone
 * detection-only. The verdict comes from the verifier — a real deploy poll and
 * healthcheck against the merged commit — not from the agent that dropped the
 * ball, and not from the mere fact that a merge happened. `pr approved` on PASS
 * is precisely the state a healthy review would have left behind; `pr pending
 * actions` on FAIL routes it to the revise phase, which is what a post-merge
 * FAIL is supposed to do. A FAIL is still a HOLD — it just becomes a hold the
 * pipeline knows about instead of an issue nobody is looking at.
 *
 * `ready for prod release` is never applied here: that label is the EM outcome
 * gate's signature and stays a human act.
 *
 * Returns the verdict, or "indeterminate" when we could not get a trustworthy
 * answer — an unmapped repo (the verifier exits 2 for a service it has no
 * Railway mapping for), a verifier crash, or a timeout. Indeterminate changes
 * NOTHING: the issue stays dead-zoned and alerted, which is strictly better
 * than guessing at a lifecycle from a verification that never ran.
 */
function recoverDeadZonedIssue(
  repoConfig: RepoConfig,
  config: AgentConfig,
  issueNumber: number,
  prNumber: number,
  logger: Logger,
): "pass" | "fail" | "indeterminate" {
  if (!config.emRepoPath) {
    logger.debug("Dead-zone recovery skipped — emRepoPath not configured");
    return "indeterminate";
  }

  logger.info(
    `Dead-zone recovery: re-running post-merge verification for #${issueNumber} (PR #${prNumber})`,
  );

  const run = spawnSync(
    "npm",
    [
      "run", "verify", "--",
      "--repo", repoConfig.name,
      "--pr", String(prNumber),
      "--issue", String(issueNumber),
      "--env", "development",
    ],
    {
      cwd: config.emRepoPath,
      encoding: "utf-8",
      timeout: RECOVERY_VERIFY_TIMEOUT_MS,
      env: process.env,
    },
  );

  if (run.error || run.signal) {
    logger.warn(
      `Dead-zone recovery INDETERMINATE for #${issueNumber} — verifier did not complete (${run.signal ? `signal ${run.signal}` : run.error?.message}); leaving the issue as-is`,
    );
    return "indeterminate";
  }

  // The verifier's contract: 0 = all checks pass, 1 = a check failed,
  // 2 = crash or invalid arguments (including a repo it has no service mapping
  // for). Only 0 and 1 are verdicts; 2 is an absence of one.
  if (run.status === 0) return "pass";
  if (run.status === 1) return "fail";

  logger.warn(
    `Dead-zone recovery INDETERMINATE for #${issueNumber} — verifier exited ${run.status} (no verdict; repo may have no service mapping): ${(run.stderr || "").split("\n")[0]}`,
  );
  return "indeterminate";
}

/**
 * The label a review run's own trailer implies for the issues its PR closed, or
 * null when the trailer does not warrant a write.
 *
 * Null is the important half. The reconciler exists to repair a MISSING write,
 * never to invent one, so anything the trailer does not say plainly is left for a
 * human — an unmerged PR (the issue is legitimately still under review), or a
 * self-contradictory report like `verdict=REQUEST_CHANGES merged=yes`.
 *
 * `deploy=NA` is a PASS, not an absence: it is what a repo with nothing to deploy
 * (docs, CLI, npm package) is instructed to emit.
 */
export function labelFromTrailer(t: ReviewTrailer): "pr approved" | "pr pending actions" | null {
  if (!t.merged) return null;
  if (t.verdict !== "APPROVE") return null;
  if (/^(FAIL|FAILURE|FAILED)$/.test(t.deploy)) return "pr pending actions";
  if (/^(SUCCESS|OK|PASS|PASSED|NA|N\/A|NONE)$/.test(t.deploy)) return "pr approved";
  return null;
}

/**
 * Set the outcome label the review run reported, for issues it merged but left at
 * `pr under review`.
 *
 * This is the fix for the pipeline's oldest silent failure: the merge was done by
 * code while the RECORD of it was left to an agent to remember to write, so ~23%
 * of merges (12 of 53 over 2026-07-29 → 08-04) stranded their issue in a state no
 * phase reads. The outcome was never actually unknown — it arrived in a
 * machine-readable trailer the Foreman already parsed and logged. This spends it.
 *
 * Four independent conditions gate every write, so the reconciler cannot invent
 * state or overrule anyone:
 *   1. the issue is STILL at `pr under review` with no outcome label — a run that
 *      labeled correctly never reaches this code, so healthy behavior is unchanged;
 *   2. a merged PR provably closed that issue, via the same STRICT predicate the
 *      promotion path uses (`findIssuesMergedToBase` — a bare "related to #N"
 *      never counts);
 *   3. that PR has a trailer from THIS run whose fields are unambiguous;
 *   4. the reviewer did not declare a deliberate hold.
 *
 * It never applies `ready for prod release`: that label authorizes production and
 * stays the EM outcome-gate's signature (separation of duties, 2026-07-27).
 *
 * Returns the issues still stuck after reconciliation — the genuine dead zone.
 */
function reconcileReviewOutcomeLabels(
  repoConfig: RepoConfig,
  stuck: number[],
  trailers: ReviewTrailer[],
  logger: Logger,
  events?: CycleEvent[],
): number[] {
  const merged = findIssuesMergedToBase(repoConfig, stuck, logger);
  const byIssue = new Map(merged.map((m) => [m.issueNumber, m]));
  const unresolved: number[] = [];
  let held: { issue: number; reason: string; pr: number }[] = [];

  for (const issueNumber of stuck) {
    const ref = byIssue.get(issueNumber);
    if (!ref) {
      // Could not tie this issue to a merged PR. That is EITHER "its PR is still
      // open, so `pr under review` is correct" OR "the lookup failed" —
      // findIssuesMergedToBase returns [] for both. Report it rather than pick:
      // treating a failed lookup as "nothing to fix" is the same silent-skip that
      // let this whole class of bug run for months. Unresolved keeps the existing
      // dead-zone warning, which is exactly what fired here before this function
      // existed, so this is never noisier than the behavior it replaced.
      unresolved.push(issueNumber);
      continue;
    }
    const trailer = trailers.find((t) => t.pr === ref.prNumber);
    if (!trailer) {
      unresolved.push(issueNumber);
      continue;
    }
    if (trailer.hold) {
      held.push({ issue: issueNumber, reason: trailer.hold, pr: ref.prNumber });
      continue;
    }
    const label = labelFromTrailer(trailer);
    if (!label) {
      logger.warn(
        `Not reconciling #${issueNumber}: PR #${ref.prNumber}'s trailer is ambiguous (verdict=${trailer.verdict} merged=${trailer.merged} deploy=${trailer.deploy}) — leaving it for a human`,
      );
      unresolved.push(issueNumber);
      continue;
    }
    if (transitionReviewOutcomeLabel(repoConfig, issueNumber, label, logger)) {
      events?.push({
        message: `${repoConfig.githubRepo} #${issueNumber} — review merged PR #${ref.prNumber} without labeling; reconciled to "${label}" from its own trailer`,
        level: label === "pr approved" ? "info" : "warn",
      });
    } else {
      unresolved.push(issueNumber);
    }
  }

  // Persist declared holds so neither this reconciler nor the dead-zone recovery
  // overwrites a deliberate decision on a later cycle or after a restart. The
  // in-memory skip sets would not survive either.
  if (held.length > 0) {
    const state = loadRepoState(repoConfig.name);
    if (!state.held) state.held = {};
    const at = new Date().toISOString();
    for (const h of held) {
      state.held[h.issue] = { heldAt: at, prNumber: h.pr, reason: h.reason };
      logger.info(
        `#${h.issue} held by the reviewer (PR #${h.pr}): ${h.reason} — leaving "pr under review" in place, not re-verifying`,
      );
      events?.push({
        message: `⏸️ ${repoConfig.githubRepo} #${h.issue} held by review: ${h.reason} (PR #${h.pr} merged; label intentionally withheld)`,
        level: "info",
      });
    }
    saveRepoState(repoConfig.name, state);
  }

  return unresolved;
}

export interface OrchestratorState {
  implementing: string | null;
  /** Every repo with an agent run in flight. `implementing` is the first of
   *  these, kept for callers that predate concurrency. */
  implementingRepos: string[];
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
  const implementingRepos = [...activeRuns.keys()];
  return { implementing: implementingRepos[0] ?? null, implementingRepos, repos };
}

/** Back-compat: a single controller for callers written before concurrency.
 *  Prefer `getActiveRunCount()` + `abortAllRuns()` — with several repos in
 *  flight this returns an arbitrary one, and aborting it drains nothing else. */
export function getAbortController(): AbortController | null {
  for (const ac of activeRuns.values()) return ac;
  return null;
}

/** How many agent runs are in flight right now, across all repos. */
export function getActiveRunCount(): number {
  return activeRuns.size;
}

/** Repos currently running an agent, for shutdown logging. */
export function getActiveRunRepos(): string[] {
  return [...activeRuns.keys()];
}

/** Abort every in-flight run. Only for a shutdown whose drain window elapsed —
 *  this destroys work in progress. */
export function abortAllRuns(): void {
  for (const ac of activeRuns.values()) ac.abort();
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

/** Per-repo cycle counter. The fleet-wide `cycle=N` alone became unreadable the
 *  moment repos ran concurrently — twenty repos interleaving under one number
 *  gives no way to follow a single service's progress, and an unreadable log is
 *  how a stalled queue hides. Every line now carries both: `cycle` (fleet) and
 *  `repoCycle` (this service's own pass count). */
const repoCycleCounter = new Map<string, number>();

export interface RepoCycleResult {
  processed: number;
  lastImplementation: ImplementationResult | null;
  events: CycleEvent[];
}

/**
 * Fleet-wide slot limiter. Each repo drives its OWN loop (see startDaemon), so
 * nothing else bounds how many agent sessions exist at once — twenty repos
 * waking together would be twenty concurrent Claude sessions and twenty streams
 * of GitHub calls. Slots are held for the whole of a repo's pass and released
 * even when the pass throws, so one crashing repo cannot leak the fleet's
 * capacity away one slot at a time.
 */
let slotLimit = 3;
let slotsInUse = 0;
const slotWaiters: Array<() => void> = [];

export function setConcurrencyLimit(limit: number): void {
  slotLimit = Math.max(1, limit);
  // A raised limit must wake anyone already queued, or a config reload that
  // increases capacity would have no effect until the next natural release.
  while (slotsInUse < slotLimit && slotWaiters.length > 0) {
    const wake = slotWaiters.shift();
    if (wake) {
      slotsInUse++;
      wake();
    }
  }
}

async function acquireSlot(): Promise<void> {
  if (slotsInUse < slotLimit) {
    slotsInUse++;
    return;
  }
  await new Promise<void>((resolve) => slotWaiters.push(resolve));
}

function releaseSlot(): void {
  const wake = slotWaiters.shift();
  if (wake) {
    wake(); // hand the slot straight to the next waiter; count stays put
    return;
  }
  slotsInUse = Math.max(0, slotsInUse - 1);
}

/** Repos waiting for a slot right now — surfaced so a queue that stops moving
 *  is visible rather than looking like an idle fleet. */
export function getQueuedRepoCount(): number {
  return slotWaiters.length;
}

/**
 * Run one pass for one repo, holding a fleet concurrency slot for its duration.
 * This is what a per-repo loop calls.
 */
export async function runRepoPass(
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
): Promise<RepoCycleResult> {
  await acquireSlot();
  try {
    return await runRepoCycle(repoConfig, config, logger, 0);
  } finally {
    releaseSlot();
  }
}

/**
 * One full pass over ONE repo: reconcile -> review -> revise -> implement ->
 * sync -> promote.
 *
 * Phase order within a repo is load-bearing and unchanged. Review runs before
 * implement so it only acts on PRs labeled in a PRIOR pass (a PR created by
 * this pass waits for the next one, avoiding a same-cycle GitHub-consistency
 * race). Promote runs last so it sees labels this pass just set.
 *
 * What changed is that this is now the unit of concurrency. Repos no longer
 * queue behind each other: a 30-minute build on one service used to block the
 * other nineteen, because the old shape was six sequential loops over all
 * repos and every phase awaited each one in turn.
 */
async function runRepoCycle(
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number,
): Promise<RepoCycleResult> {
  const events: CycleEvent[] = [];
  let processed = 0;
  let lastImplementation: ImplementationResult | null = null;

  const repoCycle = (repoCycleCounter.get(repoConfig.name) ?? 0) + 1;
  repoCycleCounter.set(repoConfig.name, repoCycle);
  // The phase helpers use the cycle number for per-repo failure cooldowns
  // ("retry after N idle cycles"), so they must count THIS repo's passes. With
  // independent per-repo loops a fleet-wide counter no longer maps to a repo's
  // own turns, and a cooldown measured in someone else's cycles is arbitrary.
  cycleNumber = repoCycle;
  const base = logger.child({ cycle: cycleNumber, repoCycle, repo: repoConfig.name });

  // --- Phase 0: Reconcile orphaned commits (features ahead of develop with no PR) ---
  const reconLogger = base.child({ phase: "reconcile" });
  try {
    const result = reconcileRepo(repoConfig, reconLogger);
    if (result.reconciled) {
      reconLogger.info(
        `Reconciled ${result.commitCount} orphaned commit(s) — PR created: ${result.prUrl}`,
        { issues: result.issueNumbers },
      );
      events.push({ message: `Reconciled ${repoConfig.githubRepo} — ${result.commitCount} orphaned commit(s), PR: ${result.prUrl}`, level: "info" });
      processed++;
    }
  } catch (err) {
    reconLogger.error("Reconciliation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Surface dead-zoned issues: PR merged to develop but the issue is still
  // `pr under review` (post-merge verify failed and no phase recovers it).
  // Detection only — the EM re-verifies and advances/flags by hand.
  //
  // ALERT ONCE per (repo, issue). The dead-zone is a STANDING condition, not an
  // event: it persists every cycle until the EM clears it, so re-emitting each
  // reconcile pass floods Discord with the identical line (~every 2 min) and
  // trains the reader to ignore the channel — the alarm defeats itself.
  // Observed 2026-07-19 on Slashbin-console#661 (Ray: "i keep seeing this
  // messages"). The warning fires on transition INTO the dead-zone; the entry
  // clears when the issue leaves it, so a genuine re-entry alerts again.
  try {
    const stuck = findStuckMergedIssues(repoConfig, reconLogger);
    const seen = deadZoneAlerted.get(repoConfig.name) ?? new Set<number>();
    const tried = deadZoneRecoveryAttempted.get(repoConfig.name) ?? new Set<number>();
    const current = new Set(stuck.map((s) => s.issueNumber));

    // Issues whose reviewer DECLARED a hold are not dead — they are waiting on
    // purpose. Auto-recovery would re-verify and label them anyway, replacing a
    // human-grade judgment ("this criterion is not observable until 03:00Z") with
    // an automated verdict. Surface them, never overwrite them.
    const repoState = loadRepoState(repoConfig.name);
    const heldIssues = repoState.held ?? {};

    for (const s of stuck) {
      const hold = heldIssues[s.issueNumber];
      if (hold) {
        if (!seen.has(s.issueNumber)) {
          seen.add(s.issueNumber);
          reconLogger.info(
            `Issue #${s.issueNumber} is HELD by its review (PR #${s.prNumber}, since ${hold.heldAt}): ${hold.reason} — not auto-recovering`,
          );
          events.push({
            message: `⏸️ ${repoConfig.githubRepo} #${s.issueNumber} held by review since ${hold.heldAt.slice(0, 16)}: ${hold.reason}. EM: resolve when the criterion can be checked.`,
            level: "info",
          });
        }
        continue;
      }
      // --- Recovery first, alert only if it could not be repaired ----------
      // Attempt once per (repo, issue). A second attempt only repeats whatever
      // made the first indeterminate, at the cost of another deploy poll.
      if (!tried.has(s.issueNumber)) {
        tried.add(s.issueNumber);
        const verdict = recoverDeadZonedIssue(
          repoConfig,
          config,
          s.issueNumber,
          s.prNumber,
          reconLogger,
        );
        if (verdict !== "indeterminate" && resolveDeadZone(repoConfig, s.issueNumber, verdict, reconLogger)) {
          const label = verdict === "pass" ? "pr approved" : "pr pending actions";
          events.push({
            message: `${repoConfig.githubRepo} #${s.issueNumber} dead-zone auto-recovered: re-verification ${verdict.toUpperCase()} → labeled "${label}" (PR #${s.prNumber} was merged with the issue left at "pr under review")`,
            level: verdict === "pass" ? "info" : "warn",
          });
          seen.delete(s.issueNumber);
          current.delete(s.issueNumber);
          processed++;
          continue; // repaired — no dead-zone alert needed
        }
      }

      if (seen.has(s.issueNumber)) continue; // already alerted; still stuck
      seen.add(s.issueNumber);
      reconLogger.warn(
        `Dead-zoned issue #${s.issueNumber}: PR #${s.prNumber} merged to ${repoConfig.baseBranch} but issue still "pr under review" — post-merge verify never advanced it, and re-verification produced no verdict`,
        { prUrl: s.prUrl, mergedAt: s.mergedAt },
      );
      events.push({
        message: `⚠️ ${repoConfig.githubRepo} #${s.issueNumber} dead-zoned: PR #${s.prNumber} merged but issue still "pr under review", and auto re-verification could not produce a verdict. EM: verify by hand (npm run verify -- --repo ${repoConfig.name} --pr ${s.prNumber} --env development), then advance to "ready for prod release" or flag "pr pending actions".`,
        level: "warn",
      });
    }
    // Drop cleared issues so a real re-entry alerts again — and so a repaired
    // issue that genuinely re-enters the dead zone later can be retried.
    for (const n of [...seen]) if (!current.has(n)) seen.delete(n);
    for (const n of [...tried]) if (!current.has(n)) tried.delete(n);
    deadZoneAlerted.set(repoConfig.name, seen);
    deadZoneRecoveryAttempted.set(repoConfig.name, tried);

    // A hold ends when the issue leaves the dead zone (someone set the label or
    // closed it). Prune, or the record outlives the condition and would suppress
    // recovery on a genuine re-entry months later.
    const stale = Object.keys(heldIssues).map(Number).filter((n) => !current.has(n));
    if (stale.length > 0) {
      const fresh = loadRepoState(repoConfig.name);
      if (fresh.held) {
        for (const n of stale) delete fresh.held[n];
        saveRepoState(repoConfig.name, fresh);
        reconLogger.debug(`Cleared ${stale.length} resolved hold(s): #${stale.join(", #")}`);
      }
    }
  } catch (err) {
    reconLogger.debug(
      `Dead-zone detection failed for ${repoConfig.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // --- Phase 1: Review open feature PRs (invokes the EM /review-all-prs skill) ---
  if (await tryReview(repoConfig, config, base, cycleNumber, events)) processed++;

  // --- Phase 2: Revise PRs with pending review feedback ---
  const revisionInfo = await tryRevision(repoConfig, base, cycleNumber);
  if (revisionInfo) {
    events.push({ message: `Revised ${repoConfig.githubRepo} PR #${revisionInfo.pr.number} (issues: ${revisionInfo.issueNumbers.map(n => `#${n}`).join(", ")})`, level: "info" });
    processed++;
  }

  // --- Phase 3: Implement approved issues (one batch per repo) ---
  const implResult = await tryBatchImplementation(repoConfig, config, base, cycleNumber, events);
  if (implResult) {
    processed++;
    lastImplementation = implResult;
  }

  // --- Phase 4: Reconcile branch drift (main → develop) for any repo with
  //    post-promotion merge commits. Runs independently of promotion work so
  //    drift is cleared even when no ready-for-prod issues exist. ---
  if (!(repoConfig.baseBranch === "main" && repoConfig.featureBranch === "main")) {
    if (trySyncDrift(repoConfig, base, cycleNumber)) {
      events.push({ message: `Branch sync on ${repoConfig.githubRepo} (main → develop) — merged`, level: "info" });
      processed++;
    }
  }

  // --- Phase 5: Create promotion PRs for repos with ready-for-prod issues ---
  const promotionResult = tryPromotion(repoConfig, base, cycleNumber);
  if (promotionResult === "promoted") {
    events.push({ message: `Promotion PR created on ${repoConfig.githubRepo} (develop → main)`, level: "info" });
    processed++;
  } else if (promotionResult === "synced") {
    events.push({ message: `Branch sync on ${repoConfig.githubRepo} (main → develop) — merged, promotion will follow`, level: "info" });
    processed++;
  }

  return { processed, lastImplementation, events };
}

/**
 * One fleet pass: every repo runs its own pipeline, several at a time.
 *
 * The cap is about SPEND, not safety. Concurrent repos are safe on their own —
 * each has its own git working clone, so two of them can never touch the same
 * checkout, and a repo's phases stay sequential within `runRepoCycle`. What a
 * high cap actually buys you is N simultaneous Claude sessions (each up to 100
 * turns) and N times the GitHub API traffic, on an API that already returns
 * intermittent TLS timeouts at one.
 *
 * Set `maxConcurrentRepos` in .ai-agent.json or AI_AGENT_MAX_CONCURRENT_REPOS.
 */
export async function runCycle(
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number
): Promise<CycleResult> {
  const cycleLogger = logger.child({ cycle: cycleNumber, phase: "poll" });

  let totalProcessed = 0;
  let lastResult: ImplementationResult | null = null;
  const events: CycleEvent[] = [];

  const limit = Math.max(1, Math.min(config.maxConcurrentRepos, config.repos.length));
  const queue = [...config.repos];

  if (limit > 1) {
    cycleLogger.debug(`Running ${config.repos.length} repo(s), up to ${limit} concurrently`);
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      const repoConfig = queue.shift();
      if (!repoConfig) return;
      try {
        const result = await runRepoCycle(repoConfig, config, logger, cycleNumber);
        totalProcessed += result.processed;
        events.push(...result.events);
        if (result.lastImplementation) lastResult = result.lastImplementation;
      } catch (err) {
        // One repo's pipeline must never take the fleet pass down with it —
        // that would be the serial failure mode reintroduced through the back
        // door, with every other repo starved by an unrelated crash.
        logger.child({ cycle: cycleNumber, repo: repoConfig.name }).error("Repo cycle failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));

  if (totalProcessed === 0) {
    cycleLogger.info("No work across all repos");
  } else {
    cycleLogger.info(`Cycle complete — processed ${totalProcessed} item(s)`);
  }

  return { didWork: totalProcessed > 0, lastImplementation: lastResult, events };
}

/**
 * Classify a recorded skip reason as transient + currently-resolved. Returns
 * true only when (a) the reason matches a known transient pattern AND (b) the
 * underlying precondition can be re-checked from this host AND (c) the check
 * confirms the precondition no longer holds. Returning false is safe — the
 * back-off continues normally.
 *
 * Known transient patterns:
 * - "diverged from origin/<branch>" — local working clone ahead/behind origin;
 *   resolved when both are 0. The skill emits this when `git pull origin
 *   features` fails on a divergent branch state, typically caused by an EM
 *   session leaving polluted refs in the shared clone (see
 *   feedback_em_clone_stay_on_main). An EM manual reconcile
 *   (`git branch -f features origin/features`) clears the cause but cannot
 *   reach into the daemon's skip cache; this recheck lets the orchestrator
 *   notice the cause is gone and admit on the next cycle instead of waiting
 *   out the full 30-min back-off.
 *
 * Add new transient patterns here as they are identified. Durable reasons
 * (issue-body says "investigation only", "no immediate code change") MUST
 * stay caught by the default `return false` — those don't go away on retry.
 */
function isResolvedTransientSkip(
  reason: string,
  repoPath: string,
  logger: Logger,
): boolean {
  const divergenceMatch = reason.match(/diverged from origin\/(\S+?)\b/i);
  if (divergenceMatch) {
    const branch = divergenceMatch[1];
    const div = checkLocalBranchDivergence(repoPath, branch, logger);
    return div !== null && div.ahead === 0 && div.behind === 0;
  }
  return false;
}

/** Hard ceiling on the escalating skip back-off — 24h. Beyond this the retry rate
 *  is already negligible, and we still want an eventual re-check in case the
 *  world changed (issue body edited, dependency landed). */
const SKIP_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Escalating back-off window for the Nth consecutive skip of one issue:
 * base * 2^(N-1), capped (30m → 1h → 2h → 4h → … → 24h at the default base).
 *
 * A FIXED snooze is not a back-off: it never gives up, so an issue that can never
 * become actionable costs one full Claude session every window, forever
 * (slashbin-ai-foreman#32). Escalating bounds the cost of ANY repeating skip —
 * investigation-only issues, blocked-on-external, and merged-work alike.
 *
 * skipCount is optional in persisted state (pre-#32 files) — absent reads as the
 * first skip, i.e. exactly the original single-window behavior.
 */
function backoffWindowFor(skipCount: number | undefined, baseMs: number): number {
  const n = Math.max(1, skipCount ?? 1);
  const exp = Math.min(n - 1, 10); // 2^10 * 30m ≫ cap; guards against overflow
  return Math.min(baseMs * 2 ** exp, SKIP_BACKOFF_MAX_MS);
}

async function tryBatchImplementation(
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number,
  events?: CycleEvent[]
): Promise<ImplementationResult | null> {
  const repoName = repoConfig.name;
  const skipBackoffMs = config.skipBackoffMs;
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

  // Self-heal the `implemented` cache (slashbin-ai-foreman #16/#18/#540 family).
  //
  // Invariant: `implemented[N]` must mean "a PR that delivers N exists".
  // `findActionableIssues` already authoritatively returns only approved
  // issues with NO linked PR (open or merged) — it is the same check the
  // orchestrator trusts to decide what to implement. So any N that is BOTH
  // still in `actionableIssues` (no delivering PR per the live check) AND in
  // `repoState.implemented` is a stale, dead-zoned entry: a prior run recorded
  // it without producing a delivering PR (PR creation failed, or its commit
  // rode a foreign PR on the shared `features` branch). Left alone it is
  // skipped forever with no recovery. The live no-linked-PR signal wins over
  // the stale cache: prune so the issue is re-implemented this cycle.
  //
  // This cannot reintroduce the re-implement loop the cache guards against:
  // that loop is "PR exists but the linkage check missed it" — here the same
  // linkage check (findActionableIssues) reports NO PR, so there is nothing to
  // loop on; true loops remain bounded by failureCount/cooldown + skip back-off.
  // Additive only — no state shape / .ai-agent.json / branch-model change.
  const staleImplemented = repoState.implemented.filter((n) => actionableIssues.includes(n));
  if (staleImplemented.length > 0) {
    repoLogger.warn(
      `Self-heal: pruning ${staleImplemented.length} stale 'implemented' entr${staleImplemented.length === 1 ? "y" : "ies"} with no delivering PR — re-implementable: ${staleImplemented.map((n) => `#${n}`).join(", ")}`,
    );
    const healed = loadRepoState(repoName);
    healed.implemented = healed.implemented.filter((n) => !staleImplemented.includes(n));
    saveRepoState(repoName, healed);
    repoState.implemented = healed.implemented;
  }

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
  //
  // Reason-aware recheck: some skip reasons describe a TRANSIENT precondition
  // (e.g., "local features branch diverged from origin/features") that an EM
  // session can manually resolve mid-back-off. Before honoring the back-off,
  // re-run the precondition check; if it now passes, admit the issue and clear
  // the stale skip entry. This prevents the cache from pinning a dead-zone
  // 30 minutes past an already-applied manual reconcile.
  const skippedMap = repoState.skipped ?? {};
  const now = Date.now();
  const stillBackedOff: { n: number; reason: string }[] = [];
  const resolvedTransient: { n: number; reason: string }[] = [];
  actionableIssues = actionableIssues.filter((n) => {
    const entry = skippedMap[n];
    if (!entry) return true;
    const age = now - new Date(entry.lastSkippedAt).getTime();
    if (Number.isNaN(age) || age >= backoffWindowFor(entry.skipCount, skipBackoffMs)) return true;
    if (isResolvedTransientSkip(entry.reason, repoConfig.repoPath, repoLogger)) {
      resolvedTransient.push({ n, reason: entry.reason });
      return true;
    }
    stillBackedOff.push({ n, reason: entry.reason });
    return false;
  });
  if (resolvedTransient.length > 0) {
    repoLogger.info(
      `Cleared ${resolvedTransient.length} resolved-transient skip entr${resolvedTransient.length === 1 ? "y" : "ies"}: ${resolvedTransient.map(({ n }) => `#${n}`).join(", ")}`,
    );
    const healed = loadRepoState(repoName);
    healed.skipped = healed.skipped ?? {};
    for (const { n } of resolvedTransient) delete healed.skipped[n];
    saveRepoState(repoName, healed);
    repoState.skipped = healed.skipped;
  }
  if (stillBackedOff.length > 0) {
    // Promoted DEBUG → INFO so silent skip-cache filtering is visible in the
    // journal (otherwise the pipeline appears stalled while the cache holds it).
    repoLogger.info(
      `Backing off ${stillBackedOff.length} previously-skipped issue(s): ${stillBackedOff.map(({ n, reason }) => `#${n} (${reason.split("\n")[0].slice(0, 100)})`).join("; ")}`,
    );
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
  const runAbort = new AbortController();
  activeRuns.set(repoName, runAbort);
  repoLogger.info(`Triggering batch implementation for ${repoName}`);

  try {
    const priorFailure = lastFailureReason.get(repoName) || null;
    const result = await implementApprovedIssues(repoConfig, repoLogger, runAbort.signal, priorFailure, actionableIssues);

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
      let skippedSet = result.skippedIssues && result.skippedIssues.length > 0
        ? result.skippedIssues
        : actionableIssues;
      const reason = result.skipReason ?? "no reason given";

      // --- Case 4 (slashbin-ai-foreman#32): the work is ALREADY MERGED ---------
      // A skip is only worth retrying if a retry could ever succeed. When the
      // agent declines because the work is already on `baseBranch`, retrying is
      // futile BY DEFINITION — the commits exist; no future cycle will produce a
      // PR for them. Yet the issue keeps `approved` with no lifecycle label, so
      // it stays "actionable" and we burn a full Claude session every back-off
      // window, forever (observed: 7+ hours across two repos, 2026-07-13).
      //
      // Give the lifecycle its missing EXIT: strip the trigger label and advance
      // to `ready for prod release`, permanently removing the issue from the
      // actionable set and handing the EM the signal it already expects. Forward
      // progress then no longer depends on a human closing the issue promptly.
      //
      // Safe because findIssuesMergedToBase() uses the STRICT predicate: only a
      // merged PR that says it CLOSED the issue counts (never a "related to #N").
      // On any lookup failure it advances nothing — we under-advance by design.
      const alreadyMerged = findIssuesMergedToBase(repoConfig, skippedSet, repoLogger);
      if (alreadyMerged.length > 0) {
        const mergedNums = alreadyMerged.map((m) => m.issueNumber);
        transitionToReadyForProd(repoConfig, mergedNums, repoLogger);
        repoLogger.info(
          `Advanced ${mergedNums.length} already-merged issue(s) to 'ready for prod release': ${alreadyMerged.map((m) => `#${m.issueNumber} (merged in PR #${m.prNumber})`).join(", ")}`,
        );
        events?.push({
          message: `Advanced ${mergedNums.length} already-merged issue(s) on ${repoConfig.githubRepo} to 'ready for prod release': ${mergedNums.map((n) => `#${n}`).join(", ")}`,
          level: "info",
        });
        // They're out of the actionable set now — no skip record needed, and a
        // stale one would linger in state forever.
        for (const n of mergedNums) delete updatedState.skipped[n];
        skippedSet = skippedSet.filter((n) => !mergedNums.includes(n));
      }
      // ------------------------------------------------------------------------

      const stamp = new Date().toISOString();
      for (const issueNum of skippedSet) {
        // Escalating per-issue back-off: a fixed snooze never gives up, so a
        // permanently-unactionable issue costs an agent session every window,
        // indefinitely. Count the consecutive skips; the filter at the top of
        // this function widens the window geometrically off this count.
        const priorCount = updatedState.skipped[issueNum]?.skipCount ?? 0;
        updatedState.skipped[issueNum] = {
          lastSkippedAt: stamp,
          reason,
          skipCount: priorCount + 1,
        };
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
    activeRuns.delete(repoName);
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
  const runAbort = new AbortController();
  activeRuns.set(repoName, runAbort);
  revLogger.info(`Triggering PR revision for ${repoName} — PR #${pending.pr.number}, issues: ${pending.issueNumbers.map(n => `#${n}`).join(", ")}`);

  try {
    const result = await revisePRFeedback(
      repoConfig, revLogger, runAbort.signal,
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
    activeRuns.delete(repoName);
  }
}

/**
 * Review phase: invoke the EM /review-all-prs skill, scoped to one repo, when it
 * has an open feature PR awaiting review (`pr under review`, no current EM review).
 *
 * Unlike implement/revise, the orchestrator does NOT transition labels afterward —
 * the skill owns its own merges and label transitions at full fidelity. We just
 * gate, trigger, log, and back off on failure. Every run's full interaction is
 * written to logs/review/<repo>-cycle<N>-<ts>.log for debugging.
 *
 * Returns true when a review run was triggered (regardless of verdict).
 */
async function tryReview(
  repoConfig: RepoConfig,
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number,
  events?: CycleEvent[],
): Promise<boolean> {
  if (!repoConfig.reviewEnabled) return false;

  const repoName = repoConfig.name;
  const reviewLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "review" });

  // Failure back-off with cooldown (mirrors the implement phase).
  const failures = reviewFailureCount.get(repoName) ?? 0;
  if (failures >= MAX_RETRIES) {
    const hitAt = reviewFailureHitMaxAt.get(repoName) ?? cycleNumber;
    const cyclesSinceMax = cycleNumber - hitAt;
    if (cyclesSinceMax < FAILURE_COOLDOWN_CYCLES) {
      reviewLogger.debug(`Skipping ${repoName} review — ${failures} consecutive failures, cooldown ${cyclesSinceMax}/${FAILURE_COOLDOWN_CYCLES}`);
      return false;
    }
    reviewLogger.info(`Review failure cooldown expired for ${repoName} — resetting and retrying`);
    reviewFailureCount.set(repoName, 0);
    reviewFailureHitMaxAt.delete(repoName);
  }

  // Gate: is there an open feature PR awaiting EM review?
  const candidate = findPRsNeedingReview(repoConfig, config.reviewerLogin, reviewLogger);
  if (!candidate) {
    if (failures > 0) reviewFailureCount.set(repoName, 0);
    return false;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const transcriptPath = resolve(process.cwd(), "logs", "review", `${repoName}-cycle${cycleNumber}-${ts}.log`);

  // Snapshot the EM outcome-gate BEFORE the run. `findPRsNeedingReview` already
  // excludes advanced issues, but it decided that minutes ago; a gate signed
  // while this run is in flight is invisible to it and gets overwritten by the
  // run's own label write. Restored in `finally`, so a crash cannot strand it.
  const gatedBeforeReview = snapshotEmGate(
    repoConfig.githubRepo, repoConfig.repoPath, candidate.issueNumbers, reviewLogger,
  );

  const runAbort = new AbortController();
  activeRuns.set(repoName, runAbort);
  reviewLogger.info(`Triggering review for ${repoName} — PR #${candidate.prNumber} (issues: ${candidate.issueNumbers.map(n => `#${n}`).join(", ")}), transcript: ${transcriptPath}`);
  events?.push({ message: `Reviewing ${repoConfig.githubRepo} PR #${candidate.prNumber} (issues: ${candidate.issueNumbers.map(n => `#${n}`).join(", ")})`, level: "info" });

  try {
    const result = await reviewOpenPRs(repoConfig, config, reviewLogger, runAbort.signal, transcriptPath);

    if (result.success) {
      reviewFailureCount.set(repoName, 0);
      reviewFailureHitMaxAt.delete(repoName);
      reviewLogger.info(`Review run completed for ${repoName}`);

      // --- Post-condition check ------------------------------------------
      // The trailer is the agent's CLAIM about what it did. The labels are the
      // STATE. Verify the claim against the state before believing it: a run
      // that says `merged=yes` must have left the issue somewhere other than
      // `pr under review`, because that is where the next phase reads from.
      //
      // Checked only for PRs the run claims to have merged — an unmerged PR is
      // SUPPOSED to still be `pr under review`, so including those would flag
      // every REQUEST_CHANGES round as an orphan.
      //
      // This catches the case the trailer gate cannot: a run that emits a
      // well-formed trailer but never actually moved the labels. Detection
      // only; the repair runs in Phase 0 on the next pass (≈1 cycle later),
      // where it can re-verify first. Alerting here rather than waiting for the
      // dead-zone sweep skips that path's 15-minute grace window, so a broken
      // run surfaces in the same cycle that produced it.
      const trailers = result.trailers ?? [];
      const mergedPrs = trailers.filter((t) => t.merged).map((t) => t.pr);
      if (mergedPrs.length > 0) {
        const stuck = findIssuesStillUnderReview(repoConfig, candidate.issueNumbers, reviewLogger);
        if (stuck.length > 0) {
          reviewLogger.warn(
            `Review post-condition: PR(s) #${mergedPrs.join(", #")} reported merged, but issue(s) #${stuck.join(", #")} are still "pr under review" — the run merged without completing the label transition`,
            { mergedPrs, stuckIssues: stuck },
          );

          // Set the label from the run's own trailer. The verdict is not missing
          // — it is right here, already parsed. Waiting a cycle to re-derive it
          // from a fresh deploy poll was spending minutes to recompute an answer
          // we were holding.
          const unresolved = config.reviewLabelReconcile
            ? reconcileReviewOutcomeLabels(repoConfig, stuck, trailers, reviewLogger, events)
            : stuck;

          if (!config.reviewLabelReconcile && stuck.length > 0) {
            reviewLogger.info("Label reconciliation disabled (reviewLabelReconcile=false) — leaving the dead zone for recovery");
          }

          if (unresolved.length > 0) {
            reviewLogger.error(
              `Review post-condition UNRESOLVED on ${repoName}: issue(s) #${unresolved.join(", #")} could not be reconciled from the run's trailers — dead-zone recovery will re-verify`,
              { mergedPrs, unresolved },
            );
            events?.push({
              message: `⚠️ ${repoConfig.githubRepo} — review merged PR #${mergedPrs.join(", #")} but left issue(s) #${unresolved.join(", #")} at "pr under review" and the trailer could not settle it. Dead-zone recovery will re-verify next cycle.`,
              level: "warn",
            });
          }
        }
      }

      // Prefer the structured per-PR status (includes deploy SUCCESS/FAILURE);
      // fall back to the summary's first line when no trailer was emitted.
      const outcome = result.statusLine
        ? result.statusLine
        : (result.summary || "review completed").split("\n")[0].slice(0, 240);
      const prefix = result.statusLine ? "" : `PR #${candidate.prNumber} — `;
      events?.push({ message: `Reviewed ${repoConfig.githubRepo} — ${prefix}${outcome}`, level: "info" });
      return true;
    }

    const newCount = failures + 1;
    reviewFailureCount.set(repoName, newCount);
    if (newCount >= MAX_RETRIES) reviewFailureHitMaxAt.set(repoName, cycleNumber);
    reviewLogger.warn(`Review failed (${newCount}/${MAX_RETRIES}): ${result.error}`);
    events?.push({ message: `Review failed on ${repoConfig.githubRepo} PR #${candidate.prNumber}: ${result.error}`, level: "error" });
    return false;
  } finally {
    activeRuns.delete(repoName);

    // Undo any revocation of the EM outcome-gate. In `finally` on purpose: a run
    // that threw or was aborted may still have written labels before it died.
    const restored = restoreEmGate(repoConfig, gatedBeforeReview, reviewLogger);
    if (restored.length > 0) {
      events?.push({
        message: `⚠️ ${repoConfig.githubRepo} — the review run removed "${EM_GATE_LABEL}" from issue(s) ${restored.map((n) => `#${n}`).join(", ")}; restored. Promotion would otherwise have stalled silently.`,
        level: "warn",
      });
    }
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

  // An already-open sync PR is a RETRY, not a no-op. The merge attempted at
  // creation runs while required checks are still IN_PROGRESS and is refused, so
  // "already open" is the normal state a few seconds later — and returning early
  // here meant it was never merged at all. `develop` then stays behind `main`,
  // the next promotion PR goes BEHIND, and branch protection refuses it.
  // (Slashbin-console#779: open 2h48m over ~140 no-op cycles, blocking #782.)
  const existing = findOpenSyncPR(repoConfig.githubRepo, repoConfig.repoPath, syncLogger);
  if (existing) {
    if (tryMergeSyncPR(repoConfig.githubRepo, existing.number, repoConfig.repoPath, syncLogger)) {
      syncLogger.info(`Sync PR merged on retry — #${existing.number}: ${existing.url}`);
      return true;
    }
    syncLogger.info(`Sync PR open, not yet mergeable — #${existing.number}: ${existing.url}`);
    return false;
  }

  syncLogger.info(`develop is ${drift.developBehindMain} commit(s) behind main — creating sync PR`);
  const syncUrl = createSyncPR(repoConfig.githubRepo, drift.developBehindMain, repoConfig.repoPath, syncLogger);
  if (syncUrl) {
    // Say what actually happened. This line used to assert "created and
    // auto-merged" unconditionally, which was false whenever branch protection
    // refused the create-time merge — i.e. on every protected repo.
    syncLogger.info(`Sync PR created — ${syncUrl} (merge retried each cycle until checks pass)`);
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
  if (issues.length === 0) {
    // "Nothing ready to promote" and "the gate was revoked and promotion is
    // stalled" produce the identical empty set and the identical silence. They
    // are distinguishable by one fact: whether `develop` is carrying merged work
    // that never reached `main`. Say so when it is.
    //
    // Rate-limited because it costs a compare API call and the discovery budget
    // is repos x cycles/hour (see docs on the GitHub API budget) — a stall lasts
    // cycles, so hourly is early enough to catch it and cheap enough to keep.
    const last = lastStallCheckCycle.get(repoName) ?? -Infinity;
    if (cycleNumber - last >= STALL_CHECK_CYCLE_INTERVAL) {
      lastStallCheckCycle.set(repoName, cycleNumber);
      const drift = checkBranchDrift(repoConfig.githubRepo, repoConfig.repoPath, promoLogger);
      if (drift && drift.developAheadOfMain > 0) {
        promoLogger.warn(
          `${repoName}: develop is ${drift.developAheadOfMain} commit(s) ahead of main but no issue carries ` +
          `"${EM_GATE_LABEL}" — promotion is STALLED, not idle. Either the EM gate has not been signed yet, ` +
          `or it was signed and revoked.`,
          { developAheadOfMain: drift.developAheadOfMain },
        );
      }
    }
    return null;
  }

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
        promoLogger.error(
          `Failed to update promotion PR #${existingPR.number} — ${missingIssues.length} dev-verified issue(s) are BLOCKED from production and no promotion PR reflects them. This is not cosmetic: the promote phase found the work and could not act on it.`
        );
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
    // TERMINAL EXIT for the promote lifecycle (slashbin-ai-foreman#32, promote variant).
    //
    // develop has ZERO file changes vs main, so every ready-for-prod issue's work
    // is ALREADY in main — it was promoted, and there is nothing left to promote.
    // Retrying is futile by construction; no future cycle can produce a diff.
    //
    // This used to just log "labels will clear on next verify cycle" and return.
    // They never cleared: stripReadyForProdLabel() is only reachable on the
    // promotion-PR-created path below, so an already-promoted issue kept the label
    // forever and this phase re-checked it EVERY cycle, indefinitely. Observed on
    // jerky_security_testing #110/#115/#117/#118/#122 — stuck from 2026-07-01 for
    // two weeks, burning a promote check every poll, while their fixes had shipped
    // to main (and deployed) on day one. The "likely a race" comment was a wrong
    // assumption that made a permanent stuck state read as self-healing.
    //
    // Safe: `ready for prod release` is only applied after the feature PR merges to
    // develop, so develop-content == main-content ⇒ that work IS in main. Strip the
    // label to remove them from the promote set. We do NOT close them — the EM still
    // owns outcome verification; an open issue with no lifecycle label is inert
    // (the Foreman won't re-pick it) and stays visible for that close.
    promoLogger.warn(
      `Already promoted — ${issues.length} issue(s) still labeled 'ready for prod release' but develop has 0 file changes vs main, ` +
      `so their work is already in main: ${issues.map((i) => `#${i.number}`).join(", ")}. ` +
      `Stripping the label (nothing left to promote). They remain open for EM outcome-verification + close.`,
    );
    stripReadyForProdLabel(
      repoConfig.githubRepo,
      issues.map((i) => i.number),
      repoConfig.repoPath,
      promoLogger,
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
