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

export function gh(args: string[], cwd: string): string {
  return execFileSync("gh", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
}

/**
 * Gate check: find approved issues that haven't progressed through
 * the lifecycle AND don't already have a PR. Returns the uncovered
 * issue numbers (capped to MAX_BATCH_SIZE), or empty array if none.
 */
const MAX_BATCH_SIZE = 3;

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
    const prText = allPrs.map((pr) => `${pr.title} ${pr.body}`).join(" ");

    const uncovered: number[] = [];
    for (const issueNum of actionable) {
      // Use word boundary to avoid #1 matching #10, #100, etc.
      const pattern = new RegExp(`#${issueNum}(?!\\d)`);
      if (!pattern.test(prText)) {
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

/**
 * Gate check: are there any open PRs with "pr pending actions" label?
 * These are PRs where the reviewer requested changes and the Foreman
 * needs to revise the code.
 */
export function hasPendingRevisions(
  config: RepoConfig,
  logger: Logger
): boolean {
  try {
    const json = gh([
      "pr", "list",
      "--repo", config.githubRepo,
      "--state", "open",
      "--label", "pr pending actions",
      "--json", "number,url,headRefName",
      "--limit", "100",
    ], config.repoPath);

    const prs: PendingRevisionPR[] = JSON.parse(json || "[]");
    if (prs.length > 0) {
      logger.debug(`Found ${prs.length} PR(s) pending revision`);
      return true;
    }
    return false;
  } catch (err) {
    logger.error("Failed to check for pending revisions", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
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
}

export function findOpenPromotionPR(
  repo: string,
  baseBranch: string,
  cwd: string,
): OpenPromotionPR | null {
  try {
    const json = gh([
      "pr", "list",
      "--repo", repo,
      "--state", "open",
      "--base", baseBranch,
      "--head", "develop",
      "--json", "number,url",
      "--limit", "1",
    ], cwd);

    const prs: OpenPromotionPR[] = JSON.parse(json || "[]");
    return prs.length > 0 ? prs[0] : null;
  } catch {
    return null;
  }
}

export function createPromotionPR(
  repo: string,
  baseBranch: string,
  issues: PromotionIssue[],
  cwd: string,
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
  } catch {
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
  } catch {
    return -1;
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
  } catch {
    return null;
  }
}

/**
 * Create a sync PR to merge main back into develop.
 * This resolves merge commit drift that prevents promotion PRs.
 */
export function createSyncPR(
  repo: string,
  behindBy: number,
  cwd: string,
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
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

// --- PR Verification ---

export function verifyPRExists(
  repo: string,
  headBranch: string,
  baseBranch: string,
  cwd: string,
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
  } catch {
    return false;
  }
}

