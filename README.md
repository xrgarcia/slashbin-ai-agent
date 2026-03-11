# slashbin-ai-agent

Lightweight daemon that watches a GitHub repo for issues with a trigger label and implements them using the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript).

## How it works

```
Poll GitHub → Find approved issues → Implement with Claude → Create PR → Repeat
```

1. Polls GitHub every N minutes for open issues with a configurable label (default: `approved`)
2. Filters out issues that already have a linked PR or are labeled `blocked`
3. Invokes the Claude Agent SDK to implement the oldest eligible issue
4. One issue at a time — skips cycles while busy
5. Tracks implemented/failed issues in-memory to avoid re-processing

## Quick Start

```bash
# 1. Install
npm install -g slashbin-ai-agent

# 2. Set required env vars
export GITHUB_TOKEN=ghp_...
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Run from your repo directory
cd /path/to/your/repo
slashbin-ai-agent
```

Or with npx (zero install):

```bash
GITHUB_TOKEN=ghp_... ANTHROPIC_API_KEY=sk-ant-... npx slashbin-ai-agent
```

## Configuration

Create `.ai-agent.json` in your repo root, or use environment variables. Env vars take precedence.

| Config Field | Env Var | Default | Description |
|---|---|---|---|
| `repoPath` | `AI_AGENT_REPO_PATH` | `.` | Path to local repo clone |
| `githubRepo` | `AI_AGENT_GITHUB_REPO` | *(from git remote)* | GitHub `owner/repo` |
| `githubToken` | `GITHUB_TOKEN` | **required** | GitHub PAT |
| `anthropicApiKey` | `ANTHROPIC_API_KEY` | **required** | Anthropic API key |
| `triggerLabel` | `AI_AGENT_TRIGGER_LABEL` | `approved` | Label that triggers implementation |
| `pollIntervalMs` | `AI_AGENT_POLL_INTERVAL_MS` | `300000` (5 min) | Poll interval in milliseconds |
| `skillPath` | `AI_AGENT_SKILL_PATH` | — | Path to a Claude Code skill file |
| `prompt` | `AI_AGENT_PROMPT` | *(built-in)* | Custom prompt template |
| `baseBranch` | `AI_AGENT_BASE_BRANCH` | `develop` | PR target branch |
| `featureBranch` | `AI_AGENT_FEATURE_BRANCH` | `features` | Branch to commit to |
| `maxTurns` | `AI_AGENT_MAX_TURNS` | `30` | Max agent turns per issue |
| `maxDurationMs` | `AI_AGENT_MAX_DURATION_MS` | `1800000` (30 min) | Max implementation time |
| `logFormat` | `AI_AGENT_LOG_FORMAT` | `text` | `json` or `text` |
| `logLevel` | `AI_AGENT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

### Prompt Template Variables

The prompt supports these placeholders:

- `{{issue_number}}` — GitHub issue number
- `{{issue_title}}` — Issue title
- `{{issue_body}}` — Issue body (markdown)

## CLI Usage

```bash
slashbin-ai-agent                    # Start daemon (polls continuously)
slashbin-ai-agent --once             # Run one cycle and exit
slashbin-ai-agent --config path.json # Use specific config file
slashbin-ai-agent --version          # Print version
slashbin-ai-agent --help             # Show help
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
├── github.ts        # GitHub polling (find actionable issues)
├── agent.ts         # Claude Agent SDK wrapper
├── orchestrator.ts  # Concurrency control + state tracking
├── daemon.ts        # Poll loop + graceful shutdown
└── index.ts         # Public API exports
```

## License

MIT
