import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

// --- Schemas ---

const repoEntrySchema = z.object({
  name: z.string(),
  repoPath: z.string(),
  githubRepo: z.string().optional(),
  triggerLabel: z.string().optional(),
  baseBranch: z.string().optional(),
  featureBranch: z.string().optional(),
  skillPath: z.string().optional(),
  revisionSkillPath: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  maxTurns: z.coerce.number().int().positive().optional(),
  maxDurationMs: z.coerce.number().int().positive().optional(),
  // Per-repo opt-out for the review phase (falls back to the global default).
  reviewEnabled: z.boolean().optional(),
});

const configSchema = z.object({
  // Single-repo fields (backward compat — ignored when repos[] is provided)
  repoPath: z.string().default("."),
  githubRepo: z.string().optional(),
  triggerLabel: z.string().default("approved"),
  baseBranch: z.string().default("develop"),
  featureBranch: z.string().default("features"),
  skillPath: z.string().optional(),
  revisionSkillPath: z.string().optional(),
  prompt: z.string().optional(),

  // Multi-repo
  repos: z.array(repoEntrySchema).optional(),

  // Global settings
  pollIntervalMs: z.coerce.number().int().positive().default(300_000),
  // How many repos may run their pipeline at the same time. Repos are safe to
  // run concurrently on their own — each has its own git working clone, so two
  // can never touch the same checkout — so this cap is about SPEND, not safety:
  // each concurrent repo means another Claude session (up to maxTurns) and
  // another stream of GitHub API calls. Default 3; raise it deliberately after
  // watching what it costs. Set to 1 for the original strictly-serial behaviour.
  maxConcurrentRepos: z.coerce.number().int().positive().default(3),
  // Base window for the escalating per-issue skip back-off. The Nth consecutive
  // skip of an issue waits skipBackoffMs * 2^(N-1), capped at SKIP_BACKOFF_MAX_MS.
  // Additive + OSS-safe: defaults to the historical fixed 30 min, so an existing
  // .ai-agent.json keeps working with no new key (the first window is unchanged;
  // only repeat skips of the SAME issue back off further). slashbin-ai-foreman#32.
  skipBackoffMs: z.coerce.number().int().positive().default(1_800_000),
  // How long a repo's open-issue snapshot stays warm. The discovery phases each
  // used to run their own `gh issue list` against the same repo — six GraphQL
  // requests per repo per cycle, which at 20 repos on a 60s poll blew GitHub's
  // 5,000/hour GraphQL ceiling and left the token permanently exhausted. One
  // snapshot per repo per cycle serves all six. Must stay BELOW pollIntervalMs
  // so each cycle sees fresh data; the default is half the shipped 60s floor.
  // Set to 0 to disable caching and restore one live query per lookup.
  // Additive + OSS-safe: an existing .ai-agent.json needs no new key.
  issueCacheTtlMs: z.coerce.number().int().nonnegative().default(30_000),
  // Page cap for that snapshot. It must exceed a repo's OPEN issue count, which
  // is larger than any single label slice the old per-label queries fetched —
  // hence 500 rather than the previous 100. Truncation is logged, never silent.
  issueSnapshotLimit: z.coerce.number().int().positive().default(500),
  maxTurns: z.coerce.number().int().positive().default(30),
  maxDurationMs: z.coerce.number().int().positive().default(1_800_000),
  allowedTools: z.array(z.string()).default(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]),
  logFormat: z.enum(["json", "text"]).default("text"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // --- Review phase (Phase 1 in the cycle) ---
  // Additive + OSS-safe: reviewEnabled defaults to false, so a vanilla
  // .ai-agent.json keeps the original reconcile/revise/implement/sync/promote
  // behavior with no review step. We opt in via our own .ai-agent.json.
  //
  // The review phase invokes the EM repo's /review-all-prs skill in a headless
  // Claude session whose cwd is the EM repo (NOT the service repo) so it has the
  // EM's MCP servers, npm scripts, and context/docs. It runs under the EM GitHub
  // token for EM-account review attribution.
  emRepoPath: z.string().optional(),
  reviewEnabled: z.boolean().default(false),
  reviewSkillPath: z.string().default(".claude/skills/review-all-prs/SKILL.md"),
  reviewModel: z.string().optional(),
  // The review skill is long-running (it polls Railway deploys during dev verify),
  // so it gets a much larger turn/duration budget than implement/revise.
  reviewMaxTurns: z.coerce.number().int().positive().default(200),
  reviewMaxDurationMs: z.coerce.number().int().positive().default(3_600_000),
  // After a review run, set the issue's outcome label from the run's own
  // FOREMAN_REVIEW trailer when the skill merged the PR but left the issue at
  // `pr under review`. Defaults to true.
  //
  // Default-on is safe for existing deployments because the reconciler is a
  // REPAIR, not a policy: it only writes when the expected label is absent, only
  // for an issue a merged PR provably closed, and only to the label the run
  // itself reported. A skill that labels correctly never reaches the write — the
  // behavior of a healthy pipeline is bit-for-bit unchanged. Set false to keep
  // the label a strictly agent-owned act.
  //
  // NOT z.coerce.boolean(): env vars arrive as strings and Boolean("false") is
  // true, so coercion would silently ignore the one value anyone disabling this
  // would actually type.
  reviewLabelReconcile: z.preprocess(
    (v) => (typeof v === "string" ? !/^(0|false|no|off)$/i.test(v.trim()) : v),
    z.boolean(),
  ).default(true),
  // Broad tool surface — the skill drives GitHub, Postgres, Redis, Railway, and
  // the knowledge index via MCP, plus shell scripts and file reads.
  reviewAllowedTools: z.array(z.string()).default([
    "Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch",
    "mcp__github__*",
    "mcp__pg-dev-console__*", "mcp__pg-dev-worker__*",
    "mcp__pg-prod-console__*", "mcp__pg-prod-worker__*",
    "mcp__redis-dev-console__*", "mcp__redis-dev-ingest__*", "mcp__redis-dev-worker__*",
    "mcp__redis-prod-console__*", "mcp__redis-prod-ingest__*", "mcp__redis-prod-worker__*",
    "mcp__railway__*",
    "mcp__slashbin-ai-knowledge__*",
  ]),
  // GitHub login the review runs as — used by the freshness guard to detect a
  // review already posted for the current PR head (avoids re-review loops).
  reviewerLogin: z.string().default("slashbin-engineering-manager"),
});

