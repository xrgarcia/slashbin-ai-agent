import type { AgentConfig, RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { findActionableIssues } from "./github.js";
import { implementIssue, type ImplementationResult } from "./agent.js";
import { loadRepoState, saveRepoState, setStatePath } from "./state.js";

interface FailedIssue {
  count: number;
  lastError: string;
}

export interface OrchestratorState {
  implementing: { repo: string; issue: number } | null;
  repos: Record<string, {
    implemented: number[];
    failed: Record<number, FailedIssue>;
  }>;
}

const MAX_RETRIES = 2;

let implementing: { repo: string; issue: number } | null = null;
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
    };
  }
  return { implementing, repos };
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
    cycleLogger.info(
      `Busy implementing ${implementing.repo}#${implementing.issue}, skipping cycle`
    );
    return null;
  }

  let totalProcessed = 0;
  let lastResult: ImplementationResult | null = null;

  // Drain all approved issues across all repos
  for (const repoConfig of config.repos) {
    let result = await tryImplementation(repoConfig, logger, cycleNumber);
    while (result) {
      totalProcessed++;
      lastResult = result;
      result = await tryImplementation(repoConfig, logger, cycleNumber);
    }
  }

  if (totalProcessed === 0) {
    cycleLogger.info("No work across all repos");
  } else {
    cycleLogger.info(`Cycle complete — processed ${totalProcessed} item(s)`);
  }

  return lastResult;
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
