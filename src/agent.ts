import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { verifyPRExists, checkPRHasChanges } from "./github.js";

export interface RevisionResult {
  success: boolean;
  error?: string;
}

export interface ImplementationResult {
  success: boolean;
  prUrl?: string;
  error?: string;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function spawnClaude(
  prompt: string,
  config: RepoConfig,
  logger: Logger,
  abortSignal?: AbortSignal
): Promise<SpawnResult> {
  const args = [
    "--print",
    prompt,
    "--max-turns", String(config.maxTurns),
    "--dangerously-skip-permissions",
  ];

  if (config.model) {
    args.push("--model", config.model);
  }

  if (config.allowedTools.length > 0) {
    args.push("--allowedTools", config.allowedTools.join(","));
  }

  return new Promise<SpawnResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ChildProcess | null = null;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      logger.warn(`Claude CLI timed out after ${config.maxDurationMs}ms`);
      if (child) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child && !child.killed) child.kill("SIGKILL");
        }, 10_000);
      }
    }, config.maxDurationMs);

    const onAbort = () => {
      logger.warn("Claude CLI aborted");
      if (child) child.kill("SIGTERM");
    };
    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    child = spawn("claude", args, {
      cwd: config.repoPath,
      env: { ...process.env, GH_TOKEN: process.env.FOREMAN_GITHUB_TOKEN } as Record<string, string>,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        logger.warn(`[claude stderr] ${line}`);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr: err.message, exitCode: -1, timedOut: false });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      child = null;
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
  });
}

/**
 * Invoke Claude CLI to implement all approved issues for a repo.
 * The skill (SKILL.md) owns inventory, prioritization, implementation,
 * and PR creation. Foreman just triggers and detects the result.
 */
