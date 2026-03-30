# slashbin-ai-foreman

**Turn approved GitHub issues into shipped pull requests — autonomously.**

The Foreman is an AI engineering agent that polls your repo, picks up approved work, implements it with [Claude Code](https://docs.anthropic.com/en/docs/claude-code), opens a PR, and responds to reviewer feedback. No manual intervention. Uses your CLI subscription — no per-run API costs.

## Who this is for

- **Engineering teams** that want an AI teammate picking up approved issues overnight
- **Solo developers** who want their backlog to shrink while they sleep
- **Vibe coders** whose AI handles the planning — the Foreman handles the execution
- **Teams running AI employees** via [slashbin-ai-team](https://github.com/xrgarcia/slashbin-ai-team) who need autonomous implementation behind the coordination layer

## What the Foreman does

```
Poll GitHub → Find approved issues → Implement with Claude → Create PR → Handle review feedback → Repeat
```

- **Polls GitHub** every 5 minutes for issues with a trigger label (default: `approved`)
- **Implements one issue at a time** — focused, sequential execution
- **Creates pull requests** with full context from the issue
- **Watches for review feedback** — automatically revises based on PR comments
- **Prioritizes revisions over new work** — reviewer feedback always comes first
- **Persists state across restarts** — picks up where it left off
- **Graceful shutdown** — waits for in-progress work before stopping

## How it fits together

The Foreman is one layer in an AI engineering pipeline:

1. **Product Owner** defines what to build (issues in GitHub)
2. **Engineering Manager** decomposes epics into implementation tasks and approves them
3. **Foreman** picks up approved issues, implements them, and opens PRs
4. **Reviewers** (human or AI) provide feedback — Foreman revises automatically

This is the pattern behind [slashbin.ai](https://slashbin.ai) — structured context in, autonomous execution out. The Foreman doesn't need to understand your business. It reads the issue, reads the repo's CLAUDE.md, and builds.

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/xrgarcia/slashbin-ai-foreman.git
cd slashbin-ai-foreman
npm install && npm run build

# 2. Ensure claude and gh CLIs are installed and authenticated
claude --version
gh auth status

# 3. Start the daemon
npm start
```

## Daemon management

```bash
npm start          # Start daemon in background
npm stop           # Graceful stop (waits for in-progress work)
npm restart        # Stop + start
npm run status     # Show running state, uptime, recent logs
npm run logs       # Show last 30 lines of agent.log
npm run logs -- 100 # Show last 100 lines

# Foreground / debugging
npm run start:fg   # Run in foreground (ctrl+c to stop)
npm run once       # Run one poll cycle and exit
npm run dev        # Watch mode (auto-reload on source changes)
```

## Configuration

Create `.ai-agent.json` in your repo root, or use environment variables. Env vars take precedence.

| Config Field | Env Var | Default | Description |
|---|---|---|---|
| `repoPath` | `AI_AGENT_REPO_PATH` | `.` | Path to local repo clone |
| `githubRepo` | `AI_AGENT_GITHUB_REPO` | *(from git remote)* | GitHub `owner/repo` |
| `triggerLabel` | `AI_AGENT_TRIGGER_LABEL` | `approved` | Label that triggers implementation |
| `pollIntervalMs` | `AI_AGENT_POLL_INTERVAL_MS` | `300000` (5 min) | Poll interval in milliseconds |
| `skillPath` | `AI_AGENT_SKILL_PATH` | — | Path to a Claude Code skill file |
| `prompt` | `AI_AGENT_PROMPT` | *(built-in)* | Custom prompt template |
| `baseBranch` | `AI_AGENT_BASE_BRANCH` | `develop` | PR target branch |
| `featureBranch` | `AI_AGENT_FEATURE_BRANCH` | `features` | Branch to commit to |
| `maxTurns` | `AI_AGENT_MAX_TURNS` | `30` | Max agent turns per issue |
| `maxDurationMs` | `AI_AGENT_MAX_DURATION_MS` | `1800000` (30 min) | Max implementation time |
| `allowedTools` | — | `["Read","Write","Edit","Bash","Glob","Grep"]` | Tools the CLI can use |
| `logFormat` | `AI_AGENT_LOG_FORMAT` | `text` | `json` or `text` |
| `logLevel` | `AI_AGENT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

### Prompt template variables

The prompt supports these placeholders:

- `{{issue_number}}` — GitHub issue number
- `{{issue_title}}` — Issue title
- `{{issue_body}}` — Issue body (markdown)

## Using with skills

Point the Foreman to a Claude Code skill file for repo-specific implementation workflows:

```json
{
  "skillPath": ".claude/skills/implement-approved-issues/SKILL.md"
}
```

The Foreman instructs Claude to read and follow the skill before implementing each issue.

## Programmatic usage

```typescript
import { startDaemon, loadConfig, createLogger } from "slashbin-ai-foreman";

const config = loadConfig();
const logger = createLogger({ format: "json", level: "info" });
const daemon = startDaemon(config, logger);

// Graceful shutdown
process.on("SIGINT", () => daemon.stop());
```

## Architecture

```
src/
├── cli.ts           # CLI entry point
├── config.ts        # Configuration loading + Zod validation
├── logger.ts        # Structured logging (JSON/text)
├── github.ts        # GitHub polling via gh CLI
├── agent.ts         # Claude Code CLI spawner
├── reviewer.ts      # PR review feedback handler
├── orchestrator.ts  # Concurrency control + state tracking
├── state.ts         # Persistent state management
├── daemon.ts        # Poll loop + graceful shutdown
└── index.ts         # Public API exports
```

## Built with

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — AI implementation engine
- [GitHub CLI (gh)](https://cli.github.com/) — issue polling and PR management
- TypeScript + Zod — type-safe configuration

## License

MIT
