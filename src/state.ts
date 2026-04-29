import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface FailedIssue {
  count: number;
  lastError: string;
}

interface SkippedIssue {
  lastSkippedAt: string; // ISO timestamp
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
    };
  }

  return {
    implemented: [...EMPTY_REPO_STATE.implemented],
    failed: { ...EMPTY_REPO_STATE.failed },
    skipped: {},
  };
}

export function saveRepoState(repoName: string, repoState: RepoState): void {
  const state = loadRaw();
  state.repos[repoName] = repoState;
  saveRaw(state);
}
