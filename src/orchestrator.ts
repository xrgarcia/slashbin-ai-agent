import type { AgentConfig, RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { findActionableIssues, commentOnPR } from "./github.js";
import { implementIssue, reviseForPR, type ImplementationResult } from "./agent.js";
import {
  trackPR,
  findNextRevision,
  markRevisionStarted,
  markRevisionComplete,
  getReviewerState,
  type ReviewerState,
} from "./reviewer.js";
import { loadRepoState, saveRepoState, setStatePath } from "./state.js";

interface FailedIssue {
  count: number;
  lastError: string;
}

export interface OrchestratorState {
  implementing: { repo: string; issue: number } | null;
  revising: { repo: string; pr: number } | null;
  repos: Record<string, {
    implemented: number[];
    failed: Record<number, FailedIssue>;
    trackedPRs: ReviewerState;
  }>;
}

const MAX_RETRIES = 2;

let implementing: { repo: string; issue: number } | null = null;
let revising: { repo: string; pr: number } | null = null;
let abortController: AbortController | null = null;

// Per-repo in-memory caches
const implementedCache = new Map<string, Set<number>>();
const failedCache = new Map<string, Map<number, FailedIssue>>();

function ensureLoaded(repoName: string): { implemented: Set<number>; failed: Map<number, FailedIssue> } {
  let impl = implementedCache.get(repoName);
  let fail = failedCache.get(repoName);
  if (impl && fail) return { implemented: impl, failed: fail };

  const state = loadRepoState(repoName);
  impl = new Set(state.implemented);
  fail = new Map(Object.entries(state.failed).map(([k, v]) => [Number(k), v]));
  implementedCache.set(repoName, impl);
  failedCache.set(repoName, fail);
  return { implemented: impl, failed: fail };
}

function persist(repoName: string): void {
  const { implemented, failed } = ensureLoaded(repoName);
  const state = loadRepoState(repoName);
  state.implemented = [...implemented];
  state.failed = Object.fromEntries(failed);
  saveRepoState(repoName, state);
}

export function initState(stateDir: string): void {
  setStatePath(stateDir);
}

export function getState(config: AgentConfig): OrchestratorState {
  const repos: OrchestratorState["repos"] = {};
  for (const repo of config.repos) {
    const { implemented, failed } = ensureLoaded(repo.name);
    repos[repo.name] = {
      implemented: [...implemented],
      failed: Object.fromEntries(failed),
      trackedPRs: getReviewerState(repo.name),
    };
  }
  return { implementing, revising, repos };
}

export function getAbortController(): AbortController | null {
  return abortController;
}

export async function runCycle(
  config: AgentConfig,
  logger: Logger,
  cycleNumber: number
): Promise<ImplementationResult | null> {
  const cycleLogger = logger.child({ cycle: cycleNumber, phase: "poll" });

  if (implementing !== null || revising !== null) {
    cycleLogger.info(
      `Busy (implementing=${implementing ? `${implementing.repo}#${implementing.issue}` : "none"}, revising=${revising ? `${revising.repo}#PR${revising.pr}` : "none"}), skipping cycle`
    );
    return null;
  }

  // --- Priority 1: Check all repos for PRs needing revision ---
  for (const repoConfig of config.repos) {
    const result = await tryRevision(repoConfig, logger, cycleNumber);
    if (result) return result;
  }

  // --- Priority 2: Check all repos for new issues to implement ---
  for (const repoConfig of config.repos) {
    const result = await tryImplementation(repoConfig, logger, cycleNumber);
    if (result) return result;
  }

  cycleLogger.info("No work across all repos");
  return null;
}

async function tryRevision(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number
): Promise<ImplementationResult | null> {
  const repoName = repoConfig.name;
  const repoLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "revision-check" });

  const revision = findNextRevision(repoConfig, repoLogger);
  if (!revision) return null;

  const { task, maxIds } = revision;
  const repo = repoConfig.githubRepo;
  const cwd = repoConfig.repoPath;

  revising = { repo: repoName, pr: task.prNumber };
  abortController = new AbortController();
  markRevisionStarted(repoName, task.prNumber);

  const revLogger = logger.child({
    cycle: cycleNumber,
    repo: repoName,
    pr: task.prNumber,
    issue: task.issueNumber,
    phase: "revise",
  });

  revLogger.info(`Revising PR #${task.prNumber} for issue #${task.issueNumber}`);

  try {
    commentOnPR(
      repo,
      task.prNumber,
      "Acknowledged — changes underway based on review feedback.",
      cwd
    );

    const result = await reviseForPR(task, repoConfig, revLogger, abortController.signal);

    if (result.success) {
      commentOnPR(
        repo,
        task.prNumber,
        "Changes pushed addressing review feedback. Please review.",
        cwd
      );
      markRevisionComplete(repoName, task.prNumber, maxIds.reviewId, maxIds.commentId, repoConfig.maxRevisionAttempts);
      revLogger.info(`Revision of PR #${task.prNumber} completed successfully`);
    } else {
      commentOnPR(
        repo,
        task.prNumber,
        `Revision attempt failed: ${result.error}. Will retry on next cycle.`,
        cwd
      );
      markRevisionComplete(repoName, task.prNumber, maxIds.reviewId, maxIds.commentId, repoConfig.maxRevisionAttempts);
      revLogger.warn(`Revision of PR #${task.prNumber} failed: ${result.error}`);
    }

    const { tracked } = getReviewerState(repoName);
    const pr = tracked.find((p) => p.prNumber === task.prNumber);
    if (pr?.status === "abandoned") {
      commentOnPR(
        repo,
        task.prNumber,
        `Maximum revision attempts (${repoConfig.maxRevisionAttempts}) reached. Manual intervention needed. Related issue: #${task.issueNumber}`,
        cwd
      );
      revLogger.warn(`PR #${task.prNumber} abandoned after ${repoConfig.maxRevisionAttempts} revision attempts`);
    }

    return { success: result.success, error: result.error };
  } finally {
    revising = null;
    abortController = null;
  }
}

