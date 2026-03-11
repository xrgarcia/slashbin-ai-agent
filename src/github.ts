import { Octokit } from "@octokit/rest";
import type { AgentConfig } from "./config.js";
import type { Logger } from "./logger.js";

export interface ActionableIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url: string;
}

export async function findActionableIssues(
  config: AgentConfig,
  logger: Logger
): Promise<ActionableIssue[]> {
  const [owner, repo] = config.githubRepo!.split("/");
  const octokit = new Octokit({ auth: config.githubToken });

  try {
    // Paginate all open issues with trigger label
    const issues = await octokit.paginate(octokit.issues.listForRepo, {
      owner,
      repo,
      state: "open",
      labels: config.triggerLabel,
      per_page: 100,
    });

    // Check rate limit
    const rateLimit = await octokit.rateLimit.get();
    const remaining = rateLimit.data.rate.remaining;
    if (remaining < 100) {
      logger.warn("GitHub API rate limit low", { remaining });
    }

    const actionable: ActionableIssue[] = [];

    for (const issue of issues) {
      // Skip pull requests (GitHub API returns PRs as issues)
      if (issue.pull_request) continue;

      // Skip blocked issues
      const labels = issue.labels
        .map((l) => (typeof l === "string" ? l : l.name ?? ""))
        .filter(Boolean);
      if (labels.includes("blocked")) continue;

      // Check for linked PRs via timeline events
      const hasLinkedPR = await checkForLinkedPR(octokit, owner, repo, issue.number, logger);
      if (hasLinkedPR) {
        logger.debug(`Skipping #${issue.number} — has linked PR`);
        continue;
      }

      actionable.push({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        labels,
        url: issue.html_url,
      });
    }

    // Sort oldest first (FIFO)
    actionable.sort((a, b) => a.number - b.number);

    return actionable;
  } catch (err) {
    logger.error("Failed to poll GitHub issues", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function checkForLinkedPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  logger: Logger
): Promise<boolean> {
  try {
    const events = await octokit.paginate(octokit.issues.listEventsForTimeline, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });

    for (const event of events) {
      if (
        event.event === "cross-referenced" &&
        (event as Record<string, unknown>).source
      ) {
        const source = (event as Record<string, unknown>).source as Record<string, unknown>;
        const sourceIssue = source?.issue as Record<string, unknown> | undefined;
        if (sourceIssue?.pull_request) {
          // Check if PR is open (not closed/merged PRs)
          const prState = sourceIssue.state as string;
          if (prState === "open") return true;
        }
      }
    }
    return false;
  } catch (err) {
    logger.debug(`Failed to check timeline for #${issueNumber}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
