import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const configSchema = z.object({
  repoPath: z.string().default("."),
  githubRepo: z.string().optional(),
  triggerLabel: z.string().default("approved"),
  pollIntervalMs: z.coerce.number().int().positive().default(300_000),
  skillPath: z.string().optional(),
  prompt: z.string().optional(),
  baseBranch: z.string().default("develop"),
  featureBranch: z.string().default("features"),
  maxTurns: z.coerce.number().int().positive().default(30),
  maxDurationMs: z.coerce.number().int().positive().default(1_800_000),
  allowedTools: z.array(z.string()).default(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]),
  logFormat: z.enum(["json", "text"]).default("text"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AgentConfig = z.infer<typeof configSchema>;

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
  };

  // Remove undefined keys so Zod defaults apply
  const cleaned = Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined)
  );

  const config = configSchema.parse(cleaned);

  // Infer githubRepo from git remote if not provided
  if (!config.githubRepo) {
    const inferred = inferGithubRepo(config.repoPath);
    if (!inferred) {
      throw new Error(
        "githubRepo could not be inferred from git remote. Set AI_AGENT_GITHUB_REPO or githubRepo in config."
      );
    }
    (config as { githubRepo: string }).githubRepo = inferred;
  }

  return Object.freeze(config);
}
