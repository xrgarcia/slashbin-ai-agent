import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { RevisionTask } from "./agent.js";
import {
  findPRsNeedingRevision,
  isPRApproved,
  isPROpen,
  type PRReviewFeedback,
} from "./github.js";
import { loadRepoState, saveRepoState } from "./state.js";

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

// Per-repo cache: repoName → (prNumber → TrackedPR)
const cache = new Map<string, Map<number, TrackedPR>>();

function ensureLoaded(repoName: string): Map<number, TrackedPR> {
  const existing = cache.get(repoName);
  if (existing) return existing;

  const state = loadRepoState(repoName);
  const prMap = new Map<number, TrackedPR>();
  for (const [key, pr] of Object.entries(state.trackedPRs)) {
    prMap.set(Number(key), pr);
  }
  cache.set(repoName, prMap);
  return prMap;
}

function persist(repoName: string): void {
  const prMap = ensureLoaded(repoName);
  const state = loadRepoState(repoName);
  state.trackedPRs = Object.fromEntries(prMap);
  saveRepoState(repoName, state);
}

export function trackPR(prNumber: number, issueNumber: number, repo: string, repoName: string): void {
  const prMap = ensureLoaded(repoName);
  prMap.set(prNumber, {
    prNumber,
    issueNumber,
    repo,
    revisionCount: 0,
    lastAddressedReviewId: 0,
    lastAddressedCommentId: 0,
    status: "watching",
  });
  persist(repoName);
}

export function getTrackedPRs(repoName: string): Map<number, TrackedPR> {
  return ensureLoaded(repoName);
}

export function getReviewerState(repoName: string): ReviewerState {
  const prMap = ensureLoaded(repoName);
  const tracked = [...prMap.values()].map((pr) => ({
    prNumber: pr.prNumber,
    issueNumber: pr.issueNumber,
    revisionCount: pr.revisionCount,
    status: pr.status,
  }));
  const revising = [...prMap.values()].find((pr) => pr.status === "revising")?.prNumber ?? null;
  return { tracked, revising };
}

export function markRevisionStarted(repoName: string, prNumber: number): void {
  const prMap = ensureLoaded(repoName);
  const pr = prMap.get(prNumber);
  if (pr) {
    pr.status = "revising";
    persist(repoName);
  }
}

export function markRevisionComplete(
  repoName: string,
  prNumber: number,
  lastReviewId: number,
  lastCommentId: number,
  maxAttempts: number
): void {
  const prMap = ensureLoaded(repoName);
  const pr = prMap.get(prNumber);
  if (!pr) return;
  pr.revisionCount++;
  pr.lastAddressedReviewId = lastReviewId;
  pr.lastAddressedCommentId = lastCommentId;
  pr.status = pr.revisionCount >= maxAttempts ? "abandoned" : "watching";
  persist(repoName);
}

export function markApproved(repoName: string, prNumber: number): void {
  const prMap = ensureLoaded(repoName);
  const pr = prMap.get(prNumber);
  if (pr) {
    pr.status = "approved";
    persist(repoName);
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
  repoConfig: RepoConfig,
  logger: Logger
): { task: RevisionTask; maxIds: { reviewId: number; commentId: number } } | null {
  const repoName = repoConfig.name;
  const repo = repoConfig.githubRepo;
  const cwd = repoConfig.repoPath;
  const prMap = ensureLoaded(repoName);

  // Clean up: remove closed/merged PRs and check for approvals
  let changed = false;
  for (const [prNumber, pr] of prMap) {
    if (pr.status === "approved" || pr.status === "abandoned") continue;

    if (!isPROpen(repo, prNumber, cwd)) {
      logger.debug(`PR #${prNumber} is no longer open, removing from tracking`);
      prMap.delete(prNumber);
      changed = true;
      continue;
    }

    if (isPRApproved(repo, prNumber, cwd)) {
      logger.info(`PR #${prNumber} approved`);
      markApproved(repoName, prNumber);
      changed = true;
    }
  }
  if (changed) persist(repoName);

  // Get PRs that are watching and under the revision limit
  const watching = [...prMap.values()].filter((pr) => pr.status === "watching");
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
  const pr = prMap.get(feedback.prNumber)!;
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