async function tryImplementation(
  repoConfig: RepoConfig,
  logger: Logger,
  cycleNumber: number
): Promise<ImplementationResult | null> {
  const repoName = repoConfig.name;
  const repoLogger = logger.child({ cycle: cycleNumber, repo: repoName, phase: "poll" });

  const { implemented, failed } = ensureLoaded(repoName);

  const issues = await findActionableIssues(repoConfig, repoLogger);
  repoLogger.debug(`Found ${issues.length} actionable issue(s) in ${repoName}`);

  const candidates = issues.filter((issue) => {
    if (implemented.has(issue.number)) {
      repoLogger.debug(`Skipping #${issue.number} — already implemented`);
      return false;
    }
    const failure = failed.get(issue.number);
    if (failure && failure.count >= MAX_RETRIES) {
      repoLogger.debug(`Skipping #${issue.number} — failed ${failure.count} times`);
      return false;
    }
    return true;
  });

  if (candidates.length === 0) return null;

  const issue = candidates[0];
  implementing = { repo: repoName, issue: issue.number };
  abortController = new AbortController();

  const implLogger = logger.child({
    cycle: cycleNumber,
    repo: repoName,
    issue: issue.number,
    phase: "implement",
  });
  implLogger.info(`Implementing #${issue.number}: ${issue.title}`);

  try {
    const result = await implementIssue(issue, repoConfig, implLogger, abortController.signal);

    if (result.success) {
      implemented.add(issue.number);
      failed.delete(issue.number);
      persist(repoName);
      implLogger.info(`Successfully implemented #${issue.number}`, {
        prUrl: result.prUrl,
      });

      if (result.prUrl) {
        const prMatch = result.prUrl.match(/\/pull\/(\d+)/);
        if (prMatch) {
          const prNumber = parseInt(prMatch[1], 10);
          trackPR(prNumber, issue.number, repoConfig.githubRepo, repoName);
          implLogger.info(`Tracking PR #${prNumber} for review feedback`);
        }
      }
    } else {
      const existing = failed.get(issue.number);
      failed.set(issue.number, {
        count: (existing?.count ?? 0) + 1,
        lastError: result.error ?? "unknown",
      });
      persist(repoName);
      implLogger.warn(`Failed to implement #${issue.number}: ${result.error}`);
    }

    return result;
  } finally {
    implementing = null;
    abortController = null;
  }
}