export async function implementApprovedIssues(
  config: RepoConfig,
  logger: Logger,
  abortSignal?: AbortSignal,
  priorFailureReason?: string | null,
  issueNumbers?: number[]
): Promise<ImplementationResult> {
  logger.info(`Starting batch implementation for ${config.name}`);

  let prompt: string;

  if (config.skillPath) {
    prompt = `Read and follow the skill at ${config.skillPath}.\n\nImplement all approved issues for this repository. The skill defines the full workflow — follow it exactly.`;
  } else if (config.prompt) {
    prompt = config.prompt;
  } else {
    const issueScope = issueNumbers && issueNumbers.length > 0
      ? `Implement ONLY these issues: ${issueNumbers.map(n => `#${n}`).join(", ")}. Read each issue with \`gh issue view <number>\` to understand the requirements.`
      : `Implement all open GitHub issues labeled "approved" in this repository.\n\n1. Query GitHub for approved issues: gh issue list --label approved --state open --json number,title,body,labels\n2. Prioritize by severity (S1 > security > S2+bug > ... > chore).`;

    prompt = `${issueScope}

3. Implement each issue, commit with message: fix|feat|chore: <description> (#<issue-number>)
4. Push to ${config.featureBranch} and create a PR targeting ${config.baseBranch}.

IMPORTANT: In PR descriptions, use "Related to #N" — NEVER use "Closes #N" or "Fixes #N". Issues are closed by the EM after production verification, not on dev merge.

Work autonomously. Do not ask questions.`;
  }

  // Third Way: if a prior attempt failed, include context so Claude can adapt
  if (priorFailureReason) {
    prompt += `\n\nIMPORTANT — PRIOR ATTEMPT FAILED: "${priorFailureReason}". Ensure you: (1) commit changes to the ${config.featureBranch} branch, (2) push to origin, (3) create a PR targeting ${config.baseBranch} using \`gh pr create\`. If a PR already exists, push new commits to it.`;
  }

  const result = await spawnClaude(prompt, config, logger, abortSignal);

  if (result.timedOut) {
    return { success: false, error: "timed out" };
  }

  if (result.exitCode !== 0) {
    const stderrMsg = result.stderr.trim();
    const stdoutTail = result.stdout.trim().slice(-500);
    const error = stderrMsg || stdoutTail || `exit code ${result.exitCode}`;
    logger.error(`Claude CLI exited with code ${result.exitCode}: ${error}`);
    return { success: false, error };
  }

  // Extract PR URL from Claude's output
  const prMatch = result.stdout.match(/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
  let prUrl = prMatch ? `https://${prMatch[0]}` : undefined;

  // Fallback: query GitHub directly for an open feature PR
  if (!prUrl) {
    logger.info("PR URL not found in output, querying GitHub as fallback");
    const fallback = spawnSync("gh", [
      "pr", "list",
      "--repo", config.githubRepo,
      "--head", config.featureBranch,
      "--base", config.baseBranch,
      "--state", "open",
      "--limit", "1",
      "--json", "url",
      "--jq", ".[0].url",
    ], { cwd: config.repoPath, encoding: "utf-8", timeout: 15_000 });
    const fallbackUrl = fallback.stdout?.trim();
    if (fallbackUrl?.startsWith("https://")) {
      prUrl = fallbackUrl;
      logger.info(`PR found via GitHub fallback: ${prUrl}`);
    }
  }

  if (prUrl) {
    // Verify the PR actually exists on GitHub
    const verified = verifyPRExists(
      config.githubRepo,
      config.featureBranch,
      config.baseBranch,
      config.repoPath,
      logger,
    );
    if (!verified) {
      logger.warn("PR URL found but verification failed — PR may not exist on GitHub");
      return { success: false, error: "PR creation could not be verified" };
    }
    // Post-implementation self-check: verify the PR has actual file changes
    const changedFiles = checkPRHasChanges(config.githubRepo, config.featureBranch, config.baseBranch, config.repoPath, logger);
    if (changedFiles === 0) {
      return { success: false, error: "PR exists but has no file changes" };
    }

    logger.info(`PR created and verified: ${prUrl}`);
    return { success: true, prUrl };
  }

  // If Claude exited cleanly but no new PR was found, check if an existing
  // feature PR already has the work (Claude may have added commits to it).
  const existingPR = verifyPRExists(
    config.githubRepo,
    config.featureBranch,
    config.baseBranch,
    config.repoPath,
    logger,
  );
  if (existingPR) {
    logger.info("No new PR created, but existing feature PR found — treating as success (commits added to existing PR)");
    return { success: true };
  }

  // Log Claude's output tail so we can diagnose why no PR was created
  const outputTail = result.stdout.slice(-500).trim();
  if (outputTail) {
    logger.warn("Claude output (last 500 chars):\n" + outputTail);
  }

  logger.error("Batch implementation completed (exit 0) but no PR was created or found — marking as failed");
  return { success: false, error: "no PR created" };
}

/**
 * Invoke Claude CLI to revise PRs that have review feedback ("pr pending actions").
 * The revision skill reads review comments, implements fixes, and pushes.
 *
 * The orchestrator passes the specific PR number and issue numbers so the
 * skill doesn't need to search by label (which historically was unreliable).
 */
export async function revisePRFeedback(
  config: RepoConfig,
  logger: Logger,
  abortSignal?: AbortSignal,
  prNumber?: number,
  issueNumbers?: number[],
): Promise<RevisionResult> {
  logger.info(`Starting PR revision for ${config.name}`);

  const prContext = prNumber
    ? `\n\nCONTEXT: PR #${prNumber} needs revision. Linked issues: ${(issueNumbers || []).map(n => `#${n}`).join(", ")}. Read the review comments on PR #${prNumber} to understand what changes are requested.`
    : "";

  const labelNote = `\n\nIMPORTANT: Do NOT update issue labels — the orchestrator handles label transitions after you finish.`;

  let prompt: string;

  if (config.revisionSkillPath) {
    prompt = `Read and follow the skill at ${config.revisionSkillPath}.\n\nRevise PR #${prNumber || "(pending)"} which has review feedback for this repository. The skill defines the full workflow — follow it exactly.${prContext}${labelNote}`;
  } else {
    prompt = `Revise PR #${prNumber || "(find open PRs with review feedback)"} in this repository.

1. Read the PR's review comments: gh pr view ${prNumber || "<number>"} --comments
2. Also read inline review comments: gh api repos/${config.githubRepo}/pulls/${prNumber || "<number>"}/comments --jq '.[] | {path, line, body}'
3. Implement the requested changes on the PR's branch.
4. Run tests: npm test
5. Commit fixes with message: fix: address review feedback (#${prNumber || "<number>"})
6. Push to the PR branch.
${prContext}${labelNote}

Work autonomously. Do not ask questions.`;
  }

  const result = await spawnClaude(prompt, config, logger, abortSignal);

  if (result.timedOut) {
    return { success: false, error: "timed out" };
  }

  if (result.exitCode !== 0) {
    const stderrMsg = result.stderr.trim();
    const stdoutTail = result.stdout.trim().slice(-500);
    const error = stderrMsg || stdoutTail || `exit code ${result.exitCode}`;
    logger.error(`Claude CLI exited with code ${result.exitCode}: ${error}`);
    return { success: false, error };
  }

  logger.info(`PR revision completed successfully for ${config.name}`);
  return { success: true };
}
