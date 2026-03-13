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

      // Skip issues already progressed through lifecycle
      const lifecycleLabels = [
        "pr under review",
        "pr approved",
        "pr pending actions",
        "ready for prod release",
        "ready to close",
      ];
      if (lifecycleLabels.some((l) => labels.includes(l))) {
        logger.debug(`Skipping #${issue.number} — has lifecycle label`);
        continue;
      }

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

    // Sort oldest first (lowest issue number first)
    actionable.sort((a, b) => a.number - b.number);

    return actionable;
  } catch (err) {
    logger.error("Failed to poll GitHub issues", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
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

// --- Linked PR Check ---

function checkForLinkedPR(
  repo: string,
  issueNumber: number,
  cwd: string,
  logger: Logger
): boolean {
  try {
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
