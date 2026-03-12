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
