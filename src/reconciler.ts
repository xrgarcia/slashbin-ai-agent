import { execFileSync } from "node:child_process";
import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { gh, verifyPRExists, transitionImplementationLabels } from "./github.js";

export interface ReconciliationResult {
  reconciled: boolean;
  prUrl?: string;
  issueNumbers: number[];
  commitCount: number;
  error?: string;
  /** Branches the reconciler refused to recreate a PR for — see `RejectedBranch`. */
  rejected?: RejectedBranch[];
}

/**
 * A feature branch carrying commits that were already rejected once.
 *
 * The reconciler's whole job is "commits are ahead of base with no open PR, so
 * make one" — and that is right for orphaned work. It is exactly wrong when the
 * missing PR is missing *because a human closed it unmerged*. Closing a PR is how
 * the EM says no; recreating it says no wasn't heard.
 */
export interface RejectedBranch {
  branch: string;
  /** The closed-unmerged PR whose rejection still stands. */
  prNumber: number;
  prUrl: string;
  /** Branch head — identical to the rejected PR's head, which is why this is a resurrection. */
  headSha: string;
  commitCount: number;
  issueNumbers: number[];
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
 * What actually went wrong with a `git` child process.
 *
 * `err.message` alone is `Command failed: git fetch origin` — true, and useless.
 * git puts the reason on stderr, which the helper captures and then nobody reads,
 * so a broken remote, an auth failure and a killed process all produce the same
 * sentence. Same defect class as the stderr-masking fixed in `ea60c9d`: a message
 * that reads as a cause and isn't.
 *
 * `signal` matters more than it looks. git runs in the service cgroup, so when
 * systemd stops the unit its SIGTERM reaches the child while the Foreman is still
 * draining. The fetch didn't fail — it was cancelled — and reporting that as a
 * WARN sent one investigation at the clone and the remote before the timestamps
 * ruled both out.
 */
interface GitFailure {
  error: string;
  stderr?: string;
  signal?: string;
  /** Killed by a shutdown signal rather than failing on its own merits. */
  cancelled: boolean;
}

function formatGitError(err: unknown): GitFailure {
  const e = err as { message?: string; stderr?: unknown; signal?: string | null };
  const stderr = typeof e?.stderr === "string"
    ? e.stderr.trim()
    : Buffer.isBuffer(e?.stderr)
      ? e.stderr.toString("utf-8").trim()
      : "";
  const signal = e?.signal ?? undefined;
  return {
    error: e?.message ?? String(err),
    ...(stderr ? { stderr } : {}),
    ...(signal ? { signal } : {}),
    cancelled: signal === "SIGTERM" || signal === "SIGINT",
  };
}

export interface LocalBranchDivergence {
  ahead: number;
  behind: number;
}

/**
 * Inspect divergence of a local branch ref vs `origin/<branch>` in a shared
 * Foreman working clone. Fetches the branch first to ensure origin refs are
 * current. Returns `null` if any git call fails (clone gone, network blip,
 * branch missing) — callers must treat null as "unknown, don't act."
 *
 * Used by the orchestrator's skip-cache filter to re-check whether a
 * previously-recorded "branch diverged" skip reason is still true. When EM
 * manually reconciles a polluted local features ref (force-align to origin),
 * the skip cache's 30-min back-off would otherwise pin the issue dead-zoned
 * for that whole window before auto-clearing.
 */
export function checkLocalBranchDivergence(
  repoPath: string,
  branch: string,
  logger: Logger,
): LocalBranchDivergence | null {
  try {
    git(["fetch", "origin", branch, "--quiet"], repoPath);
    const ahead = parseInt(
      git(["rev-list", "--count", `origin/${branch}..${branch}`], repoPath),
      10,
    );
    const behind = parseInt(
      git(["rev-list", "--count", `${branch}..origin/${branch}`], repoPath),
      10,
    );
    if (Number.isNaN(ahead) || Number.isNaN(behind)) return null;
    return { ahead, behind };
  } catch (err) {
    logger.warn("Local branch divergence check failed", {
      repoPath,
      branch,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
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

/**
 * The most recent CLOSED-UNMERGED PR for `featureBranch → baseBranch`, with the
 * head SHA it was closed at.
 *
 * `hasOpenPR` deliberately only sees open PRs, which is what lets a rejection
 * become invisible: the EM closes a PR unmerged, its commits stay on the shared
 * branch, and one cycle later the reconciler finds "commits ahead, no open PR"
 * and mints a fresh PR for the work that was just refused. Observed on
 * jerky_data_receiver (#72 rejected → #74 recreated it, bundled with new work).
 *
 * Merged PRs are excluded on purpose — a merged PR is a completed delivery, not a
 * refusal, and its commits being ahead of base again means something new happened.
 */
function findLastClosedUnmergedPR(
  githubRepo: string,
  featureBranch: string,
  baseBranch: string,
  cwd: string,
): { number: number; url: string; headSha: string } | null {
  try {
    const json = gh([
      "pr", "list",
      "--repo", githubRepo,
      "--head", featureBranch,
      "--base", baseBranch,
      "--state", "closed",
      "--json", "number,url,mergedAt,headRefOid,closedAt",
      "--limit", "20",
    ], cwd);
    const prs: {
      number: number; url: string;
      mergedAt: string | null; headRefOid: string; closedAt: string | null;
    }[] = JSON.parse(json || "[]");
    const unmerged = prs
      .filter((p) => !p.mergedAt && p.headRefOid)
      .sort((a, b) => String(b.closedAt ?? "").localeCompare(String(a.closedAt ?? "")));
    if (unmerged.length === 0) return null;
    const latest = unmerged[0];
    return { number: latest.number, url: latest.url, headSha: latest.headRefOid };
  } catch {
    // Unknown, not "no rejection" — the caller treats null as "no guard available"
    // and proceeds, which preserves the pre-guard behaviour on a gh failure.
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
    const failure = formatGitError(err);
    if (failure.cancelled) {
      // Shutdown, not a fault. The next start reconciles this repo normally.
      logger.info("Reconciliation cancelled — git fetch was interrupted by shutdown", {
        repo: config.name,
        signal: failure.signal,
      });
    } else {
      logger.warn("git fetch failed, skipping reconciliation", { repo: config.name, ...failure });
    }
    return { reconciled: false, issueNumbers: [], commitCount: 0 };
  }

  // Discover feature branches matching the prefix pattern
  const featureBranches = getRemoteFeatureBranches(config.repoPath, config.featureBranch);
  if (featureBranches.length === 0) {
    return { reconciled: false, issueNumbers: [], commitCount: 0 };
  }

  // Branches whose commits stand rejected. Collected rather than returned early:
  // one repo can have several feature branches and a rejection on one must not stop
  // legitimate reconciliation on another.
  const rejected: RejectedBranch[] = [];

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

    // Rejection guard: a PR is also "not open" when a human closed it unmerged.
    // If the branch has not moved since that rejection, recreating the PR would
    // re-propose the exact diff that was just refused.
    const lastRejected = findLastClosedUnmergedPR(
      config.githubRepo, branch, config.baseBranch, config.repoPath,
    );
    if (lastRejected) {
      const headSha = commits[0].hash; // git log lists newest first
      if (headSha === lastRejected.headSha) {
        logger.warn(
          `Not recreating a PR for ${branch} — its last PR (#${lastRejected.number}) was closed unmerged ` +
          `and the branch has not moved since. The rejected commits are still ahead of ${config.baseBranch}.`,
          { headSha, rejectedPR: lastRejected.url },
        );
        rejected.push({
          branch,
          prNumber: lastRejected.number,
          prUrl: lastRejected.url,
          headSha,
          commitCount: commits.length,
          issueNumbers: extractIssueNumbers(commits),
        });
        continue;
      }
      // Branch moved since the rejection: new work rides on top of rejected commits.
      // Reconciling is still correct — someone must see the PR — but the bundle is
      // not clean, and saying so is the difference between a review and a surprise.
      logger.warn(
        `${branch} has new commits on top of a rejected PR (#${lastRejected.number}). ` +
        `The reconciliation PR will bundle both — the rejected diff has not been reverted.`,
        { headSha: commits[0].hash, rejectedHead: lastRejected.headSha, rejectedPR: lastRejected.url },
      );
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

    const verified = verifyPRExists(config.githubRepo, branch, config.baseBranch, config.repoPath, logger);
    if (!verified) {
      logger.warn("PR URL returned but verification failed — PR may not exist");
      return {
        reconciled: false, issueNumbers, commitCount: commits.length,
        error: "PR creation could not be verified",
      };
    }

    logger.info(`Reconciliation PR created and verified: ${prUrl}`);

    // Apply `pr under review` to each linked issue. The implement phase normally
    // does this after a successful PR open, but reconciler PRs are recovery for
    // orphan commits left by an implementer that crashed (e.g. max-turns) before
    // labeling — without this, the Review phase's gate (`findPRsNeedingReview`)
    // never sees the PR and it sits dead-zoned indefinitely.
    if (issueNumbers.length > 0) {
      transitionImplementationLabels(
        config.githubRepo,
        issueNumbers,
        config.repoPath,
        logger,
      );
    }
    return {
      reconciled: true, prUrl, issueNumbers, commitCount: commits.length,
      ...(rejected.length > 0 ? { rejected } : {}),
    };
  }

  return {
    reconciled: false, issueNumbers: [], commitCount: 0,
    ...(rejected.length > 0 ? { rejected } : {}),
  };
}
