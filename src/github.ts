import { execFileSync } from "node:child_process";
import type { AgentConfig } from "./config.js";
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
  config: AgentConfig,
  logger: Logger
): Promise<ActionableIssue[]> {
  const repo = config.githubRepo!;

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
