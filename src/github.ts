import { execFileSync } from "node:child_process";
import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";

export interface ActionableIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url: string;
}

interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  url: string;
}

function gh(args: string[], cwd: string): string {
  return execFileSync("gh", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
}

export async function findActionableIssues(
  config: RepoConfig,
  logger: Logger
): Promise<ActionableIssue[]> {
  const repo = config.githubRepo;

  try {
    const json = gh([
      "issue", "list",
      "--repo", repo,
      "--state", "open",
      "--label", config.triggerLabel,
      "--json", "number,title,body,labels,url",
      "--limit", "100",
    ], config.repoPath);

    const issues: GhIssue[] = JSON.parse(json || "[]");
    const actionable: ActionableIssue[] = [];

    for (const issue of issues) {
      const labels = issue.labels.map((l) => l.name);

      // Skip blocked issues
      if (labels.includes("blocked")) continue;

      // Check for linked open PRs
      const hasLinkedPR = checkForLinkedPR(repo, issue.number, config.repoPath, logger);
      if (hasLinkedPR) {
        logger.debug(`Skipping #${issue.number} — has linked PR`);
        continue;
      }

      actionable.push({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        labels,
        url: issue.url,
      });
    }

    // Sort oldest first (highest issue number = newest, so sort ascending)
    actionable.sort((a, b) => a.number - b.number);

    return actionable;
  } catch (err) {
    logger.error("Failed to poll GitHub issues", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// --- PR Review Polling ---

export interface PRReviewFeedback {
  prNumber: number;
  reviews: Array<{ id: number; state: string; body: string; user: string }>;
  comments: Array<{ id: number; body: string; user: string }>;
}

interface GhReview {
  id: number;
  state: string;
  body: string;
  author: { login: string };
}

interface GhComment {
  id: number;
  body: string;
  author: { login: string };
}

export function getGhUser(cwd: string): string {
  try {
    const json = gh(["api", "user", "--jq", ".login"], cwd);
    return json;
  } catch {
    return "";
  }
}

export function findPRsNeedingRevision(
  repo: string,
  trackedPRNumbers: number[],
  lastAddressedIds: Map<number, { reviewId: number; commentId: number }>,
  cwd: string,
  logger: Logger
): PRReviewFeedback[] {
  if (trackedPRNumbers.length === 0) return [];

  const ghUser = getGhUser(cwd);
  const results: PRReviewFeedback[] = [];

  for (const prNumber of trackedPRNumbers) {
    try {
      // Get reviews
      const reviewsJson = gh([
        "api", `repos/${repo}/pulls/${prNumber}/reviews`,
        "--jq", "[.[] | {id: .id, state: .state, body: .body, author: {login: .user.login}}]",
      ], cwd);
      const allReviews: GhReview[] = JSON.parse(reviewsJson || "[]");

      // Get comments
      const commentsJson = gh([
        "pr", "view", String(prNumber),
        "--repo", repo,
        "--json", "comments",
      ], cwd);
      const parsed = JSON.parse(commentsJson || '{"comments":[]}');
      const allComments: GhComment[] = parsed.comments ?? [];

      const lastIds = lastAddressedIds.get(prNumber) ?? { reviewId: 0, commentId: 0 };

      // Filter to new reviews (not from self, newer than last addressed)
      const newReviews = allReviews
        .filter((r) => r.id > lastIds.reviewId)
        .filter((r) => r.author.login !== ghUser)
        .map((r) => ({ id: r.id, state: r.state, body: r.body, user: r.author.login }));

      // Filter to new comments (not from self, newer than last addressed)
      const newComments = allComments
        .filter((c) => c.id > lastIds.commentId)
        .filter((c) => c.author.login !== ghUser)
        .map((c) => ({ id: c.id, body: c.body, user: c.author.login }));

      // Only include if there's actionable feedback
      const hasChangesRequested = newReviews.some((r) => r.state === "CHANGES_REQUESTED");
      const hasNewComments = newComments.length > 0;

      if (hasChangesRequested || hasNewComments) {
        results.push({ prNumber, reviews: newReviews, comments: newComments });
      }
    } catch (err) {
      logger.debug(`Failed to check reviews for PR #${prNumber}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

export function commentOnPR(repo: string, prNumber: number, body: string, cwd: string): void {
  gh(["pr", "comment", String(prNumber), "--repo", repo, "--body", body], cwd);
}

export function getPRDiff(repo: string, prNumber: number, cwd: string): string {
  try {
    return gh(["pr", "diff", String(prNumber), "--repo", repo], cwd);
  } catch {
    return "";
  }
}

export function isPRApproved(repo: string, prNumber: number, cwd: string): boolean {
  try {
    const json = gh([
      "pr", "view", String(prNumber),
      "--repo", repo,
      "--json", "reviewDecision",
    ], cwd);
    const parsed = JSON.parse(json || "{}");
    return parsed.reviewDecision === "APPROVED";
  } catch {
    return false;
  }
}

export function isPROpen(repo: string, prNumber: number, cwd: string): boolean {
  try {
    const json = gh([
      "pr", "view", String(prNumber),
      "--repo", repo,
      "--json", "state",
    ], cwd);
    const parsed = JSON.parse(json || "{}");
    return parsed.state === "OPEN";
  } catch {
    return false;
  }
}

// --- Issue Polling (existing) ---

function checkForLinkedPR(
  repo: string,
  issueNumber: number,
  cwd: string,
  logger: Logger
): boolean {
  try {
    // Search for open PRs that mention this issue
    const json = gh([
      "pr", "list",
      "--repo", repo,
      "--state", "open",
      "--search", `${issueNumber} in:body`,
      "--json", "number",
      "--limit", "5",
    ], cwd);

    const prs = JSON.parse(json || "[]");
    return prs.length > 0;
  } catch (err) {
    logger.debug(`Failed to check PRs for #${issueNumber}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
