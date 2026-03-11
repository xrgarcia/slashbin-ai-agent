import { spawn, type ChildProcess } from "node:child_process";
import type { AgentConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { ActionableIssue } from "./github.js";

export interface ImplementationResult {
  success: boolean;
  prUrl?: string;
  error?: string;
}

const DEFAULT_PROMPT = `You have been assigned to implement GitHub issue #{{issue_number}}.

## Issue: {{issue_title}}

{{issue_body}}

## Instructions

1. Read the issue carefully and understand what needs to be done.
2. Implement the changes described in the issue.
3. Commit your changes with a clear commit message referencing the issue number.
4. Push your changes and create a pull request.

Work autonomously. Do not ask questions — make reasonable decisions and proceed.`;

function buildPrompt(issue: ActionableIssue, config: AgentConfig): string {
  const template = config.prompt ?? DEFAULT_PROMPT;
  return template
    .replace(/\{\{issue_number\}\}/g, String(issue.number))
    .replace(/\{\{issue_title\}\}/g, issue.title)
    .replace(/\{\{issue_body\}\}/g, issue.body);
}

export async function implementIssue(
  issue: ActionableIssue,
  config: AgentConfig,
  logger: Logger,
  abortSignal?: AbortSignal
): Promise<ImplementationResult> {
  const issueLogger = logger.child({ issue: issue.number, phase: "implement" });
  issueLogger.info(`Starting implementation of #${issue.number}: ${issue.title}`);

  let prompt = buildPrompt(issue, config);

  if (config.skillPath) {
    prompt = `First, read and follow the skill at ${config.skillPath}.\n\n${prompt}`;
  }

  const args = [
    "--print",
    prompt,
    "--max-turns", String(config.maxTurns),
    "--dangerously-skip-permissions",
  ];

  if (config.allowedTools.length > 0) {
    args.push("--allowedTools", config.allowedTools.join(","));
  }

  return new Promise<ImplementationResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ChildProcess | null = null;
    let timedOut = false;

    // Timeout
    const timeout = setTimeout(() => {
      timedOut = true;
      issueLogger.warn(`Implementation timed out after ${config.maxDurationMs}ms`);
      if (child) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child && !child.killed) child.kill("SIGKILL");
        }, 10_000);
      }
    }, config.maxDurationMs);

    // Wire external abort signal
    const onAbort = () => {
      issueLogger.warn("Implementation aborted");
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
        issueLogger.debug(line);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      issueLogger.error(`Failed to spawn claude CLI: ${err.message}`);
      resolve({ success: false, error: `spawn error: ${err.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      child = null;

      if (timedOut) {
        resolve({ success: false, error: "timed out" });
        return;
      }

      if (code !== 0) {
        const error = stderr.trim() || `exit code ${code}`;
        issueLogger.error(`Claude CLI exited with code ${code}: ${error}`);
        resolve({ success: false, error });
        return;
      }

      // Extract PR URL from output
      const prMatch = stdout.match(/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
      const prUrl = prMatch ? `https://${prMatch[0]}` : undefined;

      if (prUrl) {
        issueLogger.info(`PR created: ${prUrl}`);
      } else {
        issueLogger.info("Implementation completed (no PR URL found in output)");
      }

      resolve({ success: true, prUrl });
    });
  });
}
