import type { AgentConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { findActionableIssues } from "./github.js";
import { implementIssue, type ImplementationResult } from "./agent.js";

interface FailedIssue {
  count: number;
  lastError: string;
}

export interface OrchestratorState {
  implementing: number | null;
  implemented: number[];
  failed: Record<number, FailedIssue>;
}

const MAX_RETRIES = 2;

let implementing: number | null = null;
const implemented = new Set<number>();
const failed = new Map<number, FailedIssue>();
let abortController: AbortController | null = null;

export function getState(): OrchestratorState {
  return {
    implementing,
    implemented: [...implemented],
    failed: Object.fromEntries(failed),
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

  if (implementing !== null) {
    cycleLogger.info(`Busy implementing #${implementing}, skipping cycle`);
    return null;
  }

  const issues = await findActionableIssues(config, cycleLogger);
  cycleLogger.info(`Found ${issues.length} actionable issue(s)`);

  // Filter out already-implemented and max-failed issues
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

  const issue = candidates[0]; // Oldest first (already sorted by findActionableIssues)
  implementing = issue.number;
  abortController = new AbortController();

  const implLogger = logger.child({ cycle: cycleNumber, issue: issue.number, phase: "implement" });
  implLogger.info(`Implementing #${issue.number}: ${issue.title}`);

  try {
    const result = await implementIssue(issue, config, implLogger, abortController.signal);

    if (result.success) {
      implemented.add(issue.number);
      failed.delete(issue.number);
      implLogger.info(`Successfully implemented #${issue.number}`, {
        prUrl: result.prUrl,
      });
    } else {
      const existing = failed.get(issue.number);
      failed.set(issue.number, {
        count: (existing?.count ?? 0) + 1,
        lastError: result.error ?? "unknown",
      });
      implLogger.warn(`Failed to implement #${issue.number}: ${result.error}`);
    }

    return result;
  } finally {
    implementing = null;
    abortController = null;
  }
}
