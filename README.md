# slashbin-ai-agent

Lightweight daemon that watches a GitHub repo for issues with a trigger label and implements them using [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code). Uses your CLI subscription — no per-run API costs.

## How it works

```
Poll GitHub → Find approved issues → Implement with Claude → Create PR → Repeat
```

1. Polls GitHub every N minutes for open issues with a configurable label (default: `approved`)
2. Filters out issues that already have a linked PR or are labeled `blocked`
3. Invokes Claude Code CLI (`claude --print`) to implement the oldest eligible issue
4. One issue at a time — skips cycles while busy
5. Tracks implemented/failed issues in-memory to avoid re-processing

## Quick Start

```bash
# 1. Clone and install
git clone <repo-url>
cd slashbin-ai-agent
npm install && npm run build

# 2. Ensure claude and gh CLIs are installed and authenticated
claude --version
gh auth status

# 3. Start the daemon (background)
npm start
```

## Daemon Management

The agent runs as a background daemon managed by `agent-manager.mjs` (PID file + log file, same pattern as `slashbin-discord-bot`).

```bash
npm start          # Start daemon in background
npm stop           # Graceful stop (waits for in-progress work, up to 65s)
npm restart        # Stop + start
npm run status     # Show running state, uptime, recent logs
npm run logs       # Show last 30 lines of agent.log
npm run logs -- 100 # Show last 100 lines

# Foreground / one-shot (useful for debugging)
npm run start:fg   # Run in foreground (ctrl+c to stop)
npm run once       # Run one poll cycle and exit
npm run dev        # Watch mode (tsx, auto-reload on source changes)
```

Files created at runtime:
- `.agent.pid` — PID of the background process
- `agent.log` — stdout/stderr log (appended)

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

### Prompt Template Variables

The prompt supports these placeholders:

- `{{issue_number}}` — GitHub issue number
- `{{issue_title}}` — Issue title
- `{{issue_body}}` — Issue body (markdown)

## CLI Usage (direct)

```bash
node dist/cli.js                     # Start in foreground (polls continuously)
node dist/cli.js --once              # Run one cycle and exit
node dist/cli.js --config path.json  # Use specific config file
node dist/cli.js --version           # Print version
node dist/cli.js --help              # Show help
```

## Using with Skills

Point the agent to a Claude Code skill file for repo-specific implementation workflows:

```json
{
  "skillPath": ".claude/skills/implement-approved-issues/SKILL.md"
}
```

The agent will instruct Claude to read and follow the skill before implementing each issue.

## Programmatic Usage

```typescript
import { startDaemon, loadConfig, createLogger } from "slashbin-ai-agent";

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
├── orchestrator.ts  # Concurrency control + state tracking
├── daemon.ts        # Poll loop + graceful shutdown
└── index.ts         # Public API exports
```

## License

MIT
