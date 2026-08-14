import { execFileSync } from "node:child_process";
import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";

const GH_MAX_ATTEMPTS = 3;
const GH_BACKOFF_MS = [1000, 3000, 9000];

/** Block the thread for `ms` without busy-waiting. Only hit on the rare retry
 *  path; keeps the gh() wrapper synchronous so no caller signature changes. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/**
 * A gh failure is *transient* (safe to retry) only when it's network/connectivity
 * or a server-side 5xx/timeout — NOT auth, 404, or 422 validation, which won't
 * improve on retry (those fall through to an immediate throw). Allowlist by design.
 * A host↔GitHub blip ("error connecting to api.github.com") was stalling the whole
 * fleet ("No work across all repos"); retrying absorbs it instead of erroring the cycle.
 */
function isTransientGhError(err: unknown): boolean {
  const { message, stderr } = formatGhError(err);
  const blob = `${message}\n${stderr}`.toLowerCase();
  return (
    blob.includes("error connecting to api.github.com") ||
    blob.includes("timed out") || blob.includes("timeout") ||
    blob.includes("etimedout") || blob.includes("econnreset") ||
    blob.includes("enotfound") || blob.includes("eai_again") ||
    blob.includes("dial tcp") ||
    blob.includes("bad gateway") || blob.includes("service unavailable") ||
    blob.includes("http 502") || blob.includes("http 503") || blob.includes("http 504")
  );
}

/**
 * A rate-limit rejection is NOT transient — retrying it inside the same cycle
 * only spends more of an already-exhausted budget. It gets its own classifier
 * for one reason: so it is *nameable* in the log.
 *
 * 2026-07-30: the daemon emitted 22,466 of these in 24 hours (~1,100/hour,
 * unbroken for 21+ hours) and every one surfaced as a generic
 * "Failed to check for approved issues" — the same line a real outage prints.
 * A quota problem that is indistinguishable from a dead Foreman is a
 * diagnosability defect on top of the quota defect, so we label it explicitly.
 */
function isRateLimitGhError(err: unknown): boolean {
  const { message, stderr } = formatGhError(err);
  const blob = `${message}\n${stderr}`.toLowerCase();
  return (
    blob.includes("api rate limit already exceeded") ||
    blob.includes("api rate limit exceeded") ||
    blob.includes("secondary rate limit") ||
    blob.includes("was submitted too quickly")
  );
}

