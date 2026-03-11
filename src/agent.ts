import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { ActionableIssue } from "./github.js";

export interface ImplementationResult {
  success: boolean;
  prUrl?: string;
  error?: string;
  sessionId?: string;
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

  const abortController = new AbortController();

  // Wire external abort signal
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => abortController.abort());
  }

  // Timeout
  const timeout = setTimeout(() => {
    issueLogger.warn(`Implementation timed out after ${config.maxDurationMs}ms`);
    abortController.abort();
  }, config.maxDurationMs);

  let sessionId: string | undefined;
  let result = "";

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: config.repoPath,
        allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: config.maxTurns,
        settingSources: ["project"],
        env: {
          GITHUB_TOKEN: config.githubToken,
          ...(process.env.NPM_TOKEN ? { NPM_TOKEN: process.env.NPM_TOKEN } : {}),
        },
      },
    })) {
      if ("result" in message) {
        result = message.result;
        issueLogger.info("Agent completed");
      } else if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        issueLogger.debug(`Session started: ${sessionId}`);
      }
    }

    // Extract PR URL from result
    const prMatch = result.match(/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
    const prUrl = prMatch ? `https://${prMatch[0]}` : undefined;

    if (prUrl) {
      issueLogger.info(`PR created: ${prUrl}`);
    }

    return { success: true, prUrl, sessionId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    issueLogger.error(`Implementation failed: ${error}`);
    return { success: false, error, sessionId };
  } finally {
    clearTimeout(timeout);
  }
}
