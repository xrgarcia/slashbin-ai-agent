import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { verifyPRExists } from "./github.js";

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
      env: process.env as Record<string, string>,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        logger.debug(line);
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
  abortSignal?: AbortSignal
): Promise<ImplementationResult> {
  logger.info(`Starting batch implementation for ${config.name}`);

  let prompt: string;

  if (config.skillPath) {
    prompt = `Read and follow the skill at ${config.skillPath}.\n\nImplement all approved issues for this repository. The skill defines the full workflow — follow it exactly.`;
  } else if (config.prompt) {
    prompt = config.prompt;
  } else {
    prompt = `Implement all open GitHub issues labeled "approved" in this repository.

1. Query GitHub for approved issues: gh issue list --label approved --state open --json number,title,body,labels
2. Prioritize by severity (S1 > security > S2+bug > ... > chore).
3. Implement each issue, commit with message: fix|feat|chore: <description> (#<issue-number>)
4. Push to ${config.featureBranch} and create a PR targeting ${config.baseBranch}.

Work autonomously. Do not ask questions.`;
  }

  const result = await spawnClaude(prompt, config, logger, abortSignal);

  if (result.timedOut) {
    return { success: false, error: "timed out" };
  }

  if (result.exitCode !== 0) {
    const error = result.stderr.trim() || `exit code ${result.exitCode}`;
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
    );
    if (!verified) {
      logger.warn("PR URL found but verification failed — PR may not exist on GitHub");
      return { success: false, error: "PR creation could not be verified" };
    }
    logger.info(`PR created and verified: ${prUrl}`);
    return { success: true, prUrl };
  }

  logger.error("Batch implementation completed (exit 0) but no PR was created or found — marking as failed");
  return { success: false, error: "no PR created" };
}
