import { execFileSync } from "node:child_process";
import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";

interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  url: string;
}

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
  return runGh(args, cwd, foremanToken);
}

/** Run gh CLI using the EM token (slashbin-engineering-manager account). */
function ghAsEM(args: string[], cwd: string): string {
  const emToken = process.env.EM_GITHUB_TOKEN;
  if (!emToken) throw new Error("EM_GITHUB_TOKEN not set — cannot approve/merge as EM");
  return runGh(args, cwd, emToken);
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
    const json = gh([
      "issue", "list",
      "--repo", repo,
      "--state", "open",
      "--label", config.triggerLabel,
      "--json", "number,labels",
      "--limit", "100",
    ], config.repoPath);
    const issues: GhIssue[] = JSON.parse(json || "[]");

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
    const json = gh([
      "issue", "list",
      "--repo", repo,
      "--state", "open",
      "--label", config.triggerLabel,
      "--json", "number,labels",
      "--limit", "100",
    ], config.repoPath);

    const issues: GhIssue[] = JSON.parse(json || "[]");

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
    const openPrJson = gh([
      "pr", "list",
      "--repo", repo,
      "--state", "open",
      "--base", config.baseBranch,
      "--json", "number,title,body",
      "--limit", "50",
    ], config.repoPath);

    const mergedPrJson = gh([
      "pr", "list",
      "--repo", repo,
      "--state", "merged",
      "--base", config.baseBranch,
      "--json", "number,title,body",
      "--limit", "20",
    ], config.repoPath);

    const openPrs: { number: number; title: string; body: string }[] = JSON.parse(openPrJson || "[]");
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
    const issueJson = gh([
      "issue", "list",
      "--repo", config.githubRepo,
      "--state", "open",
      "--label", "pr pending actions",
      "--label", config.triggerLabel,
      "--json", "number,title",
      "--limit", "100",
    ], config.repoPath);

    const issues: { number: number; title: string }[] = JSON.parse(issueJson || "[]");
    if (issues.length === 0) return null;

    // Confirm there's an open feature PR (features → develop)
    const prJson = gh([
      "pr", "list",
      "--repo", config.githubRepo,
      "--state", "open",
      "--head", config.featureBranch,
      "--base", config.baseBranch,
      "--json", "number,url,headRefName",
      "--limit", "1",
    ], config.repoPath);

    const prs: PendingRevisionPR[] = JSON.parse(prJson || "[]");
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
    const issueJson = gh([
      "issue", "list",
      "--repo", config.githubRepo,
      "--state", "open",
      "--label", "pr under review",
      "--json", "number,labels",
      "--limit", "100",
    ], config.repoPath);

    const issues: { number: number; labels: { name: string }[] }[] = JSON.parse(issueJson || "[]");
    // Exclude issues also labeled `pr pending actions` — the revise phase owns those.
    const reviewable = issues.filter((i) => !i.labels.some((l) => l.name === "pr pending actions"));
    if (reviewable.length === 0) {
      return adoptOrphanedReviewCandidate(config, reviewerLogin, logger);
    }

    // Confirm an open feature PR exists (features → develop).
    const prJson = gh([
      "pr", "list",
      "--repo", config.githubRepo,
      "--state", "open",
      "--head", config.featureBranch,
      "--base", config.baseBranch,
      "--json", "number,url",
      "--limit", "1",
    ], config.repoPath);

    const prs: { number: number; url: string }[] = JSON.parse(prJson || "[]");
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
  const prJson = gh([
    "pr", "list",
    "--repo", config.githubRepo,
    "--state", "open",
    "--head", config.featureBranch,
    "--base", config.baseBranch,
    "--json", "number,url,title,body",
    "--limit", "1",
  ], config.repoPath);

  const prs: { number: number; url: string; title: string; body: string }[] = JSON.parse(prJson || "[]");
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
 * DETECTION ONLY — never mutates labels. Auto-advancing on a re-verify would risk
 * rubber-stamping a genuine regression (a post-merge FAIL is supposed to HOLD);
 * the safe recovery is to make the stuck state visible, not invisible.
 *
 * Conservative by design (returns [] on any ambiguity):
 *  - skips main-only repos (no features→develop lifecycle)
 *  - ignores issues also labeled `pr pending actions` (revise owns) or
 *    `ready for prod release` (already advanced)
 *  - ignores repos with an OPEN feature PR (normal review-pending; tryReview owns it)
 *  - only flags PRs merged more than STUCK_MERGE_GRACE_MS ago (no flap on fresh merges)
 */
export function findStuckMergedIssues(
  config: RepoConfig,
  logger: Logger,
): StuckMergedIssue[] {
  if (config.baseBranch === config.featureBranch) return [];
  try {
    const issueJson = gh([
      "issue", "list",
      "--repo", config.githubRepo,
      "--state", "open",
      "--label", "pr under review",
      "--json", "number,labels",
      "--limit", "100",
    ], config.repoPath);
    const issues: { number: number; labels: { name: string }[] }[] = JSON.parse(issueJson || "[]");
    const candidates = issues.filter(
      (i) => !i.labels.some(
        (l) => l.name === "pr pending actions" || l.name === "pr approved" || l.name === "ready for prod release",
      ),
    );
    if (candidates.length === 0) return [];

    // An OPEN feature PR means these are normal review-pending — tryReview owns them.
    const openJson = gh([
      "pr", "list",
      "--repo", config.githubRepo,
      "--state", "open",
      "--head", config.featureBranch,
      "--base", config.baseBranch,
      "--json", "number",
      "--limit", "1",
    ], config.repoPath);
    if ((JSON.parse(openJson || "[]") as unknown[]).length > 0) return [];

    // Resolve merged work via the SHARED strict primitive — not a bare `#N` scan.
    // A bare-`#N` match would false-positive on an incidental prose mention
    // (slashbin-ai-foreman#28), flagging issues that were never actually merged.
    const merged = findIssuesMergedToBase(
      config,
      candidates.map((i) => i.number),
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
    const json = gh([
      "issue", "list",
      "--repo", repo,
      "--state", "open",
      "--label", "ready for prod release",
      "--json", "number,title",
      "--limit", "100",
    ], cwd);

    return JSON.parse(json || "[]");
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
    const json = gh([
      "pr", "list",
      "--repo", repo,
      "--state", "open",
      "--base", baseBranch,
      "--head", "develop",
      "--json", "number,url,body",
      "--limit", "1",
    ], cwd);

    const prs: OpenPromotionPR[] = JSON.parse(json || "[]");
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
      "--jq", '{"ahead": .ahead_by, "behind": .behind_by}',
    ], cwd);

    const result = JSON.parse(json);
    return {
      developAheadOfMain: result.ahead,
      developBehindMain: result.behind,
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
    const json = gh([
      "pr", "list",
      "--repo", repo,
      "--state", "open",
      "--base", "develop",
      "--head", "main",
      "--json", "number,url",
      "--limit", "1",
    ], cwd);

    const prs: OpenPromotionPR[] = JSON.parse(json || "[]");
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
      // If merge fails (status checks, conflicts), log but don't crash.
      // The PR still exists for manual merge.
      logger?.warn(`Sync PR #${prNumber} created but auto-merge failed: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`);
    }

    return prUrl;
  } catch (err) {
    logger?.warn("createSyncPR: gh pr create failed", { ...formatGhError(err), repo, behindBy });
    return null;
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
    const json = gh([
      "pr", "list",
      "--repo", repo,
      "--head", headBranch,
      "--base", baseBranch,
      "--state", "open",
      "--json", "number",
      "--limit", "1",
    ], cwd);
    const prs = JSON.parse(json || "[]");
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

