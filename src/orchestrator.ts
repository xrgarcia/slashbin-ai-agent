import type { AgentConfig } from "./config.js";
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
import { loadState, saveState, setStatePath } from "./state.js";

interface FailedIssue {
  count: number;
  lastError: string;
}

export interface OrchestratorState {
  implementing: number | null;
  revising: number | null;
  implemented: number[];
  failed: Record<number, FailedIssue>;
  trackedPRs: ReviewerState;
}

const MAX_RETRIES = 2;

let implementing: number | null = null;
let revising: number | null = null;
let _implemented: Set<number> | null = null;
let _failed: Map<number, FailedIssue> | null = null;
let abortController: AbortController | null = null;

function ensureLoaded(): { implemented: Set<number>; failed: Map<number, FailedIssue> } {
  if (_implemented && _failed) return { implemented: _implemented, failed: _failed };
  const state = loadState();
  _implemented = new Set(state.implemented);
  _failed = new Map(Object.entries(state.failed).map(([k, v]) => [Number(k), v]));
  return { implemented: _implemented, failed: _failed };
}

function persist(): void {
  const { implemented, failed } = ensureLoaded();
  const state = loadState();
  state.implemented = [...implemented];
  state.failed = Object.fromEntries(failed);
  saveState(state);
}

export function initState(repoPath: string): void {
  setStatePath(repoPath);
}

export function getState(): OrchestratorState {
  const { implemented, failed } = ensureLoaded();
  return {
    implementing,
    revising,
    implemented: [...implemented],
    failed: Object.fromEntries(failed),
    trackedPRs: getReviewerState(),
  };
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
  const { implemented, failed } = ensureLoaded();

  if (implementing !== null || revising !== null) {
    cycleLogger.info(
      `Busy (implementing=#${implementing}, revising=PR#${revising}), skipping cycle`
    );
    return null;
  }

  // --- Priority 1: Check for PRs needing revision ---
  const revision = findNextRevision(config, cycleLogger);
  if (revision) {
    const { task, maxIds } = revision;
    const repo = config.githubRepo!;
    const cwd = config.repoPath;

    revising = task.prNumber;
    abortController = new AbortController();
    markRevisionStarted(task.prNumber);

    const revLogger = logger.child({
      cycle: cycleNumber,
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

      const result = await reviseForPR(task, config, revLogger, abortController.signal);

      if (result.success) {
        commentOnPR(
          repo,
          task.prNumber,
          "Changes pushed addressing review feedback. Please review.",
          cwd
        );
        markRevisionComplete(task.prNumber, maxIds.reviewId, maxIds.commentId, config.maxRevisionAttempts);
        revLogger.info(`Revision of PR #${task.prNumber} completed successfully`);
      } else {
        commentOnPR(
          repo,
          task.prNumber,
          `Revision attempt failed: ${result.error}. Will retry on next cycle.`,
          cwd
        );
        markRevisionComplete(task.prNumber, maxIds.reviewId, maxIds.commentId, config.maxRevisionAttempts);
        revLogger.warn(`Revision of PR #${task.prNumber} failed: ${result.error}`);
      }

      const { tracked } = getReviewerState();
      const pr = tracked.find((p) => p.prNumber === task.prNumber);
      if (pr?.status === "abandoned") {
        commentOnPR(
          repo,
          task.prNumber,
          `Maximum revision attempts (${config.maxRevisionAttempts}) reached. Manual intervention needed. Related issue: #${task.issueNumber}`,
          cwd
        );
        revLogger.warn(`PR #${task.prNumber} abandoned after ${config.maxRevisionAttempts} revision attempts`);
      }

      return { success: result.success, error: result.error };
    } finally {
      revising = null;
      abortController = null;
    }
  }

  // --- Priority 2: Implement new issues ---
  const issues = await findActionableIssues(config, cycleLogger);
  cycleLogger.info(`Found ${issues.length} actionable issue(s)`);

  const candidates = issues.filter((issue) => {
    if (implemented.has(issue.number)) {
      cycleLogger.debug(`Skipping #${issue.number} — already implemented`);
      return false;
    }
    const failure = failed.get(issue.number);
    if (failure && failure.count >= MAX_RETRIES) {
      cycleLogger.debug(`Skipping #${issue.number} — failed ${failure.count} times`);
      return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    cycleLogger.info("No issues to implement");
    return null;
  }

  const issue = candidates[0];
  implementing = issue.number;
  abortController = new AbortController();

  const implLogger = logger.child({ cycle: cycleNumber, issue: issue.number, phase: "implement" });
  implLogger.info(`Implementing #${issue.number}: ${issue.title}`);

  try {
    const result = await implementIssue(issue, config, implLogger, abortController.signal);

    if (result.success) {
      implemented.add(issue.number);
      failed.delete(issue.number);
      persist();
      implLogger.info(`Successfully implemented #${issue.number}`, {
        prUrl: result.prUrl,
      });

      if (result.prUrl) {
        const prMatch = result.prUrl.match(/\/pull\/(\d+)/);
        if (prMatch) {
          const prNumber = parseInt(prMatch[1], 10);
          trackPR(prNumber, issue.number, config.githubRepo!);
          implLogger.info(`Tracking PR #${prNumber} for review feedback`);
        }
      }
    } else {
      const existing = failed.get(issue.number);
      failed.set(issue.number, {
        count: (existing?.count ?? 0) + 1,
        lastError: result.error ?? "unknown",
      });
      persist();
      implLogger.warn(`Failed to implement #${issue.number}: ${result.error}`);
    }

    return result;
  } finally {
    implementing = null;
    abortController = null;
  }
}