// --- Types ---

/**
 * Fully resolved per-repo config. Contains both repo-specific settings and
 * global settings, so downstream functions only need this one type.
 * This is also the unit of work — one daemon per repo just uses one RepoConfig.
 */
export interface RepoConfig {
  name: string;
  repoPath: string;
  githubRepo: string;
  triggerLabel: string;
  baseBranch: string;
  featureBranch: string;
  skillPath?: string;
  revisionSkillPath?: string;
  prompt?: string;
  model?: string;
  maxTurns: number;
  maxDurationMs: number;
  allowedTools: string[];
  // Whether the review phase runs for this repo (resolved from per-repo override
  // or the global reviewEnabled default).
  reviewEnabled: boolean;
}

/**
 * Top-level daemon config. Contains resolved repos and daemon-level settings.
 * Use `config.repos[i]` to get the RepoConfig for each repo.
 */
export interface AgentConfig {
  repos: readonly RepoConfig[];
  pollIntervalMs: number;
  /** Max repos running their pipeline at once (default 3). Caps spend, not risk. */
  maxConcurrentRepos: number;
  /** Base window for the escalating per-issue skip back-off (default 30 min). */
  skipBackoffMs: number;
  /** How long a repo's open-issue snapshot stays warm (default 30s; 0 disables). */
  issueCacheTtlMs: number;
  /** Page cap for the open-issue snapshot (default 500). */
  issueSnapshotLimit: number;
  logFormat: "json" | "text";
  logLevel: "debug" | "info" | "warn" | "error";

