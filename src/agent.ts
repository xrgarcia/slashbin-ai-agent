import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { AgentConfig, RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { verifyPRExists, checkPRHasChanges, getRemoteBranchSha } from "./github.js";

export interface RevisionResult {
  success: boolean;
  error?: string;
}

export interface ReviewResult {
  success: boolean;
  error?: string;
  // The skill's final summary text (parsed from the stream-json result event).
  summary?: string;
  // Concise per-PR status parsed from the FOREMAN_REVIEW trailer(s), including the
  // deployment outcome — e.g. "#100 APPROVE · merged · deploy SUCCESS". Surfaced
  // in the Foreman's Discord status line. Undefined if no trailer was emitted.
  statusLine?: string;
}

/**
 * Parse the structured review trailers the skill is asked to emit, one per PR it
 * acted on:
 *   FOREMAN_REVIEW pr=#100 verdict=APPROVE merged=yes deploy=SUCCESS
 * Returns a concise human-readable line, or undefined when no trailer is present.
 */
function parseReviewTrailers(stdout: string): string | undefined {
  // Each field uses a bounded token alphabet ([\w/-]+) so it cannot bleed into
  // surrounding characters when the trailer is emitted inside a single-line
  // stream-JSON envelope (the Claude CLI's --output-format=stream-json), where
  // the characters immediately after the trailer (`"}],"STOP_REASON":NULL,…`)
  // are non-whitespace and would be greedily absorbed by an unbounded `\S+`.
  const re = /FOREMAN_REVIEW\s+pr=#?(\d+)\s+verdict=([\w/-]+)\s+merged=([\w/-]+)\s+deploy=([\w/-]+)/gi;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    const [, pr, verdict, merged, deploy] = m;
    const mergedTxt = /^y(es)?|true$/i.test(merged) ? "merged" : "not merged";
    const deployTxt = /^(na|n\/a|none)$/i.test(deploy) ? "no deploy" : `deploy ${deploy.toUpperCase()}`;
    parts.push(`#${pr} ${verdict.toUpperCase()} · ${mergedTxt} · ${deployTxt}`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

export interface ImplementationResult {
  success: boolean;
  prUrl?: string;
  error?: string;
  // True when the agent deliberately declined to implement (e.g., the issue body
  // says "investigate first, no code change yet"). Distinguishes a clean no-op
  // from a real implementation failure so the orchestrator can back off instead
  // of treating it as a retryable error.
  skipped?: boolean;
  // Reason the agent gave for skipping, surfaced from its output.
  skipReason?: string;
  // Issues the agent decided to skip. Empty/undefined when no skip was detected.
  skippedIssues?: number[];
}

// Detect a deliberate skip in the agent's output. Two signals, in order of
// reliability:
//  1. Structured trailer: `FOREMAN_RESULT: skipped reason="<text>"` — what we
//     ask the skill to emit.
//  2. Free-text heuristic: the agent wrote about "skipping" or "no immediate
//     code change". Less precise but catches well-behaved agents that explained
//     themselves without using the structured trailer.
function detectSkipSignal(stdout: string): { skipped: boolean; reason?: string } {
  // Structured trailer (preferred)
  const structured = stdout.match(/FOREMAN_RESULT:\s*skipped(?:\s+reason="([^"]*)")?/i);
  if (structured) {
    return { skipped: true, reason: structured[1] || "no reason given" };
  }

  // Free-text heuristics on the last 2000 chars (agents tend to put the
  // conclusion at the end of their output).
  const tail = stdout.slice(-2000).toLowerCase();
  const phrases = [
    "skipped because",
    "skipping this issue",
    "no implementation needed",
    "no immediate code change",
    "cannot be implemented",
    "no code change is warranted",
    "issue body explicitly says",
    "decided not to implement",
    "declined to implement",
  ];
  for (const phrase of phrases) {
    if (tail.includes(phrase)) {
      return { skipped: true, reason: `output indicates skip ("${phrase}")` };
    }
  }
  return { skipped: false };
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

// Claude is multimodal — when issue bodies or PR review comments include
// markdown image references like ![alt](url), the agent must fetch each image
// to a local file and Read it. Without this, the model sees only the URL string
// and is blind to visual specs (mockups, screenshots, walkthrough frames).
//
// Authorization header is required for private-repo URLs
// (e.g. github.com/<owner>/<repo>/raw/<branch>/<path>) and harmless for public
// CDN URLs (e.g. github.com/user-attachments/...).
const IMAGE_HANDLING_INSTRUCTIONS = `IMAGE HANDLING: If an issue body or PR review comment contains markdown image references like \`![alt](https://...)\`, those images are part of the spec. Fetch each image to a temp file and Read it so you can see it:

  curl -sL -H "Authorization: token $GH_TOKEN" -o /tmp/foreman-image-<n>.png "<url>"
  Then call the Read tool on /tmp/foreman-image-<n>.png — the multimodal model will see the image content.

The Authorization header is required for private-repo URLs (github.com/.../raw/...) and harmless for public CDN URLs (github.com/user-attachments/...). If a fetch fails, log a warning and proceed with the text spec — do not abort the implementation.`;

interface SpawnOptions {
  /** Working directory for the claude process. */
  cwd: string;
  /** Value to inject as GH_TOKEN (controls GitHub account attribution). */
  ghToken?: string;
  model?: string;
  allowedTools: string[];
  maxTurns: number;
  maxDurationMs: number;
  /**
   * Emit the full turn-by-turn interaction as newline-delimited JSON
   * (`--output-format stream-json --verbose`) instead of just the final text.
   * Used by the review phase so the transcript captures every tool call + result.
   */
  streamJson?: boolean;
  /**
   * When set, the raw stdout/stderr stream is appended to this file verbatim for
   * post-hoc debugging. The directory is created if needed.
   */
  transcriptPath?: string;
}

/**
 * Low-level Claude CLI spawn. All callers go through this so the timeout/abort/
 * stream-capture behavior is shared. The per-call options carry cwd, token, and
 * tool surface — implement/revise run in the service repo under the Foreman
 * token; review runs in the EM repo under the EM token (see reviewOpenPRs).
 */
function spawnClaudeWithOptions(
  prompt: string,
  opts: SpawnOptions,
  logger: Logger,
  abortSignal?: AbortSignal
): Promise<SpawnResult> {
  const args = [
    "--print",
    prompt,
    "--max-turns", String(opts.maxTurns),
    "--dangerously-skip-permissions",
  ];

  if (opts.streamJson) {
    args.push("--output-format", "stream-json", "--verbose");
  }

  if (opts.model) {
    args.push("--model", opts.model);
  }

  if (opts.allowedTools.length > 0) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }

  let transcript: WriteStream | null = null;
  if (opts.transcriptPath) {
    try {
      mkdirSync(dirname(opts.transcriptPath), { recursive: true });
      transcript = createWriteStream(opts.transcriptPath, { flags: "a" });
      const argsForLog = args.map((a) => (a === prompt ? "<prompt>" : a));
      transcript.write(
        `# claude invocation @ ${new Date().toISOString()}\n` +
        `# cwd=${opts.cwd}\n` +
        `# args=${JSON.stringify(argsForLog)}\n` +
        `# prompt:\n${prompt}\n\n===== STREAM =====\n`
      );
    } catch (err) {
      logger.warn(`Failed to open transcript ${opts.transcriptPath}: ${err instanceof Error ? err.message : String(err)}`);
      transcript = null;
    }
  }

  // GH_TOKEN must be a string or absent — never literal "undefined".
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (opts.ghToken) env.GH_TOKEN = opts.ghToken;

  return new Promise<SpawnResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ChildProcess | null = null;
    let timedOut = false;

    const finish = (r: SpawnResult) => {
      if (transcript) {
        transcript.write(`\n===== END (exit=${r.exitCode}${r.timedOut ? ", timedOut" : ""}) @ ${new Date().toISOString()} =====\n`);
        transcript.end();
        transcript = null;
      }
      resolve(r);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      logger.warn(`Claude CLI timed out after ${opts.maxDurationMs}ms`);
      if (child) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child && !child.killed) child.kill("SIGKILL");
        }, 10_000);
      }
    }, opts.maxDurationMs);

    const onAbort = () => {
      logger.warn("Claude CLI aborted");
      if (child) child.kill("SIGTERM");
    };
    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    child = spawn("claude", args, {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      transcript?.write(data);
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      transcript?.write(`[stderr] ${text}`);
      const lines = text.split("\n").filter(Boolean);
      for (const line of lines) {
        logger.warn(`[claude stderr] ${line}`);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      finish({ stdout, stderr: err.message, exitCode: -1, timedOut: false });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      child = null;
      finish({ stdout, stderr, exitCode: code, timedOut });
    });
  });
}

