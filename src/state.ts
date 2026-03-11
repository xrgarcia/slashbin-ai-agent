import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TrackedPR } from "./reviewer.js";

interface FailedIssue {
  count: number;
  lastError: string;
}

export interface PersistedState {
  implemented: number[];
  failed: Record<number, FailedIssue>;
  trackedPRs: Record<number, TrackedPR>;
}

const EMPTY_STATE: PersistedState = {
  implemented: [],
  failed: {},
  trackedPRs: {},
};

let statePath = ".agent-state.json";

export function setStatePath(dir: string): void {
  statePath = join(dir, ".agent-state.json");
}

export function loadState(): PersistedState {
  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      implemented: Array.isArray(parsed.implemented) ? parsed.implemented : [],
      failed: parsed.failed && typeof parsed.failed === "object" ? parsed.failed : {},
      trackedPRs: parsed.trackedPRs && typeof parsed.trackedPRs === "object" ? parsed.trackedPRs : {},
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function saveState(state: PersistedState): void {
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  } catch {
    // Best-effort — don't crash the daemon over a state write failure
  }
}
