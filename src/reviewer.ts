import type { AgentConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { RevisionTask } from "./agent.js";
import {
  findPRsNeedingRevision,
  isPRApproved,
  isPROpen,
  type PRReviewFeedback,
} from "./github.js";
import { loadState, saveState } from "./state.js";

export interface TrackedPR {
  prNumber: number;
  issueNumber: number;
  repo: string;
  revisionCount: number;
  lastAddressedReviewId: number;
  lastAddressedCommentId: number;
  status: "watching" | "revising" | "approved" | "abandoned";
}

export interface ReviewerState {
  tracked: Array<{ prNumber: number; issueNumber: number; revisionCount: number; status: string }>;
  revising: number | null;
}

let trackedPRs = new Map<number, TrackedPR>();
let initialized = false;

function ensureLoaded(): void {
  if (initialized) return;
  const state = loadState();
  for (const [key, pr] of Object.entries(state.trackedPRs)) {
    trackedPRs.set(Number(key), pr);
  }
  initialized = true;
}

function persist(): void {
  const state = loadState();
  state.trackedPRs = Object.fromEntries(trackedPRs);
  saveState(state);
}

export function trackPR(prNumber: number, issueNumber: number, repo: string): void {
  ensureLoaded();
  trackedPRs.set(prNumber, {
    prNumber,
    issueNumber,
    repo,
    revisionCount: 0,
    lastAddressedReviewId: 0,
    lastAddressedCommentId: 0,
    status: "watching",
  });
  persist();
}

export function getTrackedPRs(): Map<number, TrackedPR> {
  ensureLoaded();
  return trackedPRs;
}

export function getReviewerState(): ReviewerState {
  ensureLoaded();
  const tracked = [...trackedPRs.values()].map((pr) => ({
    prNumber: pr.prNumber,
    issueNumber: pr.issueNumber,
    revisionCount: pr.revisionCount,
    status: pr.status,
  }));
  const revising = [...trackedPRs.values()].find((pr) => pr.status === "revising")?.prNumber ?? null;
  return { tracked, revising };
}

export function markRevisionStarted(prNumber: number): void {
  ensureLoaded();
  const pr = trackedPRs.get(prNumber);
  if (pr) {
    pr.status = "revising";
    persist();
  }
}

export function markRevisionComplete(
  prNumber: number,
  lastReviewId: number,
  lastCommentId: number,
  maxAttempts: number
): void {
  ensureLoaded();
  const pr = trackedPRs.get(prNumber);
  if (!pr) return;
  pr.revisionCount++;
  pr.lastAddressedReviewId = lastReviewId;
  pr.lastAddressedCommentId = lastCommentId;
  pr.status = pr.revisionCount >= maxAttempts ? "abandoned" : "watching";
  persist();
}

export function markApproved(prNumber: number): void {
  ensureLoaded();
  const pr = trackedPRs.get(prNumber);
  if (pr) {
    pr.status = "approved";
    persist();
  }
}

function formatFeedback(feedback: PRReviewFeedback): string {
  const parts: string[] = [];

  for (const review of feedback.reviews) {
    if (review.body) {
      parts.push(`**Review by @${review.user}** (${review.state}):\n${review.body}`);
    }
  }

  for (const comment of feedback.comments) {
    if (comment.body) {
      parts.push(`**Comment by @${comment.user}**:\n${comment.body}`);
    }
  }

  return parts.join("\n\n---\n\n");
}

function getMaxIds(feedback: PRReviewFeedback): { reviewId: number; commentId: number } {
  const reviewId = feedback.reviews.reduce((max, r) => Math.max(max, r.id), 0);
  const commentId = feedback.comments.reduce((max, c) => Math.max(max, c.id), 0);
  return { reviewId, commentId };
}

export function findNextRevision(
  config: AgentConfig,
  logger: Logger
): { task: RevisionTask; maxIds: { reviewId: number; commentId: number } } | null {
  ensureLoaded();
  const repo = config.githubRepo!;
  const cwd = config.repoPath;

  // Clean up: remove closed/merged PRs and check for approvals
  let changed = false;
  for (const [prNumber, pr] of trackedPRs) {
    if (pr.status === "approved" || pr.status === "abandoned") continue;

    if (!isPROpen(repo, prNumber, cwd)) {
      logger.debug(`PR #${prNumber} is no longer open, removing from tracking`);
      trackedPRs.delete(prNumber);
      changed = true;
      continue;
    }

    if (isPRApproved(repo, prNumber, cwd)) {
      logger.info(`PR #${prNumber} approved`);
      markApproved(prNumber);
      changed = true;
    }
  }
  if (changed) persist();

  // Get PRs that are watching and under the revision limit
  const watching = [...trackedPRs.values()].filter((pr) => pr.status === "watching");
  if (watching.length === 0) return null;

  // Build lookup for last addressed IDs
  const lastIds = new Map<number, { reviewId: number; commentId: number }>();
  for (const pr of watching) {
    lastIds.set(pr.prNumber, {
      reviewId: pr.lastAddressedReviewId,
      commentId: pr.lastAddressedCommentId,
    });
  }

  const feedbacks = findPRsNeedingRevision(
    repo,
    watching.map((pr) => pr.prNumber),
    lastIds,
    cwd,
    logger
  );

  if (feedbacks.length === 0) return null;

  const feedback = feedbacks[0];
  const pr = trackedPRs.get(feedback.prNumber)!;
  const maxIds = getMaxIds(feedback);

  return {
    task: {
      prNumber: feedback.prNumber,
      issueNumber: pr.issueNumber,
      feedbackSummary: formatFeedback(feedback),
    },
    maxIds,
  };
}
