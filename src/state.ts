import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface FailedIssue {
  count: number;
  lastError: string;
}

interface SkippedIssue {
  lastSkippedAt: string; // ISO timestamp
  reason: string;
  // Consecutive times the agent has skipped this issue. Drives the ESCALATING
  // back-off (a fixed snooze never gives up, so a permanently-unactionable issue
  // costs one agent session per window forever — slashbin-ai-foreman#32).
  // Optional for backward compat with state files written before this field existed;
  // absent is read as 0, i.e. the original single-window behavior.
  skipCount?: number;
}

interface HeldIssue {
  /** ISO timestamp of the review run that declared the hold. */
  heldAt: string;
  /** The PR whose review declared it. */
  prNumber: number;
  /** Why the reviewer withheld the outcome label, verbatim from the trailer. */
  reason: string;
}

export interface RepoState {
  implemented: number[];
  failed: Record<number, FailedIssue>;
  // Issues the implementation agent declined to implement (e.g., investigation-only
  // issues whose body explicitly says "no immediate code change"). The orchestrator
  // applies a back-off so we don't re-attempt every cycle.
  // Optional for backward compat with v2 state files written before this field existed.
  skipped?: Record<number, SkippedIssue>;
  // Issues whose reviewer DELIBERATELY withheld the outcome label (trailer
  // `hold=`), e.g. an acceptance criterion that cannot be observed until a later
  // time boundary. Distinct from a dropped label: the reviewer reported the hold,
  // so neither the label reconciler nor dead-zone recovery may overwrite it — a
  // deliberate decision must not be rubber-stamped by an automated verdict.
  // Optional for backward compat with state files written before this field existed.
  held?: Record<number, HeldIssue>;
  // Feature branches whose commits were REJECTED — the last PR for the branch was
  // closed unmerged and the branch has not moved since. The reconciler refuses to
  // recreate a PR for them, and this records the head SHA it already alerted on so
  // a standing rejection is announced ONCE rather than every reconcile pass.
  // Keyed by branch name; the value is the alerted head SHA, so a NEW commit on the
  // branch (different SHA) is a fresh condition and alerts again.
  // Optional for backward compat with state files written before this field existed.
  rejectedBranches?: Record<string, string>;
}

interface PersistedState {
  version: number;
  repos: Record<string, RepoState>;
}

const EMPTY_REPO_STATE: RepoState = {
  implemented: [],
  failed: {},
};

let statePath = ".agent-state.json";

export function setStatePath(dir: string): void {
  statePath = join(dir, ".agent-state.json");
}

function loadRaw(): PersistedState {
  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw);

    if (parsed.version === 2 && parsed.repos) {
      // Strip trackedPRs from any existing state
      for (const repoName of Object.keys(parsed.repos)) {
        delete parsed.repos[repoName].trackedPRs;
      }
      return parsed;
    }

    // V1 format (flat) — migrate
    const v1State: RepoState = {
      implemented: Array.isArray(parsed.implemented) ? parsed.implemented : [],
      failed: parsed.failed && typeof parsed.failed === "object" ? parsed.failed : {},
      skipped: {},
    };
    return { version: 2, repos: { _migrated: v1State } };
  } catch {
    return { version: 2, repos: {} };
  }
}

function saveRaw(state: PersistedState): void {
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  } catch {
    // Best-effort — don't crash the daemon over a state write failure
  }
}

export function loadRepoState(repoName: string): RepoState {
  const state = loadRaw();

  if (state.repos[repoName]) {
    const repo = state.repos[repoName];
    return {
      implemented: [...repo.implemented],
      failed: { ...repo.failed },
      skipped: { ...(repo.skipped ?? {}) },
      held: { ...(repo.held ?? {}) },
      rejectedBranches: { ...(repo.rejectedBranches ?? {}) },
    };
  }

  // Auto-migrate v1 state to the first repo that claims it
  if (state.repos._migrated) {
    const migrated = state.repos._migrated;
    state.repos[repoName] = migrated;
    delete state.repos._migrated;
    saveRaw(state);
    return {
      implemented: [...migrated.implemented],
      failed: { ...migrated.failed },
      skipped: { ...(migrated.skipped ?? {}) },
      held: { ...(migrated.held ?? {}) },
      rejectedBranches: { ...(migrated.rejectedBranches ?? {}) },
    };
  }

  return {
    implemented: [...EMPTY_REPO_STATE.implemented],
    failed: { ...EMPTY_REPO_STATE.failed },
    skipped: {},
    held: {},
    rejectedBranches: {},
  };
}

export function saveRepoState(repoName: string, repoState: RepoState): void {
  const state = loadRaw();
  state.repos[repoName] = repoState;
  saveRaw(state);
}
