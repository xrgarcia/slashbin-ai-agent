# slashbin-ai-agent

Open-source daemon that implements GitHub issues using Claude Code CLI.

## Daemon Lifecycle

```
Poll GitHub ──► Find approved issues ──► Implement with Claude ──► Create PR ──►┐
                                                                                 │
┌────────────────────────────────────────────────────────────────────────────────┘
│
▼
Watch PR for review feedback ──► Reviewer requests changes? ──► Yes ──►┐
                                 │                                      │
                                 ▼ No                                   │
                          Keep watching                                 │
                                                                        │
┌───────────────────────────────────────────────────────────────────────┘
│
▼
Comment "ACK — changes underway" ──► Spawn Claude to revise ──► Push changes
──► Comment "Changes pushed, please review" ──► Back to watching
```

## Full Workflow

### Phase 1: Implementation

1. **Poll** — every 5 minutes (configurable), query GitHub for open issues with the `approved` label that don't have a linked open PR
2. **Skip** — issues labeled `blocked`, already implemented this session, or failed too many times (2 retries)
3. **Implement** — spawn `claude --print` with the issue body as prompt. Claude reads the issue, implements, commits, pushes, and creates a PR
4. **Track** — on success, extract the PR number from Claude's output and start watching it for review feedback

### Phase 2: Revision Cycle (priority over new implementations)

Each poll cycle checks for pending revisions BEFORE looking for new issues.

1. **Check tracked PRs** — for each PR the daemon created:
   - If PR is closed/merged: remove from tracking
   - If PR is approved: mark as approved, stop watching
   - If PR has new review comments or changes requested: queue for revision
2. **ACK** — comment on the PR: "Acknowledged — changes underway based on review feedback."
3. **Revise** — spawn `claude --print` with:
   - The review comments/feedback as context
   - Instructions to `gh pr checkout <N>`, make changes, commit, push
4. **Notify** — comment on PR: "Changes pushed addressing review feedback. Please review."
5. **Track** — increment revision count, update last-addressed comment/review IDs
6. **Max attempts** — after 3 revision rounds (configurable), comment "Maximum revision attempts reached. Manual intervention needed." and stop watching

### Priority Order

Each poll cycle:
1. **Revisions first** — address reviewer feedback on existing PRs
2. **New implementations** — pick up new approved issues only when no revisions are pending

### Self-Loop Prevention

The daemon filters out its own comments and reviews when checking for new feedback. It identifies itself via `gh api user` (the authenticated gh user). This prevents the daemon from responding to its own ACK/completion comments.

### State (persisted to disk)

All durable state is saved to `.agent-state.json` in the daemon's directory (not the target repo). This file is written after every state change and loaded on startup, so the daemon survives restarts.

**Persisted:**
- `implemented` — set of issue numbers already implemented
- `failed` — map of issue numbers to failure count + last error
- `trackedPRs` — map of PR numbers to revision state (count, last addressed IDs, status)

**Transient (in-memory only):**
- `implementing` / `revising` — mutex, only one operation at a time. Reset on restart (safe — the daemon just picks up where it left off next cycle).

## Architecture

```
src/
├── cli.ts           # CLI entry point (--once, --help, --version)
├── config.ts        # Zod-validated config from .ai-agent.json + env vars
├── logger.ts        # Structured logging (JSON/text, levels)
├── github.ts        # GitHub polling via gh CLI (issues + PR reviews)
├── agent.ts         # Spawns claude CLI (implement + revise)
├── reviewer.ts      # PR tracking state machine (watch/revise/approved/abandoned)
├── state.ts         # Disk persistence (.agent-state.json)
├── orchestrator.ts  # Priority-aware cycle: revisions > new implementations
├── daemon.ts        # Poll loop + graceful shutdown
└── index.ts         # Public API exports
```

## Prerequisites

- `claude` CLI installed and authenticated (uses subscription, no API key)
- `gh` CLI installed and authenticated (uses existing auth, no token)
- Node.js >= 18

## Key Design Decisions

- **Claude Code CLI over Agent SDK** — uses flat-rate subscription instead of per-run API costs
- **gh CLI over Octokit** — uses existing machine auth, zero tokens to configure
- **One at a time** — never runs two Claude instances concurrently (resource + git state safety)
- **Revisions > new work** — always address reviewer feedback before picking up new issues
- **Daemon manager** — `agent-manager.mjs` provides start/stop/restart/status/logs with PID tracking (same pattern as slashbin-discord-bot)
- **Disk persistence** — `.agent-state.json` survives restarts; daemon resumes watching existing PRs and skips already-implemented issues
