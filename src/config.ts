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
  prompt: z.string().optional(),
});

const configSchema = z.object({
  // Single-repo fields (backward compat — ignored when repos[] is provided)
  repoPath: z.string().default("."),
  githubRepo: z.string().optional(),
  triggerLabel: z.string().default("approved"),
  baseBranch: z.string().default("develop"),
  featureBranch: z.string().default("features"),
  skillPath: z.string().optional(),
  prompt: z.string().optional(),

  // Multi-repo
  repos: z.array(repoEntrySchema).optional(),

  // Global settings
  pollIntervalMs: z.coerce.number().int().positive().default(300_000),
  maxTurns: z.coerce.number().int().positive().default(30),
  maxDurationMs: z.coerce.number().int().positive().default(1_800_000),
  allowedTools: z.array(z.string()).default(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]),
  logFormat: z.enum(["json", "text"]).default("text"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
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
  prompt?: string;
  maxTurns: number;
  maxDurationMs: number;
  allowedTools: string[];
}

/**
 * Top-level daemon config. Contains resolved repos and daemon-level settings.
 * Use `config.repos[i]` to get the RepoConfig for each repo.
 */
export interface AgentConfig {
  repos: readonly RepoConfig[];
  pollIntervalMs: number;
  logFormat: "json" | "text";
  logLevel: "debug" | "info" | "warn" | "error";
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
  };

  // Remove undefined keys so Zod defaults apply
  const cleaned = Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined)
  );

  const parsed = configSchema.parse(cleaned);

  // Global settings shared by all repos
  const globals = {
    maxTurns: parsed.maxTurns,
    maxDurationMs: parsed.maxDurationMs,
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
        prompt: entry.prompt,
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
      prompt: parsed.prompt,
      ...globals,
    }];
  }

  return Object.freeze({
    repos: Object.freeze(repos),
    pollIntervalMs: parsed.pollIntervalMs,
    logFormat: parsed.logFormat,
    logLevel: parsed.logLevel,
  });
}