/**
 * Backward-compatible spawn for implement/revise: runs in the service repo under
 * the Foreman token with the narrow tool set, final-text output, no transcript.
 */
function spawnClaude(
  prompt: string,
  config: RepoConfig,
  logger: Logger,
  abortSignal?: AbortSignal
): Promise<SpawnResult> {
  return spawnClaudeWithOptions(
    prompt,
    {
      cwd: config.repoPath,
      ghToken: process.env.FOREMAN_GITHUB_TOKEN,
      model: config.model,
      allowedTools: config.allowedTools,
      maxTurns: config.maxTurns,
      maxDurationMs: config.maxDurationMs,
    },
    logger,
    abortSignal
  );
}

/**
 * Parse the final `result` event from a stream-json transcript and return its
 * text (truncated). Falls back to undefined when no result event is present.
 */
function extractStreamResult(stdout: string): string | undefined {
  const lines = stdout.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const evt = JSON.parse(lines[i]);
      if (evt && evt.type === "result") {
        const text = typeof evt.result === "string" ? evt.result : JSON.stringify(evt);
        return text.slice(0, 2000);
      }
    } catch {
      // not a JSON line — keep scanning
    }
  }
  return undefined;
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
    prompt = `Read and follow the skill at ${config.skillPath}.\n\nImplement all approved issues for this repository. The skill defines the full workflow — follow it exactly.\n\n${IMAGE_HANDLING_INSTRUCTIONS}`;
  } else if (config.prompt) {
    // Custom user prompt — don't auto-modify (backward compat). Users who want
    // image handling in a custom prompt should include their own instructions.
    prompt = config.prompt;
  } else {
    const issueScope = issueNumbers && issueNumbers.length > 0
      ? `Implement ONLY these issues: ${issueNumbers.map(n => `#${n}`).join(", ")}. Read each issue with \`gh issue view <number>\` to understand the requirements.`
      : `Implement all open GitHub issues labeled "approved" in this repository.\n\n1. Query GitHub for approved issues: gh issue list --label approved --state open --json number,title,body,labels\n2. Prioritize by severity (S1 > security > S2+bug > ... > chore).`;

    prompt = `${issueScope}

3. Implement each issue, commit with message: fix|feat|chore: <description> (#<issue-number>)
4. Push to ${config.featureBranch} and create a PR targeting ${config.baseBranch}.

IMPORTANT: In PR descriptions, use "Related to #N" — NEVER use "Closes #N" or "Fixes #N". Issues are closed by the EM after production verification, not on dev merge.

${IMAGE_HANDLING_INSTRUCTIONS}

Work autonomously. Do not ask questions.`;
  }

  // Skip-signaling protocol: an issue body may explicitly direct the agent NOT
  // to implement (e.g., investigation-first, blocked on external verification).
  // If the agent decides not to implement any of the assigned issues, it must
  // end its output with a single line `FOREMAN_RESULT: skipped reason="<text>"`
  // so the orchestrator can distinguish a deliberate no-op from a failed
  // implementation attempt and back off accordingly.
  prompt += `\n\nIMPORTANT — Skip protocol: If after reading an issue you conclude that the issue body explicitly directs you NOT to write code (investigation-first, "no immediate code change", waiting on external verification, etc.), do NOT create an empty PR or guess at a fix. Instead, end your output with this exact line and nothing after it:\n\nFOREMAN_RESULT: skipped reason="<one-line explanation>"\n\nThis tells the Foreman to back off rather than re-queue the issue every cycle. If at least one issue in the batch IS implementable, implement those normally and only skip the rest in your written conclusion (no trailer needed when at least one PR was created).`;

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

  // Before flagging "no PR" as a failure, check whether the agent deliberately
  // chose not to implement (investigation-only issues, blocked-on-prod-verification,
  // etc.). The orchestrator backs off on skip rather than retrying every cycle.
  const skip = detectSkipSignal(result.stdout);
  if (skip.skipped) {
    logger.info(`Implementation skipped — agent declined to write code: ${skip.reason}`);
    const outputTail = result.stdout.slice(-500).trim();
    if (outputTail) {
      logger.info("Claude output (last 500 chars):\n" + outputTail);
    }
    return {
      success: false,
      skipped: true,
      skipReason: skip.reason,
      skippedIssues: issueNumbers ?? [],
      error: `skipped: ${skip.reason}`,
    };
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

  // Capture the feature branch's HEAD SHA before invoking Claude so we can
  // detect the no-op case where Claude exits 0 without pushing any commits.
  // Without this, a silent no-op would be reported as success and the
  // orchestrator would (incorrectly) transition labels to "pr under review",
  // hiding the fact that the requested fix was never applied.
  const beforeSha = getRemoteBranchSha(config.githubRepo, config.featureBranch, config.repoPath, logger);

  const prContext = prNumber
    ? `\n\nCONTEXT: PR #${prNumber} needs revision. Linked issues: ${(issueNumbers || []).map(n => `#${n}`).join(", ")}. Read the review comments on PR #${prNumber} to understand what changes are requested.`
    : "";

  const labelNote = `\n\nIMPORTANT: Do NOT update issue labels — the orchestrator handles label transitions after you finish.`;

  let prompt: string;

  if (config.revisionSkillPath) {
    prompt = `Read and follow the skill at ${config.revisionSkillPath}.\n\nRevise PR #${prNumber || "(pending)"} which has review feedback for this repository. The skill defines the full workflow — follow it exactly.${prContext}${labelNote}\n\n${IMAGE_HANDLING_INSTRUCTIONS}`;
  } else {
    prompt = `Revise PR #${prNumber || "(find open PRs with review feedback)"} in this repository.

1. Read the PR's review comments: gh pr view ${prNumber || "<number>"} --comments
2. Also read inline review comments: gh api repos/${config.githubRepo}/pulls/${prNumber || "<number>"}/comments --jq '.[] | {path, line, body}'
3. Implement the requested changes on the PR's branch.
4. Run tests: npm test
5. Commit fixes with message: fix: address review feedback (#${prNumber || "<number>"})
6. Push to the PR branch.
${prContext}${labelNote}

${IMAGE_HANDLING_INSTRUCTIONS}

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

  // Post-revision self-check: confirm Claude actually pushed commits to the
  // feature branch. A clean exit with no SHA change means the revision was a
  // silent no-op (skill misfire, agent decided "nothing to fix", failed push,
  // etc.). Treat it as a failure so the orchestrator does not transition labels
  // to "pr under review" — that would lie about the PR's state and cause the
  // EM to re-review unchanged code.
  //
  // Conservative on lookup failures: if either SHA is null (transient gh
  // error), we trust the exit code rather than fail spuriously.
  const afterSha = getRemoteBranchSha(config.githubRepo, config.featureBranch, config.repoPath, logger);
  if (beforeSha && afterSha && beforeSha === afterSha) {
    const outputTail = result.stdout.slice(-500).trim();
    if (outputTail) {
      logger.warn("Claude output (last 500 chars):\n" + outputTail);
    }
    logger.error(`PR revision completed (exit 0) but no commits were pushed to ${config.featureBranch} (SHA unchanged at ${beforeSha.slice(0, 10)}) — marking as failed`);
    return { success: false, error: "no commits pushed — revision was a no-op" };
  }

  logger.info(`PR revision completed successfully for ${config.name}`);
  return { success: true };
}

/**
 * Invoke the EM repo's /review-all-prs skill, scoped to a single service repo,
 * in a headless Claude session.
 *
 * This is categorically different from implement/revise: those run IN the service
 * repo under the Foreman token with a narrow tool set. Review is a decision-layer
 * workflow — it needs the EM repo's MCP servers, npm scripts (healthcheck/verify/
 * validate), and context/docs — so it runs with:
 *   - cwd  = the EM repo (agentConfig.emRepoPath), so it loads the EM .mcp.json,
 *            .claude/skills, and context/docs
 *   - token = EM_GITHUB_TOKEN, so reviews/merges are attributed to the EM account
 *             (memory: feedback_mcp_github_for_review_actions)
 *   - the broad reviewAllowedTools surface (GitHub/Postgres/Redis/Railway MCP)
 *
 * Full-fidelity: the skill posts verdicts, merges approved PRs to develop, verifies
 * dev, files S3/S4 follow-ups, and updates labels itself. The orchestrator does NOT
 * relabel after a review run — unlike implement/revise, the skill owns its own label
 * transitions. The review's label side effects feed the existing phases: APPROVE →
 * `pr approved` (awaiting the EM outcome-gate); REQUEST_CHANGES → `pr pending actions`
 * (revise phase).
 */
export async function reviewOpenPRs(
  repoConfig: RepoConfig,
  agentConfig: AgentConfig,
  logger: Logger,
  abortSignal?: AbortSignal,
  transcriptPath?: string,
): Promise<ReviewResult> {
  const emToken = process.env.EM_GITHUB_TOKEN;
  if (!emToken) {
    return { success: false, error: "EM_GITHUB_TOKEN not set — refusing to run review without EM-account attribution" };
  }
  if (!agentConfig.emRepoPath) {
    return { success: false, error: "emRepoPath not configured — cannot locate the review skill" };
  }

  logger.info(`Starting review for ${repoConfig.name} (${repoConfig.githubRepo}) — cwd=${agentConfig.emRepoPath}`);

  const prompt = `Read and follow the skill at ${agentConfig.reviewSkillPath}.

Review the open feature PRs for the repository \`${repoConfig.githubRepo}\` ONLY. Treat this as the skill's repo-scoped mode (equivalent to \`--repo ${repoConfig.githubRepo}\`): scope every step — inventory, review, merge, verify — to that single repository, and use the full \`owner/repo\` slug \`${repoConfig.githubRepo}\` for all GitHub operations (do not rely on a short repo alias).

Follow the skill exactly and act autonomously — do NOT ask questions or wait for confirmation:
- Run the relevant healthchecks first (skill Phase 0).
- Review each open \`features → develop\` PR (skill Phase 3): the Fix-Completeness gate first, then the rubric.
- For APPROVED PRs: post the review from the EM account, merge to develop, then verify dev and label \`pr approved\` per the skill. Do NOT apply \`ready for prod release\` — that label is the EM outcome-gate's signature (separation of duties; see /review-pr Step 17).
- For BLOCKED PRs: post REQUEST_CHANGES, label the linked issue \`pr pending actions\`, and file S3/S4 follow-up issues per the skill.
- Update issue labels yourself exactly as the skill specifies — the orchestrator will NOT relabel after you.

If there are no open feature PRs awaiting review for this repo, that is a clean no-op — say so and stop.

IMPORTANT — status trailer: After you finish, end your output with one line per PR you acted on, in EXACTLY this format (nothing after the last one):

FOREMAN_REVIEW pr=#<number> verdict=<APPROVE|REQUEST_CHANGES> merged=<yes|no> deploy=<SUCCESS|FAILURE|NA>

Rules for the trailer: \`merged=yes\` only if you actually merged the PR to the base branch. \`deploy=SUCCESS\`/\`deploy=FAILURE\` reflects the post-merge deployment+verification result for that merge (use \`deploy=NA\` when nothing was merged, or when the repo has no deployment to verify, e.g. a docs/CLI/npm-package repo). Emit one trailer line for every PR you reviewed this run.

${IMAGE_HANDLING_INSTRUCTIONS}`;

  const result = await spawnClaudeWithOptions(
    prompt,
    {
      cwd: agentConfig.emRepoPath,
      ghToken: emToken,
      model: agentConfig.reviewModel,
      allowedTools: agentConfig.reviewAllowedTools,
      maxTurns: agentConfig.reviewMaxTurns,
      maxDurationMs: agentConfig.reviewMaxDurationMs,
      streamJson: true,
      transcriptPath,
    },
    logger,
    abortSignal
  );

  if (result.timedOut) {
    return { success: false, error: "timed out" };
  }

  if (result.exitCode !== 0) {
    const stderrMsg = result.stderr.trim();
    const stdoutTail = result.stdout.trim().slice(-500);
    const error = stderrMsg || stdoutTail || `exit code ${result.exitCode}`;
    logger.error(`Review Claude CLI exited with code ${result.exitCode}: ${error}`);
    return { success: false, error };
  }

  const summary = extractStreamResult(result.stdout);
  const statusLine = parseReviewTrailers(result.stdout);
  if (summary) {
    logger.info(`Review completed for ${repoConfig.name}:\n${summary}`);
  } else {
    logger.info(`Review completed for ${repoConfig.name} (no parseable summary; see transcript${transcriptPath ? ` ${transcriptPath}` : ""})`);
  }
  if (statusLine) {
    logger.info(`Review outcome for ${repoConfig.name}: ${statusLine}`);
  }
  return { success: true, summary, statusLine };
}
