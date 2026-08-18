# slashbin-ai-agent (Foreman)

Open-source daemon that drives GitHub work through Claude Code CLI: it implements
approved issues, reviews the resulting PRs, revises them on feedback, and promotes
merged work — across many repos from a single process.

## Cycle

Each poll cycle runs six phases across every configured repo. Phases run in this
order so labels set in one phase are consumed by the right phase next cycle:

```
Reconcile → Review → Revise → Implement → Branch Sync → Promote
```

1. **Reconcile** — detect orphaned commits on the feature branch with no PR; open one.
2. **Review** *(opt-in, `reviewEnabled`)* — for repos with an open feature PR whose
   linked issue is labeled `pr under review`, invoke a **review skill** that reviews,
   merges clean PRs to the base branch, verifies, and transitions labels itself. Runs
   first among PR-acting phases so it only acts on PRs labeled in a *prior* cycle
   (labels settled → no same-cycle race). See **Review phase** below.
3. **Revise** — for issues labeled `pr pending actions` with an open feature PR, invoke
   the revision skill to address review feedback. Prioritized over new implementation.
4. **Implement** — pick up `approved` issues with no delivering PR and invoke the
   implementation skill; on success label the issue `pr under review`.
5. **Branch Sync** — merge `main → develop` to clear post-promotion drift.
6. **Promote** — create `develop → main` promotion PRs for `ready for prod release` issues.

Priority within a cycle is encoded by phase order. Only one Claude session runs at a
time (`implementing` mutex) for git-state safety.

## Review phase

The Review phase is categorically different from Implement/Revise, because review is a
decision-layer workflow rather than an in-repo edit:

- **Runs in a separate review repo.** The review skill is spawned with its working
  directory set to `emRepoPath` (not the service repo), so it has the reviewer's own
  MCP servers, verification scripts, and context docs.
- **Runs under a separate token.** Reviews/merges are attributed to `EM_GITHUB_TOKEN`
  (distinct from `FOREMAN_GITHUB_TOKEN`) — reviewer identity ≠ implementer identity.
- **Owns its own outcomes.** The skill posts the verdict, merges approved PRs, and
  transitions issue labels itself; the orchestrator does **not** relabel afterward. Its
  label side effects feed the other phases (approve → `ready for prod release` → Promote;
  request-changes → `pr pending actions` → Revise).

Gating (`findPRsNeedingReview`): an open `featureBranch → baseBranch` PR whose linked
issue is `pr under review` (not `pr pending actions`) and with no review by
`reviewerLogin` newer than the PR's latest commit (freshness guard against re-review
loops). Every run's full turn-by-turn interaction (`--output-format stream-json`) is
written to `logs/review/<repo>-cycle<N>-<ts>.log` for debugging.

Disabled by default; opt in per repo with `reviewEnabled` and set `emRepoPath`. See
README "Review phase (opt-in)" for the full config table.

## State (persisted to disk)

Durable state lives in `.agent-state.json` in the daemon's directory (not the target
repo), written after every change and loaded on startup so the daemon survives restarts.

- `implemented` — issue numbers already delivered by a PR (self-heals when a tracked
  entry has no delivering PR — see `docs/implemented-cache-self-heal.md`).
- `skipped` — per-issue back-off records for issues the agent deliberately declined
  (investigation-only, blocked-on-external-verification); cleared on success or after
  the back-off window. Some transient skip reasons are re-checked and admitted early.
- `failed` / failure counters — per-repo consecutive-failure counts with cooldown
  (after `MAX_RETRIES` failures, skip the repo for `FAILURE_COOLDOWN_CYCLES`).

In-memory only: `implementing` mutex (reset on restart — safe).

## Architecture

```
src/
├── cli.ts           # CLI entry point (--once, --repo, --help, --version)
├── config.ts        # Zod-validated config from .ai-agent.json + env vars
├── logger.ts        # Structured logging (JSON/text, levels, child contexts)
├── github.ts        # gh-CLI helpers (issues, PRs, labels, branch drift, review gate)
├── agent.ts         # Spawns claude CLI (implement / revise / review)
├── reconciler.ts    # Orphaned-commit reconciliation + branch-divergence checks
├── state.ts         # Disk persistence (.agent-state.json)
├── orchestrator.ts  # 6-phase cycle, failure cooldowns, label transitions
├── daemon.ts        # Poll loop, config hot-reload, Discord bridge, graceful shutdown
└── index.ts         # Public API exports
```

## Prerequisites

- `claude` CLI installed and authenticated
- `gh` CLI installed; tokens supplied via env (`FOREMAN_GITHUB_TOKEN`; `EM_GITHUB_TOKEN`
  when the Review phase is enabled)
- Node.js >= 18

## Key design decisions

- **Skills own the workflow; the Foreman just triggers.** Implement/revise/review logic
  lives in skills (in the service repo for implement/revise, in `emRepoPath` for review),
  not in TypeScript. The daemon discovers work, spawns Claude on the right skill, and
  reconciles labels/state.
- **One Claude session at a time** — resource + git-state safety.
- **Phase order is the priority order** — reconcile and review settle prior-cycle state
  before new implementation starts.
- **Additive, opt-in config** — new capabilities (e.g. Review) default off so existing
  `.ai-agent.json` files keep working unchanged.
- **Disk persistence** — `.agent-state.json` survives restarts; the daemon resumes where
  it left off.