  // --- Review phase settings (shared across repos) ---
  // emRepoPath is the absolute path to the EM repo whose /review-all-prs skill
  // we invoke. Undefined when review is disabled everywhere.
  emRepoPath?: string;
  reviewSkillPath: string;
  reviewModel?: string;
  reviewMaxTurns: number;
  reviewMaxDurationMs: number;
  reviewAllowedTools: string[];
  reviewerLogin: string;
  reviewLabelReconcile: boolean;
}

// --- Helpers ---

function inferGithubRepo(repoPath: string): string | undefined {
  try {
    const remote = execSync("git remote get-url origin", {
      cwd: resolve(repoPath),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function loadConfigFile(configPath?: string): Record<string, unknown> {
  const paths = configPath
    ? [resolve(configPath)]
    : [resolve(".ai-agent.json"), resolve("ai-agent.config.json")];

  for (const p of paths) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    }
  }
  return {};
}

// --- Config Loading ---

export function loadConfig(configPath?: string): AgentConfig {
  const fileConfig = loadConfigFile(configPath);

  const merged = {
    repoPath: process.env.AI_AGENT_REPO_PATH ?? fileConfig.repoPath,
    githubRepo: process.env.AI_AGENT_GITHUB_REPO ?? fileConfig.githubRepo,
    triggerLabel: process.env.AI_AGENT_TRIGGER_LABEL ?? fileConfig.triggerLabel,
    pollIntervalMs: process.env.AI_AGENT_POLL_INTERVAL_MS ?? fileConfig.pollIntervalMs,
    maxConcurrentRepos: process.env.AI_AGENT_MAX_CONCURRENT_REPOS ?? fileConfig.maxConcurrentRepos,
    skipBackoffMs: process.env.AI_AGENT_SKIP_BACKOFF_MS ?? fileConfig.skipBackoffMs,
    issueCacheTtlMs: process.env.AI_AGENT_ISSUE_CACHE_TTL_MS ?? fileConfig.issueCacheTtlMs,
    issueSnapshotLimit: process.env.AI_AGENT_ISSUE_SNAPSHOT_LIMIT ?? fileConfig.issueSnapshotLimit,
    skillPath: process.env.AI_AGENT_SKILL_PATH ?? fileConfig.skillPath,
    prompt: process.env.AI_AGENT_PROMPT ?? fileConfig.prompt,
    baseBranch: process.env.AI_AGENT_BASE_BRANCH ?? fileConfig.baseBranch,
    featureBranch: process.env.AI_AGENT_FEATURE_BRANCH ?? fileConfig.featureBranch,
    maxTurns: process.env.AI_AGENT_MAX_TURNS ?? fileConfig.maxTurns,
    maxDurationMs: process.env.AI_AGENT_MAX_DURATION_MS ?? fileConfig.maxDurationMs,
    allowedTools: fileConfig.allowedTools,
    logFormat: process.env.AI_AGENT_LOG_FORMAT ?? fileConfig.logFormat,
    logLevel: process.env.AI_AGENT_LOG_LEVEL ?? fileConfig.logLevel,
    repos: fileConfig.repos,
    // Review phase
    emRepoPath: process.env.AI_AGENT_EM_REPO_PATH ?? fileConfig.emRepoPath,
    reviewEnabled: fileConfig.reviewEnabled,
    reviewSkillPath: fileConfig.reviewSkillPath,
    reviewModel: fileConfig.reviewModel,
    reviewMaxTurns: process.env.AI_AGENT_REVIEW_MAX_TURNS ?? fileConfig.reviewMaxTurns,
    reviewMaxDurationMs: process.env.AI_AGENT_REVIEW_MAX_DURATION_MS ?? fileConfig.reviewMaxDurationMs,
    reviewAllowedTools: fileConfig.reviewAllowedTools,
    reviewerLogin: fileConfig.reviewerLogin,
    reviewLabelReconcile: process.env.AI_AGENT_REVIEW_LABEL_RECONCILE ?? fileConfig.reviewLabelReconcile,
  };

  // Remove undefined keys so Zod defaults apply
  const cleaned = Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined)
  );

  const parsed = configSchema.parse(cleaned);

  // Global settings shared by all repos (used as fallback when a per-repo entry
  // doesn't specify its own value)
  const globals = {
    allowedTools: [...parsed.allowedTools],
  };

  let repos: RepoConfig[];

  if (parsed.repos && parsed.repos.length > 0) {
    // Multi-repo mode
    repos = parsed.repos.map((entry) => {
      const repoPath = resolve(entry.repoPath);
      let githubRepo = entry.githubRepo;
      if (!githubRepo) {
        githubRepo = inferGithubRepo(repoPath);
        if (!githubRepo) {
          throw new Error(
            `githubRepo could not be inferred for repo "${entry.name}". Set it explicitly.`
          );
        }
      }
      return {
        name: entry.name,
        repoPath,
        githubRepo,
        triggerLabel: entry.triggerLabel ?? parsed.triggerLabel,
        baseBranch: entry.baseBranch ?? parsed.baseBranch,
        featureBranch: entry.featureBranch ?? parsed.featureBranch,
        skillPath: entry.skillPath,
        revisionSkillPath: entry.revisionSkillPath,
        prompt: entry.prompt,
        model: entry.model,
        maxTurns: entry.maxTurns ?? parsed.maxTurns,
        maxDurationMs: entry.maxDurationMs ?? parsed.maxDurationMs,
        reviewEnabled: entry.reviewEnabled ?? parsed.reviewEnabled,
        ...globals,
      };
    });
  } else {
    // Single-repo mode (backward compat)
    const repoPath = resolve(parsed.repoPath);
    let githubRepo = parsed.githubRepo;
    if (!githubRepo) {
      githubRepo = inferGithubRepo(repoPath);
      if (!githubRepo) {
        throw new Error(
          "githubRepo could not be inferred from git remote. Set AI_AGENT_GITHUB_REPO or githubRepo in config."
        );
      }
    }
    repos = [{
      name: githubRepo.split("/").pop()!,
      repoPath,
      githubRepo,
      triggerLabel: parsed.triggerLabel,
      baseBranch: parsed.baseBranch,
      featureBranch: parsed.featureBranch,
      skillPath: parsed.skillPath,
      revisionSkillPath: parsed.revisionSkillPath,
      prompt: parsed.prompt,
      maxTurns: parsed.maxTurns,
      maxDurationMs: parsed.maxDurationMs,
      reviewEnabled: parsed.reviewEnabled,
      ...globals,
    }];
  }

  // Resolve emRepoPath to absolute once (used by the review phase as the spawn cwd).
  const emRepoPath = parsed.emRepoPath ? resolve(parsed.emRepoPath) : undefined;

  // Fail fast on misconfiguration: review enabled somewhere but no EM repo path.
  if (!emRepoPath && repos.some((r) => r.reviewEnabled)) {
    throw new Error(
      "reviewEnabled is true for at least one repo but emRepoPath is not set. " +
      "Set emRepoPath (path to the EM repo holding the /review-all-prs skill) or set AI_AGENT_EM_REPO_PATH."
    );
  }

  return Object.freeze({
    repos: Object.freeze(repos),
    pollIntervalMs: parsed.pollIntervalMs,
    maxConcurrentRepos: parsed.maxConcurrentRepos,
    skipBackoffMs: parsed.skipBackoffMs,
    issueCacheTtlMs: parsed.issueCacheTtlMs,
    issueSnapshotLimit: parsed.issueSnapshotLimit,
    logFormat: parsed.logFormat,
    logLevel: parsed.logLevel,
    emRepoPath,
    reviewSkillPath: parsed.reviewSkillPath,
    reviewModel: parsed.reviewModel,
    reviewMaxTurns: parsed.reviewMaxTurns,
    reviewMaxDurationMs: parsed.reviewMaxDurationMs,
    reviewAllowedTools: [...parsed.reviewAllowedTools],
    reviewerLogin: parsed.reviewerLogin,
    reviewLabelReconcile: parsed.reviewLabelReconcile,
  });
}