/** execFileSync gh with retry+backoff on transient (network/5xx/timeout) failures. */
function runGh(args: string[], cwd: string, token: string): string {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= GH_MAX_ATTEMPTS; attempt++) {
    try {
      return execFileSync("gh", args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
        env: { ...process.env, GH_TOKEN: token },
      }).trim();
    } catch (err) {
      lastErr = err;
      if (isRateLimitGhError(err)) {
        // Deliberately not retried: the budget is already gone. Name it loudly
        // and once, then let the caller's own error path handle the cycle.
        console.warn(`[gh] RATE LIMIT EXHAUSTED — GitHub API quota is spent, skipping: gh ${args.slice(0, 3).join(" ")}`);
        throw err;
      }
      if (attempt < GH_MAX_ATTEMPTS && isTransientGhError(err)) {
        const wait = GH_BACKOFF_MS[attempt - 1];
        const { message, stderr } = formatGhError(err);
        console.warn(`[gh] transient failure (attempt ${attempt}/${GH_MAX_ATTEMPTS}), retrying in ${wait}ms: ${stderr.split("\n")[0] || message}`);
        sleepSync(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** Run gh CLI using the Foreman token (slashbin-foreman account). */
export function gh(args: string[], cwd: string): string {
  const foremanToken = process.env.FOREMAN_GITHUB_TOKEN;
  if (!foremanToken) throw new Error("FOREMAN_GITHUB_TOKEN not set — cannot operate as Foreman");
  invalidateSnapshotIfMutating(args);
  return runGh(args, cwd, foremanToken);
}

/** Run gh CLI using the EM token (slashbin-engineering-manager account). */
function ghAsEM(args: string[], cwd: string): string {
  const emToken = process.env.EM_GITHUB_TOKEN;
  if (!emToken) throw new Error("EM_GITHUB_TOKEN not set — cannot approve/merge as EM");
  invalidateSnapshotIfMutating(args);
  return runGh(args, cwd, emToken);
}

// ---------------------------------------------------------------------------
// Open-issue snapshot: one `gh issue list` per repo per cycle
// ---------------------------------------------------------------------------

/**
 * The six discovery lookups in this file (`approved` ×2, `pr under review` ×2,
 * `pr pending actions`, `ready for prod release`) each used to issue their own
 * `gh issue list --state open` against the SAME repo. Every `gh issue list`
 * spends a GraphQL request, and GraphQL is capped at 5,000/hour per token.
 *
 * 2026-07-30: 20 repos × ~6 lookups × a 60s poll interval ≈ 7,200 GraphQL
 * calls/hour against that 5,000 ceiling. The Foreman token sat permanently
 * exhausted — 22,466 rejections in 24 hours — so roughly one lookup in six
 * failed outright. A failed lookup silently skips that phase for that repo
 * that cycle: an `approved` issue goes unimplemented, a
 * `ready for prod release` unpromoted, recovering only on a later cycle that
 * happens to win the quota race.
 *
 * The fix is that all six lookups are label subsets of ONE query. We fetch
 * `--state open` once per repo, cache it briefly, and filter in memory:
 * 6 calls → 1 (≈1,200/hour, comfortably inside budget) with the poll interval
 * left where operations wants it at 60s. Fetching every open issue instead of
 * a label-filtered slice costs no extra requests — the request count is driven
 * by pages, not by predicates.
 *
 * Correctness: the snapshot is dropped whenever the Foreman mutates an issue in
 * that repo (see `invalidateSnapshotIfMutating`), so a label written by an
 * earlier phase is never read back stale later in the same cycle. A label
 * changed EXTERNALLY — the EM applying `approved` — is picked up on the next
 * refresh, i.e. at worst one TTL late, which is a delay the poll interval
 * already implies.
 *
 * Additive and OSS-safe: `issueCacheTtlMs: 0` restores the old behaviour of one
 * live query per lookup.
 */
interface IssueSnapshot {
  number: number;
  title: string;
  labels: { name: string }[];
}

const DEFAULT_ISSUE_CACHE_TTL_MS = 30_000;
const DEFAULT_ISSUE_SNAPSHOT_LIMIT = 500;

let issueCacheTtlMs = DEFAULT_ISSUE_CACHE_TTL_MS;
let issueSnapshotLimit = DEFAULT_ISSUE_SNAPSHOT_LIMIT;
const issueSnapshots = new Map<string, { fetchedAt: number; issues: IssueSnapshot[] }>();

/**
 * Apply daemon-level cache settings. Called once at startup; defaults stand if
 * it is never called, so nothing downstream has to know this exists.
 */
export function configureIssueCache(opts: { ttlMs?: number; snapshotLimit?: number }): void {
  if (typeof opts.ttlMs === "number" && Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0) {
    issueCacheTtlMs = opts.ttlMs;
  }
  if (typeof opts.snapshotLimit === "number" && Number.isFinite(opts.snapshotLimit) && opts.snapshotLimit > 0) {
    issueSnapshotLimit = Math.floor(opts.snapshotLimit);
  }
  issueSnapshots.clear();
  prSnapshots.clear();
}

/**
 * Drop a repo's cached snapshot when a command mutates issue state, so a later
 * phase re-reads what this cycle just wrote. Keyed off the `--repo` argument;
 * `list`/`view` are reads and left alone.
 */
function invalidateSnapshotIfMutating(args: string[]): void {
  const repoIdx = args.indexOf("--repo");
  const repo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;

  // `gh api --method POST/PATCH/PUT/DELETE` can label, merge, or retarget
  // anything, and the URL shape varies too much to attribute reliably. Clear
  // everything — conservative, and a cache miss only costs one request.
  const methodIdx = args.indexOf("--method");
  if (args[0] === "api" && methodIdx >= 0 && args[methodIdx + 1] !== "GET") {
    issueSnapshots.clear();
    prSnapshots.clear();
    return;
  }

  if (!repo) return;

  // Read-only subcommands leave state alone; everything else may change it.
  const READ_ONLY = new Set(["list", "view", "diff", "checks", "status"]);
  if (READ_ONLY.has(args[1])) return;

  if (args[0] === "issue") issueSnapshots.delete(repo);
  // A PR merge closes the PR *and* moves the issue labels that track it, so a
  // `pr` mutation has to drop both — otherwise a later phase this cycle reads a
  // merged PR back as open.
  if (args[0] === "pr") {
    prSnapshots.delete(repo);
    issueSnapshots.delete(repo);
  }
}

/**
 * Force the next `getOpenIssues(repo)` to hit the network.
 *
 * `invalidateSnapshotIfMutating` only sees the Foreman's OWN `gh` calls. The
 * review phase runs in a SEPARATE Claude process, so every label it writes is
 * invisible to this cache — read back inside the TTL, an issue the review just
 * advanced still looks like it never moved. Any check that reads labels a
 * foreign process may have just written must drop the snapshot first.
 */
export function dropIssueSnapshot(repo: string): void {
  issueSnapshots.delete(repo);
}

/** Every open issue in the repo, from cache when warm. */
function getOpenIssues(repo: string, cwd: string, logger: Logger): IssueSnapshot[] {
  const cached = issueSnapshots.get(repo);
  if (cached && issueCacheTtlMs > 0 && Date.now() - cached.fetchedAt < issueCacheTtlMs) {
    return cached.issues;
  }

  const json = gh([
    "issue", "list",
    "--repo", repo,
    "--state", "open",
    "--json", "number,title,labels",
    "--limit", String(issueSnapshotLimit),
  ], cwd);
  const issues: IssueSnapshot[] = JSON.parse(json || "[]");

  // No silent caps. Hitting the limit means discovery may be blind to issues it
  // is supposed to see, which would look exactly like "no work to do".
  if (issues.length >= issueSnapshotLimit) {
    logger.warn(
      "Open-issue snapshot hit its limit — discovery may be missing issues; raise issueSnapshotLimit",
      { repo, limit: issueSnapshotLimit, returned: issues.length },
    );
  }

  if (issueCacheTtlMs > 0) issueSnapshots.set(repo, { fetchedAt: Date.now(), issues });
  return issues;
}

/** True when `issue` carries a label named `name`. */
function hasLabel(issue: IssueSnapshot, name: string): boolean {
  return issue.labels.some((l) => l.name === name);
}

/**
 * The same collapse for OPEN pull requests, and for the same reason.
 *
 * Roughly three `gh pr list --state open` calls run per repo per cycle no matter
 * whether there is any work — the reconcile phase's sync-PR check
 * (`develop ← main`), the promote phase's open-promotion-PR check
 * (`main ← develop`), and the review phase's orphan-adoption probe, which runs
 * precisely when there is nothing to review, i.e. most cycles. Each spends a
 * GraphQL request. At 20 repos on a 60s interval that is ~3,600/hour on its own,
 * and it is why collapsing the issue lookups alone left the token at 5,279/hour
 * against a 5,000 ceiling — measured, after that first fix.
 *
 * Every one of those calls is a `--head`/`--base` slice of "open PRs in this
 * repo", so they share one snapshot and filter in memory.
 *
 * Deliberately NOT served from here: `--state merged` queries (a different set)
 * and the one call that needs `files` (a per-PR file list, far heavier than the
 * scalar fields below). Those stay live.
 */
interface PrSnapshot {
  number: number;
  url: string;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
}

const prSnapshots = new Map<string, { fetchedAt: number; prs: PrSnapshot[] }>();

/** Every open PR in the repo, from cache when warm. */
function getOpenPrs(repo: string, cwd: string): PrSnapshot[] {
  const cached = prSnapshots.get(repo);
  if (cached && issueCacheTtlMs > 0 && Date.now() - cached.fetchedAt < issueCacheTtlMs) {
    return cached.prs;
  }

  const json = gh([
    "pr", "list",
    "--repo", repo,
    "--state", "open",
    "--json", "number,url,title,body,headRefName,baseRefName",
    "--limit", "100",
  ], cwd);
  const prs: PrSnapshot[] = JSON.parse(json || "[]");

  if (issueCacheTtlMs > 0) prSnapshots.set(repo, { fetchedAt: Date.now(), prs });
  return prs;
}

/**
 * Open PRs matching a head/base pair, newest first — the shape the old
 * `--head X --base Y --limit N` calls returned.
 */
function findOpenPrs(
  repo: string,
  cwd: string,
  opts: { head?: string; base?: string; limit?: number },
): PrSnapshot[] {
  const matches = getOpenPrs(repo, cwd).filter(
    (p) =>
      (opts.head === undefined || p.headRefName === opts.head) &&
      (opts.base === undefined || p.baseRefName === opts.base),
  );
  return opts.limit === undefined ? matches : matches.slice(0, opts.limit);
}

/**
 * Extract the actionable bits of a thrown gh CLI error so callers can log
 * something useful instead of swallowing the failure. execFileSync attaches
 * `stderr` (Buffer) and `status` (exit code) to the Error it throws.
 */
interface GhFailure {
  message: string;
  stderr: string;
  status: number | null;
}

function formatGhError(err: unknown): GhFailure {
  const e = err as Error & { stderr?: Buffer | string; status?: number | null };
  const stderr =
    typeof e?.stderr === "string"
      ? e.stderr
      : e?.stderr?.toString() ?? "";
  return {
    message: e?.message ?? String(err),
    stderr: stderr.trim(),
    status: e?.status ?? null,
  };
}

/**
 * Return all `approved` open issues in the repo that have not yet
 * progressed through the lifecycle (no `pr under review` / `pr approved` /
 * `pr pending actions` / `ready for prod release` / `ready to close`
 * label, not `blocked`). This is the same filter `findActionableIssues`
 * applies BEFORE the PR-uncovered cross-check + batch cap — i.e. the
 * full set of issues that the implementation skill might pick this cycle.
 *
 * Used by the orchestrator's labeling step to widen the intersection of
 * "issues referenced by the new PR" with "issues that should accept
 * `pr under review`": the canonical skill makes its OWN selection from
 * the entire approved set (priority + smaller-scope-first), which can
 * differ from the Foreman's discovery batch (PR-uncovered subset, capped
 * at MAX_BATCH_SIZE). Without this widening, when the skill picks an
 * approved issue that wasn't in the discovery batch, the resulting PR
 * gets a real merge but no `pr under review` label, leaving the EM with
 * no signal. (slashbin-ai-foreman#18)
 *
 * Returns [] on any gh failure (treat as "nothing to widen to" rather
 * than throwing — the caller already has the discovery batch as a
 * fallback, and a labeling miss is recoverable).
 */
export function findAllApprovedActionableIssues(
  config: RepoConfig,
  logger: Logger,
): number[] {
  const repo = config.githubRepo;
  try {
    const issues = getOpenIssues(repo, config.repoPath, logger)
      .filter((i) => hasLabel(i, config.triggerLabel));

    const lifecycleLabels = [
      "pr under review",
      "pr approved",
      "pr pending actions",
      "ready for prod release",
      "ready to close",
    ];

    const actionable: number[] = [];
    for (const issue of issues) {
      const labels = issue.labels.map((l) => l.name);
      if (labels.includes("blocked")) continue;
      if (lifecycleLabels.some((l) => labels.includes(l))) continue;
      actionable.push(issue.number);
    }
    return actionable;
  } catch (err) {
    logger.warn("findAllApprovedActionableIssues failed; returning [] (labeling will fall back to discovery batch)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Gate check: find approved issues that haven't progressed through
 * the lifecycle AND don't already have a PR. Returns the uncovered
 * issue numbers (capped to MAX_BATCH_SIZE), or empty array if none.
 */
const MAX_BATCH_SIZE = 3;

/**
 * Extract the issue numbers a PR actually IMPLEMENTS (closes/relates), as
 * opposed to merely mentions in prose. An issue counts as implemented when:
 *   - it appears after a closing/relating keyword (Closes/Fixes/Resolves/
 *     Related to/Refs/See #N) anywhere in title, body, or commit messages, OR
 *   - it appears as a `(#N)` suffix in the PR TITLE or a commit HEADLINE
 *     (the canonical `feat: foo (#N)` form).
 *
 * A bare `#N`, or a `(#N)` mention in the free-text BODY (e.g.
 * "tracked separately in #3", "the forthcoming handler (#2)"), does NOT
 * count — those are forward references to sibling issues, not implementations.
 * Counting them orphaned cmneb_public_api #2/#3 (slashbin-ai-foreman#28):
 * a schema PR's body mentioning the not-yet-built endpoint issue marked that
 * issue "implemented"/"covered", so it was never picked up.
 */
export function extractImplementedIssues(opts: {
  title?: string;
  body?: string;
  commitHeadlines?: string[];
  commitBodies?: string[];
  /**
   * STRICT mode — accept only *closing* keywords (`closes`/`fixes`/`resolves`),
   * dropping the weak affinity keywords (`related to`, `refs`, `see`).
   *
   * Default (false) is the historical predicate, correct for the PR-labeling path
   * where the consequence is merely ADDING `pr under review` — over-matching there
   * is cheap and recoverable.
   *
   * Strict is required by any TERMINAL transition (one that strips the trigger
   * label and declares work done), where a false positive permanently marks
   * unbuilt work as complete. "Related to #N" is not a claim of implementation —
   * and the Foreman's OWN reconciler writes `- Related to #N` into every recovery
   * PR body (reconciler.ts), so the loose predicate would terminally close issues
   * nobody built. That is slashbin-ai-foreman#28's bug with a worse blast radius.
   */
  strict?: boolean;
}): number[] {
  const { title = "", body = "", commitHeadlines = [], commitBodies = [], strict = false } = opts;
  const keywordRe = strict
    ? /\b(?:closes?|fixes?|resolves?)\s*:?\s*#(\d+)/gi
    : /\b(?:related\s+to|closes?|fixes?|resolves?|refs?|see)\s*:?\s*#(\d+)/gi;
  const suffixRe = /\(#(\d+)\)/g;
  const found = new Set<number>();

  // Keyword references are explicit intent — authoritative anywhere.
  const keywordText = [title, body, ...commitHeadlines, ...commitBodies].join("\n");
  for (const m of keywordText.matchAll(keywordRe)) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) found.add(n);
  }
  // `(#N)` suffix is authoritative ONLY in the title or a commit headline —
  // never the free-text body, where it is a prose mention of a sibling issue.
  const suffixText = [title, ...commitHeadlines].join("\n");
  for (const m of suffixText.matchAll(suffixRe)) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) found.add(n);
  }
  return Array.from(found).sort((a, b) => a - b);
}

export function findActionableIssues(
  config: RepoConfig,
  logger: Logger
): number[] {
  const repo = config.githubRepo;

  try {
    const issues = getOpenIssues(repo, config.repoPath, logger)
      .filter((i) => hasLabel(i, config.triggerLabel));

    const lifecycleLabels = [
      "pr under review",
      "pr approved",
      "pr pending actions",
      "ready for prod release",
      "ready to close",
    ];

    // Collect actionable issues (approved, not blocked, no lifecycle label)
    const actionable: number[] = [];
    for (const issue of issues) {
      const labels = issue.labels.map((l) => l.name);
      if (labels.includes("blocked")) continue;
      if (lifecycleLabels.some((l) => labels.includes(l))) continue;
      actionable.push(issue.number);
    }

    if (actionable.length === 0) return [];

    // Loop detection: check if all actionable issues already have a PR (open or merged)
    // that references them. If so, skip — the Foreman already did the work.
    // Check both open and merged PRs to catch issues where the PR was already merged
    // but the issue label wasn't updated.
    const openPrs = findOpenPrs(repo, config.repoPath, { base: config.baseBranch, limit: 50 });

    const mergedPrJson = gh([
      "pr", "list",
      "--repo", repo,
      "--state", "merged",
      "--base", config.baseBranch,
      "--json", "number,title,body",
      "--limit", "20",
    ], config.repoPath);

    const mergedPrs: { number: number; title: string; body: string }[] = JSON.parse(mergedPrJson || "[]");
    const allPrs = [...openPrs, ...mergedPrs];

    // An issue is "covered" only if some PR IMPLEMENTS it (close/relate keyword,
    // or `(#N)` in the title) — NOT merely mentions it in body prose. The old
    // bare-`#N` test over concatenated title+body orphaned issues that a sibling
    // PR's body referenced (e.g. a schema PR body saying "tracked separately in
    // #3" made #3 look covered, so it was never implemented). (slashbin-ai-foreman#28)
    const covered = new Set<number>();
    for (const pr of allPrs) {
      for (const n of extractImplementedIssues({ title: pr.title, body: pr.body })) {
        covered.add(n);
      }
    }

    const uncovered: number[] = [];
    for (const issueNum of actionable) {
      if (!covered.has(issueNum)) {
        uncovered.push(issueNum);
      }
    }

    if (uncovered.length > 0) {
      // Sort ascending so lowest issue numbers (dependencies) come first
      uncovered.sort((a, b) => a - b);

      // Greenfield detection: if repo has very few tracked files, limit to 1 issue
      // The skill implements one-at-a-time anyway, but a focused prompt is more reliable
      let effectiveBatchSize = MAX_BATCH_SIZE;
      try {
        const fileCount = gh(["ls-files", "--cached"], config.repoPath).split("\n").filter(Boolean).length;
        if (fileCount < 10) {
          effectiveBatchSize = 1;
          logger.info(`Greenfield repo detected (${fileCount} files) — limiting to 1 issue per cycle`);
        }
      } catch { /* ignore — use default batch size */ }

      const batch = uncovered.slice(0, effectiveBatchSize);
      if (uncovered.length > MAX_BATCH_SIZE) {
        logger.info(`Found ${uncovered.length} actionable issue(s), capping batch to ${MAX_BATCH_SIZE}: ${batch.map(n => `#${n}`).join(", ")} (${uncovered.length - MAX_BATCH_SIZE} deferred to next cycle)`);
      } else {
        logger.info(`Found ${uncovered.length} actionable issue(s) with no linked PR: ${batch.map(n => `#${n}`).join(", ")}`);
      }
      return batch;
    }

    logger.info(`Skipped ${repo}: ${actionable.length} approved issue(s), all have linked PRs (open or merged)`);
    return [];
  } catch (err) {
    logger.error("Failed to check for approved issues", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// --- Revision Gate ---

export interface PendingRevisionPR {
  number: number;
  url: string;
  headRefName: string;
}

export interface PendingRevisionInfo {
  issueNumbers: number[];
  pr: PendingRevisionPR;
}

/**
 * Gate check: are there any issues with "pr pending actions" label?
 * These are issues where the reviewer requested changes on the linked PR
 * and the Foreman needs to revise the code.
 *
 * The review workflow applies "pr pending actions" to the ISSUE (not the PR),
 * so we query issues and then confirm they have an open feature PR.
 *
 * Returns the pending revision details, or null if no work.
 */
export function findPendingRevisions(
  config: RepoConfig,
  logger: Logger
): PendingRevisionInfo | null {
  try {
    // Find issues labeled "pr pending actions" + the trigger label (approved)
    const pendingActions = getOpenIssues(config.githubRepo, config.repoPath, logger)
      .filter((i) => hasLabel(i, "pr pending actions"));
    const issues = pendingActions.filter((i) => hasLabel(i, config.triggerLabel));

    // An issue asked to revise but no longer carrying the trigger label is
    // SKIPPED here, and that is deliberate — revoking `approved` is how work is
    // called off, and revise must honour it rather than press on.
    //
    // But silent is wrong. The issue keeps `pr pending actions`, so
    // `findActionableIssues` skips it too, and it belongs to no phase at all.
    // Deliberately stopped and accidentally stranded produced the identical
    // observation — nothing — until this line existed. Say which one it is.
    const withheld = pendingActions.filter((i) => !hasLabel(i, config.triggerLabel));
    if (withheld.length > 0) {
      logger.warn(
        `${config.name}: ${withheld.length} issue(s) labeled "pr pending actions" without "${config.triggerLabel}" — ` +
        `revise will NOT act on them and no other phase owns them. Intentional if the work was called off; ` +
        `otherwise re-apply "${config.triggerLabel}" or clear the lifecycle label: ` +
        withheld.map((i) => `#${i.number}`).join(", "),
      );
    }

    if (issues.length === 0) return null;

    // Confirm there's an open feature PR (features → develop)
    const prs: PendingRevisionPR[] = findOpenPrs(config.githubRepo, config.repoPath, {
      head: config.featureBranch,
      base: config.baseBranch,
      limit: 1,
    });
    if (prs.length > 0) {
      logger.info(`Found ${issues.length} issue(s) pending revision with open PR #${prs[0].number}: ${issues.map(i => `#${i.number}`).join(", ")}`);
      return { issueNumbers: issues.map(i => i.number), pr: prs[0] };
    }

    logger.debug(`Found ${issues.length} issue(s) with "pr pending actions" but no open feature PR`);
    return null;
  } catch (err) {
    logger.error("Failed to check for pending revisions", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Backwards-compatible boolean wrapper for the implement-phase gate. */
export function hasPendingRevisions(
  config: RepoConfig,
  logger: Logger
): boolean {
  return findPendingRevisions(config, logger) !== null;
}

export interface ReviewCandidate {
  prNumber: number;
  prUrl: string;
  issueNumbers: number[];
}

/**
 * Gate check for the review phase: is there an open feature PR whose linked
 * issue(s) are labeled `pr under review` (set by implement/revise) and that has
 * NOT already been reviewed by the EM at its current head?
 *
 * Idempotency is primarily label-driven and self-cleaning: a full-fidelity review
 * run either merges an approved PR (closes it → out of scope here) or posts
 * REQUEST_CHANGES and relabels the issue `pr pending actions` (→ owned by the
 * revise phase, excluded below). The freshness guard (`hasFreshReview`) covers the
 * remaining window where a review run crashed after posting its verdict but before
 * relabeling — without it the same PR would be re-reviewed every cycle.
 *
 * Self-heal fallback: when no issue carries `pr under review` but an open feature
 * PR exists, the implement phase opened the PR but never applied the label (the
 * transition step swallows errors, and the process can die between `gh pr create`
 * and `transitionImplementationLabels`). GitHub — the actual open PR — is the
 * source of truth for whether review is needed; the label is a tracking artifact.
 * `adoptOrphanedReviewCandidate` finds linked issues from the PR title/body,
 * applies `pr under review` to them, and returns the candidate so the review runs
 * this cycle instead of hanging forever waiting for a label that never lands.
 *
 * Returns null when there's nothing to review.
 */
export function findPRsNeedingReview(
  config: RepoConfig,
  reviewerLogin: string,
  logger: Logger,
): ReviewCandidate | null {
  try {
    const issues = getOpenIssues(config.githubRepo, config.repoPath, logger)
      .filter((i) => hasLabel(i, "pr under review"));
    // Exclude issues also labeled `pr pending actions` — the revise phase owns those.
    const reviewable = issues.filter((i) => !hasLabel(i, "pr pending actions"));
    if (reviewable.length === 0) {
      return adoptOrphanedReviewCandidate(config, reviewerLogin, logger);
    }

    // Confirm an open feature PR exists (features → develop).
    const prs: { number: number; url: string }[] = findOpenPrs(config.githubRepo, config.repoPath, {
      head: config.featureBranch,
      base: config.baseBranch,
      limit: 1,
    });
    if (prs.length === 0) {
      logger.debug(`${config.name}: ${reviewable.length} issue(s) labeled "pr under review" but no open feature PR`);
      return null;
    }
    const pr = prs[0];

    if (hasFreshReview(config, pr.number, reviewerLogin, logger)) {
      logger.debug(`${config.name}: PR #${pr.number} already has a current ${reviewerLogin} review — skipping re-review`);
      return null;
    }

    logger.info(
      `${config.name}: PR #${pr.number} needs review (issues: ${reviewable.map((i) => `#${i.number}`).join(", ")})`,
    );
    return { prNumber: pr.number, prUrl: pr.url, issueNumbers: reviewable.map((i) => i.number) };
  } catch (err) {
    logger.error("Failed to check for PRs needing review", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Fallback for `findPRsNeedingReview`: an open feature PR exists but no linked
 * issue carries `pr under review`. The implement phase opened the PR then failed
 * (silently) to apply the label — or crashed between `gh pr create` and
 * `transitionImplementationLabels`. Recover by extracting linked issue refs from
 * the PR title/body, applying `pr under review` to those that still carry the
 * trigger label, and returning a candidate so the review runs this cycle.
 *
 * Safety filters (only adopt issues we clearly own):
 *  - OPEN state
 *  - carries `config.triggerLabel` (default `approved`)
 *  - NOT `pr pending actions` (revise phase owns those)
 *  - NOT `ready for prod release` (already advanced)
 */
function adoptOrphanedReviewCandidate(
  config: RepoConfig,
  reviewerLogin: string,
  logger: Logger,
): ReviewCandidate | null {
  const prs: { number: number; url: string; title: string; body: string }[] = findOpenPrs(
    config.githubRepo,
    config.repoPath,
    { head: config.featureBranch, base: config.baseBranch, limit: 1 },
  );
  if (prs.length === 0) return null;
  const pr = prs[0];

  if (hasFreshReview(config, pr.number, reviewerLogin, logger)) return null;

  const refs = new Set<number>();
  const combined = `${pr.title}\n${pr.body ?? ""}`;
  for (const m of combined.matchAll(/#(\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n !== pr.number) refs.add(n);
  }
  if (refs.size === 0) {
    logger.debug(`${config.name}: PR #${pr.number} has no "pr under review" label and no linked issues found in title/body`);
    return null;
  }

  const adopted: number[] = [];
  for (const num of refs) {
    try {
      const raw = gh([
        "issue", "view", String(num),
        "--repo", config.githubRepo,
        "--json", "state,labels",
      ], config.repoPath);
      const info: { state: string; labels: { name: string }[] } = JSON.parse(raw);
      if (info.state !== "OPEN") continue;
      const names = new Set(info.labels.map((l) => l.name));
      if (!names.has(config.triggerLabel)) continue;
      if (names.has("pr pending actions")) continue;
      if (names.has("ready for prod release")) continue;
      try {
        gh([
          "issue", "edit", String(num),
          "--repo", config.githubRepo,
          "--add-label", "pr under review",
        ], config.repoPath);
        logger.warn(`${config.name}: adopted orphaned issue #${num} → PR #${pr.number} (implement phase never applied "pr under review")`);
      } catch (err) {
        logger.warn(`${config.name}: failed to add "pr under review" on adopted #${num}: ${err instanceof Error ? err.message : String(err)}`);
      }
      adopted.push(num);
    } catch (err) {
      logger.debug(`${config.name}: could not inspect referenced #${num}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (adopted.length === 0) {
    logger.debug(`${config.name}: PR #${pr.number} is orphaned but no referenced issue is a review candidate (missing ${config.triggerLabel}, or owned by revise/prod)`);
    return null;
  }

  logger.info(`${config.name}: adopted orphaned PR #${pr.number} for review (issues: ${adopted.map((n) => `#${n}`).join(", ")})`);
  return { prNumber: pr.number, prUrl: pr.url, issueNumbers: adopted };
}

export interface MergedIssueRef {
  issueNumber: number;
  prNumber: number;
  prUrl: string;
  mergedAt: string;
}

/**
 * THE shared primitive: of `candidates`, which issues' work is already MERGED to
 * `baseBranch`? Resolved by running each recently-merged PR through the STRICT
 * implemented-issue predicate — a merged PR must say it *closed* the issue
 * (`closes`/`fixes`/`resolves #N`, or `(#N)` in the title / a commit headline).
 * A mere "related to #N" does not count. See extractImplementedIssues({strict}).
 *
 * Two callers, two DIFFERENT policies — the distinction that matters is
 * *did a gate reject this work?*:
 *   - implement-skip (slashbin-ai-foreman#32): no gate ever ran, the work is just
 *     merged with no lifecycle label → AUTO-ADVANCE to the terminal state.
 *   - findStuckMergedIssues: post-merge verify FAILED → NEVER auto-advance
 *     (a gate rejected it); surface to the EM instead.
 *
 * Conservative: returns [] on any lookup failure — under-advancing is safe
 * (status quo), over-advancing marks unbuilt work as done.
 */
export function findIssuesMergedToBase(
  config: RepoConfig,
  candidates: number[],
  logger: Logger,
): MergedIssueRef[] {
  if (candidates.length === 0) return [];
  try {
    const json = gh([
      "pr", "list",
      "--repo", config.githubRepo,
      "--state", "merged",
      "--base", config.baseBranch,
      "--json", "number,url,title,body,commits,mergedAt",
      "--limit", "30",
    ], config.repoPath);
    const prs = JSON.parse(json || "[]") as {
      number: number;
      url: string;
      title?: string;
      body?: string;
      commits?: { messageHeadline?: string; messageBody?: string }[];
      mergedAt?: string;
    }[];

    const wanted = new Set(candidates);
    const hits = new Map<number, MergedIssueRef>();
    for (const pr of prs) {
      const commits = pr.commits ?? [];
      const closed = extractImplementedIssues({
        title: pr.title || "",
        body: pr.body || "",
        commitHeadlines: commits.map((c) => c.messageHeadline || ""),
        commitBodies: commits.map((c) => c.messageBody || ""),
        strict: true,
      });
      for (const n of closed) {
        // Never match a PR against its OWN number: GitHub's squash-merge appends
        // "(#<pr>)" to the commit headline, which the `(#N)` rule would otherwise
        // read as "this PR closed issue #<pr>". Harmless today (issues and PRs
        // share one number sequence, so a PR number is never an issue number) —
        // guarded anyway so it can't become a real false-advance later.
        if (n === pr.number) continue;
        // Keep the FIRST (most recent — gh lists newest-first) merged PR per issue.
        if (wanted.has(n) && !hits.has(n) && pr.mergedAt) {
          hits.set(n, {
            issueNumber: n,
            prNumber: pr.number,
            prUrl: pr.url,
            mergedAt: pr.mergedAt,
          });
        }
      }
    }
    return [...hits.values()].sort((a, b) => a.issueNumber - b.issueNumber);
  } catch (err) {
    logger.warn("findIssuesMergedToBase: gh pr list failed — advancing nothing", {
      ...formatGhError(err),
      repo: config.githubRepo,
    });
    return [];
  }
}

/**
 * TERMINAL transition (slashbin-ai-foreman#32): the issue's work is already merged
 * to the base branch. Strip the trigger label so the issue permanently leaves the
 * actionable set, and add `pr approved` — meaning "implemented and merged, awaiting
 * the EM outcome-gate."
 *
 * It must NOT be `ready for prod release`: that label is the EM outcome-gate's
 * signature and authorizes production. Granting it here would let the Foreman
 * authorize its own release (separation of duties, 2026-07-27).
 *
 * Stripping `triggerLabel` is the load-bearing half: without it the issue stays
 * "actionable" forever and the Foreman burns a full Claude session every back-off
 * window concluding there is nothing to do. Uses `config.triggerLabel` rather than
 * a hard-coded "approved" — the trigger label is configurable (OSS).
 */
export function transitionToReadyForProd(
  config: RepoConfig,
  issueNumbers: number[],
  logger: Logger,
): void {
  for (const num of issueNumbers) {
    try {
      gh([
        "issue", "edit", String(num),
        "--repo", config.githubRepo,
        "--remove-label", config.triggerLabel,
        "--add-label", "pr approved",
      ], config.repoPath);
      logger.info(
        `Terminal transition on #${num}: removed "${config.triggerLabel}", added "pr approved" (work already merged to ${config.baseBranch})`,
      );
    } catch (err) {
      logger.warn(
        `Failed terminal transition on #${num}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export type StuckMergedIssue = MergedIssueRef;

/** Grace window before a merged-but-unadvanced issue is treated as dead-zoned,
 *  giving an in-flight post-merge verify time to advance it. Prevents flapping
 *  on freshly-merged PRs the review agent is still finishing. */
const STUCK_MERGE_GRACE_MS = 15 * 60 * 1000;

/**
 * Detect issues DEAD-ZONED by a failed post-merge verify: labeled `pr under
 * review` with their feature PR already MERGED to the base branch, yet never
 * advanced to `ready for prod release`. `findPRsNeedingReview` only fires while
 * the PR is OPEN; once it merges, a failed post-merge verify leaves the issue
 * pinned at `pr under review` with NO phase that ever recovers it. This surfaces
 * those so the EM can re-verify and advance/flag by hand.
 *
 * DETECTION ONLY — this function never mutates labels. It does NOT follow that
 * nothing can be done: re-running the post-merge verification and advancing on
 * PASS / flagging on FAIL is exactly what the alert asks the EM to do by hand,
 * and it is not a rubber stamp because the verdict comes from the verifier, not
 * from the agent that dropped the ball. That repair lives in the orchestrator
 * (`recoverDeadZonedIssue`); the split keeps "what is broken" separable from
 * "what we did about it". What remains forbidden is advancing WITHOUT a fresh
 * verification — a post-merge FAIL must still HOLD.
 *
 * Conservative by design (returns [] on any ambiguity):
 *  - skips main-only repos (no features→develop lifecycle)
 *  - ignores `pr approved` / `ready for prod release` (already advanced)
 *  - ignores issues REFERENCED BY an open feature PR (normal review-pending;
 *    tryReview owns those specific issues)
 *  - only flags PRs merged more than STUCK_MERGE_GRACE_MS ago (no flap on fresh merges)
 *
 * `pr pending actions` USED to be excluded here on the grounds that "revise owns
 * it". That was only true while a feature PR is open: `findPendingRevisions`
 * returns null the moment there is none, at `debug` level, so a revision request
 * whose PR merged or closed underneath it was owned by nobody and logged
 * nowhere. It is the same dead zone as `pr under review`, one label over, and it
 * is now included.
 */
export function findStuckMergedIssues(
  config: RepoConfig,
  logger: Logger,
): StuckMergedIssue[] {
  if (config.baseBranch === config.featureBranch) return [];
  try {
    const issues = getOpenIssues(config.githubRepo, config.repoPath, logger)
      .filter((i) => hasLabel(i, "pr under review") || hasLabel(i, "pr pending actions"));
    const candidates = issues.filter(
      (i) => !(
        hasLabel(i, "pr approved") || hasLabel(i, "ready for prod release")
      ),
    );
    if (candidates.length === 0) return [];

    // An open feature PR means the issues THAT PR COVERS are normal
    // review-pending — tryReview owns those. It says nothing about any other
    // issue in the repo.
    //
    // This used to `return []` for the whole repo the moment any feature PR was
    // open. Because the feature branch is long-lived and shared, a repo with
    // active work almost always has one — so a single open PR concealed every
    // dead-zoned issue behind it, and the dead zone became least visible exactly
    // when the repo was busiest. Scope the exclusion to the referenced issues.
    //
    // Fail CLOSED on an unreadable reference list: if we cannot tell which
    // issues the open PR covers, suppress the whole repo as before rather than
    // risk "recovering" an issue whose PR is still open and under review.
    const openFeaturePrs = findOpenPrs(config.githubRepo, config.repoPath, {
      head: config.featureBranch,
      base: config.baseBranch,
      limit: 1,
    });
    let reviewPending: number[] = [];
    if (openFeaturePrs.length > 0) {
      const referenced = getReferencedIssuesFromOpenPR(
        config.githubRepo,
        config.featureBranch,
        config.baseBranch,
        config.repoPath,
        logger,
      );
      if (referenced === null) {
        logger.debug(
          `${config.name}: open feature PR present but its referenced issues are unreadable — suppressing dead-zone detection this pass`,
        );
        return [];
      }
      reviewPending = referenced;
    }
    const unowned = candidates.filter((i) => !reviewPending.includes(i.number));
    if (unowned.length === 0) return [];

    // Resolve merged work via the SHARED strict primitive — not a bare `#N` scan.
    // A bare-`#N` match would false-positive on an incidental prose mention
    // (slashbin-ai-foreman#28), flagging issues that were never actually merged.
    const merged = findIssuesMergedToBase(
      config,
      unowned.map((i) => i.number),
      logger,
    );

    const nowMs = Date.now();
    return merged.filter(
      (m) => nowMs - new Date(m.mergedAt).getTime() > STUCK_MERGE_GRACE_MS,
    );
  } catch (err) {
    logger.debug(
      `findStuckMergedIssues failed for ${config.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Detect issues ORPHANED by work that never landed: labeled `pr under review`
 * or `pr pending actions`, with **no open feature PR covering them and nothing
 * merged to the base branch**. The PR was closed without merging, or the
 * implement run recorded a label and then died before opening one.
 *
 * This is the third dead zone and the only one where the work does not exist:
 *
 *   | label               | PR open   | PR merged        | PR closed / none |
 *   |---------------------|-----------|------------------|------------------|
 *   | pr under review     | tryReview | findStuckMerged  | HERE             |
 *   | pr pending actions  | tryRevise | findStuckMerged  | HERE             |
 *
 * The lifecycle label is what makes it invisible: `findActionableIssues` skips
 * ANY issue carrying one, so an issue whose PR vanished keeps its `approved`
 * label, is never re-implemented, is never reviewed, and produces no log line
 * above `debug`. It simply stops existing as far as the pipeline is concerned.
 *
 * Recovery is the opposite of the merged case: there is nothing to verify, so
 * the correct action is to RETURN IT TO THE QUEUE — strip the lifecycle label
 * and let the implement phase pick it up again on its `approved` label. That is
 * safe precisely because nothing merged; re-implementing cannot duplicate work
 * that does not exist.
 *
 * Conservative by design:
 *  - skips main-only repos
 *  - ignores `pr approved` / `ready for prod release` (past this stage)
 *  - ignores issues an open feature PR references, and fails CLOSED when that
 *    reference list is unreadable
 *  - requires the issue to have been in this state longer than the grace window,
 *    so a PR being opened right now is never mistaken for one that never was
 */
export function findOrphanedLifecycleIssues(
  config: RepoConfig,
  logger: Logger,
): number[] {
  if (config.baseBranch === config.featureBranch) return [];
  try {
    const open = getOpenIssues(config.githubRepo, config.repoPath, logger);
    const candidates = open.filter(
      (i) =>
        (hasLabel(i, "pr under review") || hasLabel(i, "pr pending actions")) &&
        !hasLabel(i, "pr approved") &&
        !hasLabel(i, "ready for prod release"),
    );
    if (candidates.length === 0) return [];

    const openFeaturePrs = findOpenPrs(config.githubRepo, config.repoPath, {
      head: config.featureBranch,
      base: config.baseBranch,
      limit: 1,
    });
    let reviewPending: number[] = [];
    if (openFeaturePrs.length > 0) {
      const referenced = getReferencedIssuesFromOpenPR(
        config.githubRepo,
        config.featureBranch,
        config.baseBranch,
        config.repoPath,
        logger,
      );
      // Unreadable reference list — cannot tell what the open PR covers, so
      // releasing anything risks re-implementing work that is in flight.
      if (referenced === null) return [];
      reviewPending = referenced;
    }

    const unowned = candidates.filter((i) => !reviewPending.includes(i.number));
    if (unowned.length === 0) return [];

    // Anything already merged belongs to findStuckMergedIssues, which re-verifies
    // rather than re-queues. Only what NEVER landed is an orphan.
    const merged = new Set(
      findIssuesMergedToBase(config, unowned.map((i) => i.number), logger).map((m) => m.issueNumber),
    );

    return unowned.filter((i) => !merged.has(i.number)).map((i) => i.number);
  } catch (err) {
    logger.debug(
      `findOrphanedLifecycleIssues failed for ${config.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Return an orphaned issue to the implement queue by stripping whichever
 * lifecycle label is stranding it. The trigger label (`approved`) is left alone
 * — it is still authorized, it just never got built.
 */
export function releaseOrphanedLifecycle(
  config: RepoConfig,
  issueNumber: number,
  logger: Logger,
): boolean {
  try {
    dropIssueSnapshot(config.githubRepo);
    const issue = getOpenIssues(config.githubRepo, config.repoPath, logger)
      .find((i) => i.number === issueNumber);
    if (!issue) return false;

    const args = ["issue", "edit", String(issueNumber), "--repo", config.githubRepo];
    // `gh` errors when removing a label that is not present, so only remove what is.
    if (hasLabel(issue, "pr under review")) args.push("--remove-label", "pr under review");
    if (hasLabel(issue, "pr pending actions")) args.push("--remove-label", "pr pending actions");
    if (args.length === 5) return false; // nothing to strip — state changed under us

    gh(args, config.repoPath);
    logger.warn(
      `Released orphaned issue #${issueNumber} back to the implement queue — it carried a lifecycle label ` +
      `but no open PR covers it and nothing merged, so the work never landed.`,
    );
    return true;
  } catch (err) {
    logger.warn(
      `Failed to release orphaned issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * POST-CONDITION CHECK for a finished review run: of `issueNumbers`, which are
 * still pinned at `pr under review` with no lifecycle label beyond it?
 *
 * The review phase reports its own outcome via a self-declared status trailer.
 * A trailer is a CLAIM; the labels are the STATE. When the two disagree the
 * labels win, because the next phase reads labels and nothing ever reads the
 * trailer again. Checking them directly is what makes the orphan detectable
 * without any cooperation from the agent that created it.
 *
 * Reads FRESH — the review runs in a separate process whose label writes never
 * invalidate our snapshot cache, so a cached read here would report the
 * pre-review state and manufacture a false orphan on every successful run.
 *
 * Returns [] on any lookup failure: a check that cannot see the truth must not
 * assert one.
 */
export function findIssuesStillUnderReview(
  config: RepoConfig,
  issueNumbers: number[],
  logger: Logger,
): number[] {
  if (issueNumbers.length === 0) return [];
  try {
    dropIssueSnapshot(config.githubRepo);
    const open = getOpenIssues(config.githubRepo, config.repoPath, logger);
    return issueNumbers.filter((num) => {
      const issue = open.find((i) => i.number === num);
      // Absent from the open set = closed. The review closed it out; not stuck.
      if (!issue) return false;
      if (!hasLabel(issue, "pr under review")) return false;
      return !(
        hasLabel(issue, "pr approved") ||
        hasLabel(issue, "pr pending actions") ||
        hasLabel(issue, "ready for prod release")
      );
    });
  } catch (err) {
    logger.debug(
      `findIssuesStillUnderReview failed for ${config.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Move an issue out of `pr under review` into the outcome label its own review
 * run reported, immediately after that run — the deterministic write that closes
 * the gap this whole lifecycle used to leave open.
 *
 * Why this exists at all: the merge is performed by code, but the record of what
 * the merge MEANT was left to the review agent to remember to write. Measured over
 * 7 days (2026-07-29 → 08-04): 53 merges, 12 issues left mislabeled — ~23%. In the
 * worked example (slashbin-io-worker#575) the agent merged, verified, reported
 * `verdict=APPROVE merged=yes deploy=SUCCESS`, named the target label 24 times in
 * its own output, and never executed the write. The Foreman parsed that trailer,
 * logged it, and did nothing with it.
 *
 * Sibling of `resolveDeadZone`, which repairs the same state a cycle later from a
 * FRESH verification. This one is the first line of defense and needs no
 * re-verification because the verdict is the one the review just produced. Kept
 * separate rather than merged with it: the two differ in where their verdict comes
 * from, and that provenance is exactly what a reader needs to trust either one.
 *
 * Never applies `ready for prod release` — that label is the EM outcome-gate's
 * signature and stays a human act (separation of duties, 2026-07-27).
 */
export function transitionReviewOutcomeLabel(
  config: RepoConfig,
  issueNumber: number,
  nextLabel: "pr approved" | "pr pending actions",
  logger: Logger,
): boolean {
  try {
    gh([
      "issue", "edit", String(issueNumber),
      "--repo", config.githubRepo,
      "--remove-label", "pr under review",
      "--add-label", nextLabel,
    ], config.repoPath);
    logger.info(
      `Reconciled outcome label on #${issueNumber}: "pr under review" → "${nextLabel}" (from the review run's own trailer)`,
    );
    return true;
  } catch (err) {
    logger.warn(
      `Failed to reconcile outcome label on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * The label that authorizes production. Only the EM outcome-gate applies it, and
 * nothing in the review path may take it away.
 */
export const EM_GATE_LABEL = "ready for prod release";

export interface TimelineLabelEvent {
  event?: string;
  label?: { name?: string };
  created_at?: string;
}

/**
 * Did the EM outcome-gate label get REMOVED at or after `sinceMs`?
 *
 * Pure, so the rule can be tested without a network. The rule that matters is
 * time-symmetry: this asks "was it taken away during the window", never "did it
 * exist before the window". The previous guard asked the second question and
 * therefore missed every gate signed while a review was already running — which
 * is the normal case, not the edge case.
 */
export function wasGateRevokedSince(events: TimelineLabelEvent[], sinceMs: number): boolean {
  return events.some((e) =>
    e.event === "unlabeled" &&
    e.label?.name === EM_GATE_LABEL &&
    typeof e.created_at === "string" &&
    Number.isFinite(Date.parse(e.created_at)) &&
    Date.parse(e.created_at) >= sinceMs,
  );
}

/**
 * Which of `issueNumbers` had the EM outcome-gate label REMOVED since `sinceIso`.
 *
 * Detected from the issue's own label timeline, not from a snapshot taken before
 * the run. That distinction is the entire point, and the first version of this
 * guard got it wrong: it captured which issues held the gate BEFORE the review
 * started, then restored those. That handles a gate signed before the run and
 * completely misses a gate signed DURING it — which is the actual reported
 * scenario, and the one that recurred on Slashbin-io-docs#269 (review triggered
 * 13:52:25Z, gate signed 13:57:41Z, agent removed it 13:58:20Z, guard restored
 * nothing because its snapshot predated the signature).
 *
 * Reading the timeline is time-symmetric: an `unlabeled` event inside the run
 * window is a revocation regardless of when the label was applied.
 *
 * Only consulted for issues that do NOT currently carry the label, so the healthy
 * path costs nothing beyond the open-issue snapshot already in hand. Returns []
 * on any failure — a lookup that fails must never manufacture authorization.
 */
export function findRevokedEmGates(
  config: RepoConfig,
  issueNumbers: number[],
  sinceIso: string,
  logger: Logger,
): number[] {
  if (issueNumbers.length === 0) return [];
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return [];

  const revoked: number[] = [];
  try {
    dropIssueSnapshot(config.githubRepo);
    const open = getOpenIssues(config.githubRepo, config.repoPath, logger);

    for (const num of issueNumbers) {
      const issue = open.find((i) => i.number === num);
      // Closed, or the gate is still there — nothing was revoked.
      if (!issue || hasLabel(issue, EM_GATE_LABEL)) continue;

      try {
        const raw = gh([
          "api", `repos/${config.githubRepo}/issues/${num}/timeline?per_page=100`,
          "-H", "Accept: application/vnd.github.mockingbird-preview+json",
        ], config.repoPath);
        const events: TimelineLabelEvent[] = JSON.parse(raw || "[]");
        if (wasGateRevokedSince(events, since)) revoked.push(num);
      } catch (err) {
        logger.warn(
          `Could not read the label timeline for #${num}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    logger.warn(`findRevokedEmGates failed for ${config.githubRepo}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return revoked;
}

export interface EmGateRestoreStep {
  number: number;
  /** The review wrote `pr approved` in the gate's place — strip it on the way back. */
  dropPrApproved: boolean;
}

/**
 * Decide, with no I/O, which issues need their EM outcome-gate put back.
 *
 * Split out from `restoreEmGate` so the decision is testable without a network:
 * the rules about what counts as "revoked" are the part worth pinning, and the
 * `gh` call around them is not.
 *
 * Restores only issues that (a) carried the gate before the run, (b) are still
 * open, and (c) no longer carry it. A closed issue needs no gate — the promotion
 * either happened or the work was abandoned, and re-labeling a closed issue would
 * put it back in the Foreman's pickup list for no reason.
 */
export function planEmGateRestore(
  hadGate: number[],
  open: { number: number; labels: { name: string }[] }[],
): EmGateRestoreStep[] {
  const steps: EmGateRestoreStep[] = [];
  for (const num of hadGate) {
    const issue = open.find((i) => i.number === num);
    if (!issue) continue;                                   // closed — nothing to restore
    const names = new Set(issue.labels.map((l) => l.name));
    if (names.has(EM_GATE_LABEL)) continue;                 // still signed — healthy path
    steps.push({ number: num, dropPrApproved: names.has("pr approved") });
  }
  return steps;
}

/**
 * Put back any EM outcome-gate label that disappeared across a review run.
 *
 * The review agent writes issue labels itself, so the Foreman cannot intercept
 * that write — it can only detect the damage and undo it. This is the structural
 * half of a rule that until now existed only as a sentence in the review prompt.
 *
 * Why it matters that this is silent without the check: `tryPromotion` calls
 * `findReadyForProdIssues`, which filters on exactly this label, and returns
 * early on an empty set. A revoked gate produces no PR, no error and no log line
 * — indistinguishable from having nothing to promote. Observed on
 * Slashbin-io-docs, 2026-08-04: the gate was signed at 20:20:15Z, overwritten
 * with `pr approved` at 20:22:12Z by a review run that started at 20:11:59Z, and
 * the promotion sat stalled for an hour until a human noticed the absence.
 *
 * A review verdict is never authority to revoke production authorization, so
 * restoring is unconditional. `pr approved` is stripped only when present — it is
 * the label the review wrote in the gate's place, and the two are different
 * lifecycle states, not additive ones.
 *
 * Returns the issues actually restored (usually none — the healthy path).
 */
export function restoreEmGate(
  config: RepoConfig,
  hadGate: number[],
  logger: Logger,
): number[] {
  if (hadGate.length === 0) return [];
  const restored: number[] = [];
  try {
    dropIssueSnapshot(config.githubRepo);
    const open = getOpenIssues(config.githubRepo, config.repoPath, logger);
    for (const step of planEmGateRestore(hadGate, open)) {
      const { number: num, dropPrApproved } = step;
      const args = [
        "issue", "edit", String(num),
        "--repo", config.githubRepo,
        "--add-label", EM_GATE_LABEL,
      ];
      // Only remove what is actually there; `gh` errors on removing an absent label.
      if (dropPrApproved) args.push("--remove-label", "pr approved");

      try {
        gh(args, config.repoPath);
        restored.push(num);
        logger.warn(
          `Restored "${EM_GATE_LABEL}" on #${num} — the review run removed it. ` +
          `A review verdict does not authorize or revoke production; only the EM outcome-gate does.`,
        );
      } catch (err) {
        logger.error(
          `Failed to restore "${EM_GATE_LABEL}" on #${num} — promotion is STALLED until a human re-applies it: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    logger.warn(`restoreEmGate failed for ${config.githubRepo}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return restored;
}

/**
 * Move a dead-zoned issue out of `pr under review` once a FRESH verification has
 * produced a verdict: `pr approved` on PASS, `pr pending actions` on FAIL.
 *
 * Deliberately never applies `ready for prod release` — that label is the EM
 * outcome-gate's signature and stays a human act (separation of duties, same
 * rule the review prompt enforces). The most this can do is restore the issue to
 * the state a healthy review run would have left it in.
 */
export function resolveDeadZone(
  config: RepoConfig,
  issueNumber: number,
  verdict: "pass" | "fail",
  logger: Logger,
): boolean {
  const nextLabel = verdict === "pass" ? "pr approved" : "pr pending actions";
  try {
    // Remove only what is actually present. `gh` errors on removing an absent
    // label, and since the dead zone now covers `pr pending actions` as well as
    // `pr under review`, a hard `--remove-label "pr under review"` would throw
    // on exactly the issues the widened detector just started catching — the
    // recovery would fail for the new case while looking like a gh outage.
    dropIssueSnapshot(config.githubRepo);
    const issue = getOpenIssues(config.githubRepo, config.repoPath, logger)
      .find((i) => i.number === issueNumber);
    if (!issue) {
      logger.debug(`Dead-zone resolve skipped for #${issueNumber} — no longer open`);
      return false;
    }

    const args = ["issue", "edit", String(issueNumber), "--repo", config.githubRepo];
    const stripped: string[] = [];
    for (const l of ["pr under review", "pr pending actions"]) {
      // Never strip the label we are about to add — that is a no-op edit that
      // reads as a transition.
      if (l !== nextLabel && hasLabel(issue, l)) {
        args.push("--remove-label", l);
        stripped.push(l);
      }
    }
    if (!hasLabel(issue, nextLabel)) args.push("--add-label", nextLabel);
    if (args.length === 4) {
      logger.debug(`Dead-zone resolve on #${issueNumber} is already in the target state`);
      return false;
    }

    gh(args, config.repoPath);
    logger.info(
      `Dead-zone resolved on #${issueNumber}: removed ${stripped.map((s) => `"${s}"`).join(", ") || "(nothing)"}, ` +
      `added "${nextLabel}" (re-verification ${verdict.toUpperCase()})`,
    );
    return true;
  } catch (err) {
    logger.warn(
      `Failed to resolve dead zone on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * True when the PR already has an APPROVED/CHANGES_REQUESTED review by
 * `reviewerLogin` submitted at or after the PR's latest commit (i.e. the current
 * head has already been reviewed). On any lookup failure returns false — we'd
 * rather (rarely) re-review than silently never review.
 */
function hasFreshReview(
  config: RepoConfig,
  prNumber: number,
  reviewerLogin: string,
  logger: Logger,
): boolean {
  try {
    const json = gh([
      "pr", "view", String(prNumber),
      "--repo", config.githubRepo,
      "--json", "reviews,commits",
    ], config.repoPath);
    const data = JSON.parse(json || "{}") as {
      commits?: { committedDate?: string }[];
      reviews?: { author?: { login?: string }; state?: string; submittedAt?: string }[];
    };
    const commits = data.commits ?? [];
    const reviews = data.reviews ?? [];
    if (commits.length === 0) return false;

    const lastCommitMs = commits
      .map((c) => (c.committedDate ? new Date(c.committedDate).getTime() : 0))
      .reduce((a, b) => Math.max(a, b), 0);

    return reviews.some(
      (r) =>
        r.author?.login === reviewerLogin &&
        (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") &&
        !!r.submittedAt &&
        new Date(r.submittedAt).getTime() >= lastCommitMs,
    );
  } catch (err) {
    logger.debug(`hasFreshReview lookup failed for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Transition issue labels after successful revision:
 * remove "pr pending actions", add "pr under review".
 */
export function transitionRevisionLabels(
  repo: string,
  issueNumbers: number[],
  cwd: string,
  logger: Logger,
): void {
  for (const num of issueNumbers) {
    try {
      gh([
        "issue", "edit", String(num),
        "--repo", repo,
        "--remove-label", "pr pending actions",
        "--add-label", "pr under review",
      ], cwd);
      logger.info(`Transitioned issue #${num} labels: "pr pending actions" → "pr under review"`);
    } catch (err) {
      logger.warn(`Failed to transition labels on #${num}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Transition issue labels after successful implementation:
 * add "pr under review" so the EM knows a PR is ready for review.
 */
export function transitionImplementationLabels(
  repo: string,
  issueNumbers: number[],
  cwd: string,
  logger: Logger,
): void {
  for (const num of issueNumbers) {
    try {
      gh([
        "issue", "edit", String(num),
        "--repo", repo,
        "--add-label", "pr under review",
      ], cwd);
      logger.info(`Added "pr under review" to issue #${num} after implementation`);
    } catch (err) {
      logger.warn(`Failed to add "pr under review" on #${num}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// --- Promotion PR Creation ---

export interface PromotionIssue {
  number: number;
  title: string;
}

export function findReadyForProdIssues(
  repo: string,
  cwd: string,
  logger: Logger
): PromotionIssue[] {
  try {
    return getOpenIssues(repo, cwd, logger)
      .filter((i) => hasLabel(i, "ready for prod release"))
      .map((i) => ({ number: i.number, title: i.title }));
  } catch (err) {
    logger.error("Failed to query ready-for-prod issues", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export interface OpenPromotionPR {
  number: number;
  url: string;
  body: string;
}

export function findOpenPromotionPR(
  repo: string,
  baseBranch: string,
  cwd: string,
  logger?: Logger,
): OpenPromotionPR | null {
  try {
    const prs: OpenPromotionPR[] = findOpenPrs(repo, cwd, { base: baseBranch, head: "develop", limit: 1 });
    return prs.length > 0 ? prs[0] : null;
  } catch (err) {
    logger?.warn("findOpenPromotionPR: gh pr list failed", { ...formatGhError(err) });
    return null;
  }
}

export function updatePromotionPR(
  repo: string,
  prNumber: number,
  issues: PromotionIssue[],
  cwd: string,
): boolean {
  const issueList = issues
    .map((i) => `- #${i.number}: ${i.title}`)
    .join("\n");

  const title = issues.length === 1
    ? `release: ${issues[0].title}`
    : `release: promote ${issues.length} changes to production`;

  const body = `## Production Promotion

### Issues included
${issueList}

---
Automated by slashbin-ai-agent`;

  // REST, NOT `gh pr edit` (2026-07-27).
  //
  // `gh pr edit` resolves the PR through GraphQL and requests `projectCards` —
  // GitHub's Projects *classic*, now sunset. The API rejects that field, gh
  // exits 1, and the edit DOES NOT APPLY:
  //
  //   GraphQL: Projects (classic) is being deprecated in favor of the new
  //   Projects experience (repository.pullRequest.projectCards)
  //
  // Reproduced twice against jerky_data_receiver#241 — exit 1, title unchanged.
  // This silently blocked EVERY repo that already had an open promotion PR,
  // from ~04:11Z until it was found at ~21:10Z: the promote phase kept logging
  // "Found N issue(s) ready for prod release" and then failing to act. Creating
  // a NEW promotion PR still worked, which is why some promotions got through
  // and others did not — a confusing signal that delayed the diagnosis.
  //
  // The REST endpoint touches no Projects field at all, so the deprecation
  // cannot affect it. Do not "simplify" this back to `gh pr edit`.
  const [owner, name] = repo.split("/");
  try {
    gh([
      "api", "--method", "PATCH",
      `repos/${owner}/${name}/pulls/${prNumber}`,
      "-f", `title=${title}`,
      "-f", `body=${body}`,
      "--silent",
    ], cwd);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string }).stderr ?? "";
    console.error(`updatePromotionPR failed: ${msg}${stderr ? ` | stderr: ${stderr}` : ""}`);
    return false;
  }
}

/**
 * Count files that differ between base and head branches.
 * Returns -1 if the check fails. Used as a precondition for promotion PRs
 * so the Foreman never opens a no-op PR when develop is ahead of main
 * only by sync merge commits with no file diff.
 */
export function countBranchDiffFiles(
  repo: string,
  base: string,
  head: string,
  cwd: string,
  logger: Logger,
): number {
  try {
    const json = gh([
      "api",
      `repos/${repo}/compare/${base}...${head}`,
      "--jq", "{ahead: .ahead_by, files: (.files // [] | length)}",
    ], cwd);
    const parsed = JSON.parse(json || "{}") as { ahead?: number; files?: number };
    return typeof parsed.files === "number" ? parsed.files : -1;
  } catch (err) {
    logger.warn(`countBranchDiffFiles failed for ${repo} (${base}...${head}): ${err instanceof Error ? err.message : String(err)}`);
    return -1;
  }
}

/**
 * Strip the `ready for prod release` label from issues once a promotion PR
 * has been created for them. Prevents a race with the EM verification script:
 * after a promotion PR merges, the Foreman's next poll would otherwise still
 * see the label (EM strips it only at close time, 1-2 min later) and create
 * a phantom follow-up promotion PR.
 */
export function stripReadyForProdLabel(
  repo: string,
  issueNumbers: number[],
  cwd: string,
  logger: Logger,
): void {
  for (const num of issueNumbers) {
    try {
      gh([
        "issue", "edit", String(num),
        "--repo", repo,
        "--remove-label", "ready for prod release",
      ], cwd);
      logger.info(`Stripped "ready for prod release" from #${num} — promotion PR owns it now`);
    } catch (err) {
      logger.warn(`Failed to strip "ready for prod release" from #${num}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function createPromotionPR(
  repo: string,
  baseBranch: string,
  issues: PromotionIssue[],
  cwd: string,
  logger?: Logger,
): string | null {
  const issueList = issues
    .map((i) => `- #${i.number}: ${i.title}`)
    .join("\n");

  const title = issues.length === 1
    ? `release: ${issues[0].title}`
    : `release: promote ${issues.length} changes to production`;

  const body = `## Production Promotion

### Issues included
${issueList}

---
Automated by slashbin-ai-agent`;

  try {
    const result = gh([
      "pr", "create",
      "--repo", repo,
      "--base", baseBranch,
      "--head", "develop",
      "--title", title,
      "--body", body,
    ], cwd);

    // Extract PR URL from output
    const match = result.match(/https:\/\/github\.com\/[^\s]+/);
    return match ? match[0] : null;
  } catch (err) {
    logger?.warn("createPromotionPR: gh pr create failed", {
      ...formatGhError(err),
      repo,
      baseBranch,
      issueNumbers: issues.map((i) => i.number),
    });
    return null;
  }
}

// --- Post-Implementation Self-Check ---

/**
 * After a PR is created, verify it has actual file changes.
 * Returns the count of changed files, or -1 if check fails.
 * Logs the changed files for traceability (Second Way).
 */
export function checkPRHasChanges(
  repo: string,
  headBranch: string,
  baseBranch: string,
  cwd: string,
  logger: Logger,
): number {
  try {
    const json = gh([
      "pr", "list",
      "--repo", repo,
      "--head", headBranch,
      "--base", baseBranch,
      "--state", "open",
      "--json", "number,files",
      "--limit", "1",
    ], cwd);

    const prs = JSON.parse(json || "[]");
    if (prs.length === 0) return -1;

    const files: { path: string }[] = prs[0].files || [];
    if (files.length === 0) {
      logger.warn("PR has no file changes — implementation may have failed silently");
      return 0;
    }

    logger.info(`PR #${prs[0].number} modifies ${files.length} file(s): ${files.map((f: { path: string }) => f.path).join(", ")}`);
    return files.length;
  } catch (err) {
    logger.warn("checkPRHasChanges: gh pr list failed", { ...formatGhError(err) });
    return -1;
  }
}

/**
 * Read the current HEAD SHA of a remote branch via the GitHub API.
 * Returns null on lookup failure so callers can decide how to react —
 * a transient gh error should not be conflated with a real "branch unchanged"
 * signal.
 */
export function getRemoteBranchSha(
  repo: string,
  branch: string,
  cwd: string,
  logger: Logger,
): string | null {
  try {
    const sha = gh([
      "api",
      `repos/${repo}/branches/${encodeURIComponent(branch)}`,
      "--jq", ".commit.sha",
    ], cwd);
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch (err) {
    logger.warn("getRemoteBranchSha: gh api failed", { ...formatGhError(err), repo, branch });
    return null;
  }
}

// --- Branch Sync ---

export interface BranchDrift {
  developBehindMain: number;
  developAheadOfMain: number;
  /** Files differing between main and develop. Zero means merge-commit-only drift. */
  developAheadFiles: number;
}

/**
 * Check if develop has drifted behind main due to accumulated merge commits.
 * Returns the drift counts, or null if the check fails.
 */
export function checkBranchDrift(
  repo: string,
  cwd: string,
  logger: Logger,
): BranchDrift | null {
  try {
    const json = gh([
      "api", `repos/${repo}/compare/main...develop`,
      "--jq", '{"ahead": .ahead_by, "behind": .behind_by, "files": ((.files // []) | length)}',
    ], cwd);

    const result = JSON.parse(json);
    return {
      developAheadOfMain: result.ahead,
      developBehindMain: result.behind,
      // Changed files between main and develop. `ahead > 0 && files === 0` is the
      // NORMAL steady state, not a stall: the main -> develop sync PR leaves a
      // merge commit on develop that main does not have, carrying no file change.
      // Counting commits alone flags every repo, forever. GitHub truncates this
      // array on very large diffs but never empties it, so 0 really means 0.
      developAheadFiles: result.files ?? 0,
    };
  } catch (err) {
    logger.error("Failed to check branch drift", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Check if a sync PR (main → develop) already exists.
 */
export function findOpenSyncPR(
  repo: string,
  cwd: string,
  logger?: Logger,
): OpenPromotionPR | null {
  try {
    const prs: OpenPromotionPR[] = findOpenPrs(repo, cwd, { base: "develop", head: "main", limit: 1 });
    return prs.length > 0 ? prs[0] : null;
  } catch (err) {
    logger?.warn("findOpenSyncPR: gh pr list failed", { ...formatGhError(err) });
    return null;
  }
}

/**
 * Create a sync PR to merge main back into develop, then immediately
 * approve + merge it. Created as slashbin-foreman (Foreman token), approved
 * and merged as slashbin-engineering-manager (EM token) to satisfy
 * branch protection's "no self-approval" rule.
 *
 * This eliminates the stale sync PR race condition where develop
 * advances between PR creation and external merge.
 */
export function createSyncPR(
  repo: string,
  behindBy: number,
  cwd: string,
  logger?: Logger,
): string | null {
  try {
    const result = gh([
      "pr", "create",
      "--repo", repo,
      "--base", "develop",
      "--head", "main",
      "--title", "chore: sync develop with main (merge commits backfill)",
      "--body", `## Branch Sync\n\nSync \`develop\` with \`main\` to backfill ${behindBy} merge commit(s) from prior promotions. No code changes — only merge commit history alignment.\n\n---\nAutomated by slashbin-ai-agent`,
    ], cwd);

    const match = result.match(/https:\/\/github\.com\/[^\s]+/);
    const prUrl = match ? match[0] : null;

    if (!prUrl) return null;

    // Extract PR number from URL
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    if (!prNumberMatch) return prUrl;

    const prNumber = prNumberMatch[1];

    // Immediately approve + merge using the EM token
    try {
      ghAsEM([
        "pr", "review", prNumber,
        "--repo", repo,
        "--approve",
        "--body", "Automated sync — approved by EM.",
      ], cwd);

      ghAsEM([
        "pr", "merge", prNumber,
        "--repo", repo,
        "--merge",
      ], cwd);

      logger?.info(`Sync PR #${prNumber} created and merged immediately`);
    } catch (mergeErr) {
      // Expected on any repo with required status checks: the merge is attempted
      // seconds after creation, while build/test/typecheck are still IN_PROGRESS,
      // so branch protection refuses it. Not fatal — `tryMergeSyncPR` retries on a
      // later cycle once the checks land. See its comment for why that retry is
      // load-bearing rather than cosmetic.
      logger?.warn(`Sync PR #${prNumber} created but immediate auto-merge failed (will retry next cycle): ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`);
    }

    return prUrl;
  } catch (err) {
    logger?.warn("createSyncPR: gh pr create failed", { ...formatGhError(err), repo, behindBy });
    return null;
  }
}

/**
 * Merge an already-open sync PR. Returns true only if it is merged afterwards.
 *
 * WHY THIS EXISTS (2026-07-30). `createSyncPR` approves and merges the instant it
 * creates the PR — seconds later, while required status checks are still
 * IN_PROGRESS. On any repo with branch protection that merge is refused. The old
 * code caught that, said "the PR still exists for manual merge", and moved on;
 * the caller then logged "Sync PR created and auto-merged" regardless, and on
 * every later cycle logged "Sync PR already open" and returned early WITHOUT ever
 * retrying. So the merge never happened, the log claimed it had, and the sync PR
 * stayed open forever.
 *
 * That is not cosmetic. `develop` stays behind `main`, which makes the next
 * promotion PR `BEHIND`, which branch protection refuses to merge. Observed on
 * `Slashbin-console#779`: open 2h48m across ~140 no-op cycles, blocking the
 * promotion of #782 until it was merged by hand. The same "created and
 * auto-merged" line had already been logged for #438, #559 and #783.
 *
 * Idempotent by construction: re-approving an approved PR and merging a merged
 * PR are both no-ops we treat as success, so retrying every cycle is safe.
 */
export function tryMergeSyncPR(
  repo: string,
  prNumber: number,
  cwd: string,
  logger?: Logger,
): boolean {
  try {
    // Re-approve defensively: on the retry path the original approval is already
    // there, and gh treats a repeat approval as a no-op.
    try {
      ghAsEM([
        "pr", "review", String(prNumber),
        "--repo", repo,
        "--approve",
        "--body", "Automated sync — approved by EM.",
      ], cwd);
    } catch {
      // Already approved, or approval not required. Not a reason to skip the merge.
    }

    ghAsEM([
      "pr", "merge", String(prNumber),
      "--repo", repo,
      "--merge",
    ], cwd);
    return true;
  } catch (err) {
    // Still blocked (checks pending, conflict, protection). Report at debug so a
    // normal cycle isn't noisy — the caller reports the durable state.
    logger?.debug(`Sync PR #${prNumber} not mergeable yet: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// --- Dependency PRs (Dependabot) ---

/**
 * Open Dependabot PRs into `base`, and nothing else.
 *
 * Dependabot PRs never carry a linked issue, so the review phase cannot see
 * them: it is scoped to `features → develop` PRs and every step after the merge
 * (labelling, follow-up filing, the outcome trailer) is expressed in terms of an
 * issue. Rather than widen the skill that reviews and merges ALL feature work —
 * the highest-blast-radius thing here — these get their own mechanical path,
 * shaped exactly like the `main → develop` sync merge above: a narrow rule, no
 * agent, no issue.
 *
 * **The head-branch test is the safety property, not the label.** Dependabot
 * labels its PRs `dependencies` by default, but a label is something any account
 * can apply; `dependabot/*` is a branch only Dependabot writes. Selecting on the
 * branch means a mislabelled human PR can never be swept into an unreviewed
 * merge.
 */
export function findDependencyPRs(
  repo: string,
  cwd: string,
  base: string,
  logger?: Logger,
): PrSnapshot[] {
  try {
    return getOpenPrs(repo, cwd).filter(
      (p) => p.baseRefName === base && p.headRefName.startsWith("dependabot/"),
    );
  } catch (err) {
    logger?.warn("findDependencyPRs: gh pr list failed", { ...formatGhError(err), repo, base });
    return [];
  }
}

/**
 * Merge one Dependabot PR, but only once every check has CONCLUDED successfully.
 *
 * Deliberately stricter than `tryMergeSyncPR`, which merges whatever branch
 * protection permits. A sync PR carries content that is already on `main` — it
 * has been reviewed and deployed. A dependency bump has been reviewed by nobody,
 * so the build and test suite are the entire review, and a merge while they are
 * still running would be a merge on no evidence at all.
 *
 * The gate therefore refuses on ANY check that is not a concluded success:
 * pending, queued, failed and cancelled all mean "not yet proven". `SKIPPED` and
 * `NEUTRAL` pass, because a skipped job made no claim either way.
 *
 * Returns false and stays quiet on anything unmergeable, so the caller can retry
 * every cycle without noise — the same idempotent-retry shape as the sync path.
 */
export function tryMergeDependencyPR(
  repo: string,
  prNumber: number,
  cwd: string,
  logger?: Logger,
): boolean {
  interface CheckRun { status?: string; conclusion?: string; name?: string }
  let view: { mergeable?: string; baseRefName?: string; headRefName?: string; statusCheckRollup?: CheckRun[] };
  try {
    view = JSON.parse(
      gh([
        "pr", "view", String(prNumber),
        "--repo", repo,
        "--json", "mergeable,baseRefName,headRefName,statusCheckRollup",
      ], cwd) || "{}",
    );
  } catch (err) {
    logger?.debug(`Dependency PR #${prNumber}: could not read state: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  // Re-assert both invariants against the PR itself rather than trusting the
  // list that selected it. A base that is not the development branch is the one
  // outcome this must never produce.
  if (!view.headRefName?.startsWith("dependabot/")) {
    logger?.warn(`Dependency PR #${prNumber} is not a dependabot branch (${view.headRefName}) — refusing`);
    return false;
  }

  const checks = view.statusCheckRollup ?? [];
  const unfinished = checks.filter((c) => (c.status ?? "").toUpperCase() !== "COMPLETED");
  if (unfinished.length > 0) {
    logger?.debug(`Dependency PR #${prNumber}: ${unfinished.length} check(s) still running`);
    return false;
  }
  const passing = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
  const failed = checks.filter((c) => !passing.has((c.conclusion ?? "").toUpperCase()));
  if (failed.length > 0) {
    logger?.info(
      `Dependency PR #${prNumber} has failing check(s): ${failed.map((c) => `${c.name}=${c.conclusion}`).join(", ")} — leaving it open for a human`,
    );
    return false;
  }
  if (checks.length === 0) {
    logger?.info(`Dependency PR #${prNumber} has no checks at all — refusing to merge on no evidence`);
    return false;
  }

  try {
    try {
      ghAsEM([
        "pr", "review", String(prNumber),
        "--repo", repo,
        "--approve",
        "--body", `Automated dependency update — every check concluded successfully (${checks.length} check(s)). Merged to \`${view.baseRefName}\` by the Foreman; it reaches production only through the normal promotion gate.`,
      ], cwd);
    } catch {
      // Already approved, or approval not required.
    }
    ghAsEM(["pr", "merge", String(prNumber), "--repo", repo, "--merge"], cwd);
    return true;
  } catch (err) {
    logger?.debug(`Dependency PR #${prNumber} not mergeable yet: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// --- PR Verification ---

export function verifyPRExists(
  repo: string,
  headBranch: string,
  baseBranch: string,
  cwd: string,
  logger?: Logger,
): boolean {
  try {
    const prs = findOpenPrs(repo, cwd, { head: headBranch, base: baseBranch, limit: 1 });
    return prs.length > 0;
  } catch (err) {
    logger?.warn("verifyPRExists: gh pr list failed", { ...formatGhError(err), repo, headBranch, baseBranch });
    return false;
  }
}

/**
 * Read the open feature PR's body + title + commit messages and extract every
 * issue number referenced via standard GitHub keywords ("Related to #N",
 * "Closes #N", "Fixes #N", "Resolves #N", "Refs #N", "See #N"). Used by the
 * orchestrator to know which subset of `actionableIssues` the implementation
 * skill actually addressed — under the canonical one-issue-per-invocation
 * skill (jerky_data_receiver#43 and friends), the skill picks one issue from a
 * batch but the orchestrator must NOT label the unpicked issues as
 * "pr under review", or they get stuck waiting forever for revision activity.
 *
 * Returns the parsed issue numbers (deduped). On lookup or parse failure
 * returns null so callers can fall back to existing behavior rather than
 * silently dropping issues from the label transition.
 */
export function getReferencedIssuesFromOpenPR(
  repo: string,
  headBranch: string,
  baseBranch: string,
  cwd: string,
  logger?: Logger,
): number[] | null {
  try {
    const json = gh([
      "pr", "list",
      "--repo", repo,
      "--head", headBranch,
      "--base", baseBranch,
      "--state", "open",
      "--json", "number,title,body,commits",
      "--limit", "1",
    ], cwd);
    const prs = JSON.parse(json || "[]");
    if (prs.length === 0) return null;
    const pr = prs[0];

    // Count an issue as referenced only if the PR IMPLEMENTS it (close/relate
    // keyword anywhere, or `(#N)` in the title / a commit headline) — never a
    // bare `(#N)` mention in the free-text body. A schema PR whose body said
    // "the forthcoming handler (#2) will..." otherwise falsely marked #2
    // implemented, orphaning it. (slashbin-ai-foreman#28)
    const commits = (pr.commits || []) as { messageHeadline?: string; messageBody?: string }[];
    return extractImplementedIssues({
      title: pr.title || "",
      body: pr.body || "",
      commitHeadlines: commits.map((c) => c.messageHeadline || ""),
      commitBodies: commits.map((c) => c.messageBody || ""),
    });
  } catch (err) {
    logger?.warn("getReferencedIssuesFromOpenPR: gh pr list failed", { ...formatGhError(err), repo, headBranch, baseBranch });
    return null;
  }
}

