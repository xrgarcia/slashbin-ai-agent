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
 * Gate check: are there any approved issues that haven't progressed through
 * the lifecycle AND don't already have a PR? The skill handles full inventory
 * — this just tells the Foreman whether to trigger it.
 */
export function hasApprovedIssues(
  config: RepoConfig,
  logger: Logger
): boolean {
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

    if (actionable.length === 0) return false;

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
      if (!prText.includes(`#${issueNum}`)) {
        uncovered.push(issueNum);
      }
    }

    if (uncovered.length > 0) {
      logger.info(`Found ${uncovered.length} actionable issue(s) with no linked PR: ${uncovered.map(n => `#${n}`).join(", ")}`);
      return true;
    }

    logger.info(`Skipped ${repo}: ${actionable.length} approved issue(s), all have linked PRs (open or merged)`);
    return false;
  } catch (err) {
    logger.error("Failed to check for approved issues", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
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

