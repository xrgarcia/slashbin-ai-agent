import { execFileSync } from "node:child_process";
import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { gh, verifyPRExists } from "./github.js";

export interface ReconciliationResult {
  reconciled: boolean;
  prUrl?: string;
  issueNumbers: number[];
  commitCount: number;
  error?: string;
}

interface OrphanedCommit {
  hash: string;
  message: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
}

/**
 * List remote branches matching the feature branch prefix.
 * Feature branches are named `features-*`, not a single `features` ref.
 */
function getRemoteFeatureBranches(
  repoPath: string,
  featureBranchPrefix: string,
): string[] {
  try {
    const output = git(
      ["branch", "-r", "--list", `origin/${featureBranchPrefix}*`],
      repoPath,
    );
    if (!output) return [];
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.includes("->"))
      .map((ref) => ref.replace(/^origin\//, ""));
  } catch {
    return [];
  }
}


function extractIssueNumbers(commits: OrphanedCommit[]): number[] {
  const issueNums = new Set<number>();
  for (const commit of commits) {
    const matches = commit.message.matchAll(/#(\d+)/g);
    for (const match of matches) {
      issueNums.add(Number(match[1]));
    }
  }
  return [...issueNums].sort((a, b) => a - b);
}

function hasOpenPR(
  githubRepo: string,
  featureBranch: string,
  baseBranch: string,
  cwd: string,
): { number: number; url: string } | null {
  try {
    const json = gh([
      "pr", "list",
      "--repo", githubRepo,
      "--head", featureBranch,
      "--base", baseBranch,
      "--state", "open",
      "--json", "number,url",
      "--limit", "1",
    ], cwd);
    const prs: { number: number; url: string }[] = JSON.parse(json || "[]");
    return prs.length > 0 ? prs[0] : null;
  } catch {
    return null;
  }
}

function createReconciliationPR(
  config: RepoConfig,
  headBranch: string,
  issueNumbers: number[],
  commitCount: number,
  logger: Logger,
): string | null {
  const issueList = issueNumbers.length > 0
    ? issueNumbers.map((n) => `- Related to #${n}`).join("\n")
    : "_No linked issues found in commit messages_";

  const title = issueNumbers.length === 1
    ? `feat: implement #${issueNumbers[0]}`
    : `feat: implement ${commitCount} change(s) from ${headBranch}`;

  const body = `## Feature PR (Reconciled)

This PR was created automatically by Foreman's reconciliation phase.
Orphaned commits were found on \`${headBranch}\` with no open PR targeting \`${config.baseBranch}\`.

### Linked Issues
${issueList}

### Commits
${commitCount} commit(s) on \`${headBranch}\` ahead of \`${config.baseBranch}\`

---
_Automated by slashbin-ai-agent (reconciler)_`;

  try {
    const result = gh([
      "pr", "create",
      "--repo", config.githubRepo,
      "--base", config.baseBranch,
      "--head", headBranch,
      "--title", title,
      "--body", body,
    ], config.repoPath);

    const match = result.match(/https:\/\/github\.com\/[^\s]+/);
    return match ? match[0] : null;
  } catch (err) {
    logger.error("Failed to create reconciliation PR", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function reconcileRepo(
  config: RepoConfig,
  logger: Logger,
): ReconciliationResult {
  // Skip main-only repos (like docs site)
  if (config.baseBranch === config.featureBranch) {
    return { reconciled: false, issueNumbers: [], commitCount: 0 };
  }

  // Fetch all refs first
  try {
    git(["fetch", "origin"], config.repoPath);
  } catch (err) {
    logger.warn("git fetch failed, skipping reconciliation", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { reconciled: false, issueNumbers: [], commitCount: 0 };
  }

  // Discover feature branches matching the prefix pattern
  const featureBranches = getRemoteFeatureBranches(config.repoPath, config.featureBranch);
  if (featureBranches.length === 0) {
    return { reconciled: false, issueNumbers: [], commitCount: 0 };
  }

  // Check each feature branch for orphaned commits (commits ahead of base with no PR)
  for (const branch of featureBranches) {
    let commits: OrphanedCommit[];
    try {
      const log = git(
        ["log", `origin/${config.baseBranch}..origin/${branch}`, "--format=%H %s"],
        config.repoPath,
      );
      if (!log) continue;
      commits = log.split("\n").map((line) => {
        const spaceIdx = line.indexOf(" ");
        return { hash: line.slice(0, spaceIdx), message: line.slice(spaceIdx + 1) };
      });
    } catch {
      continue;
    }

    if (commits.length === 0) continue;

    logger.info(`Found ${commits.length} commit(s) on ${branch} ahead of ${config.baseBranch}`);

    // Check if PR already exists for this specific branch
    const existingPR = hasOpenPR(config.githubRepo, branch, config.baseBranch, config.repoPath);
    if (existingPR) {
      logger.debug(`PR already exists for ${branch}: #${existingPR.number} — no reconciliation needed`);
      continue;
    }

    // Extract issue numbers and create a PR for this branch
    const issueNumbers = extractIssueNumbers(commits);
    logger.info(`Extracted issue numbers from ${branch}: ${issueNumbers.join(", ") || "none"}`);

    const prUrl = createReconciliationPR(config, branch, issueNumbers, commits.length, logger);
    if (!prUrl) {
      return {
        reconciled: false, issueNumbers, commitCount: commits.length,
        error: `Failed to create reconciliation PR for ${branch}`,
      };
    }

    const verified = verifyPRExists(config.githubRepo, branch, config.baseBranch, config.repoPath);
    if (!verified) {
      logger.warn("PR URL returned but verification failed — PR may not exist");
      return {
        reconciled: false, issueNumbers, commitCount: commits.length,
        error: "PR creation could not be verified",
      };
    }

    logger.info(`Reconciliation PR created and verified: ${prUrl}`);
    return { reconciled: true, prUrl, issueNumbers, commitCount: commits.length };
  }

  return { reconciled: false, issueNumbers: [], commitCount: 0 };
}
