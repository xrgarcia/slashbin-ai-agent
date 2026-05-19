# `implemented` cache self-heal — current-vs-correct model (Repeated-S1)

**Status:** decision artifact for the fix in `src/orchestrator.ts` (the
`tryBatchImplementation` `implemented`-filter region). Owner-approved
2026-05-19 (Option A: fix the model, not another attribution patch).

## The recurring defect (the family)

`slashbin-ai-foreman#16`, `#18`, and the 2026-05-19 `Slashbin-console#540`
incident are the same bug: an issue ends up in persistent
`RepoState.implemented` (a permanent skip list) **without a PR that actually
delivers it**, and nothing ever removes it → the issue is skipped every
implement cycle, forever ("self-locked", "manual EM cleanup every cycle").

## Why it keeps happening (current model)

- All issues for a repo share one `features` branch; one open PR on that
  branch accumulates multiple issues' commits.
- After a successful skill run the Foreman attributes "implemented" by
  scanning whatever open PR sits on `features` for `#N` references
  (`getReferencedIssuesFromOpenPR` → `matched`), then pushes those numbers
  to `repoState.implemented`.
- #540's commit landed on `features` *under #541's PR* (which is scoped to
  #539). #540 was thus "referenced", marked `implemented`, and got no PR of
  its own. Once #541 was REQUEST_CHANGES'd and #540's labels cleaned, #540
  was `implemented`-with-no-PR → the implement filter skips it every cycle;
  the revise phase only touches #541. Dead-zone.
- Every prior fix (#16, #18, the Case 1/2/3 logic) patched the *attribution
  heuristic*. The heuristic will always have edge cases on a shared branch.
  Patch N+1 at that layer is the wrong layer (Repeated-S1: stop, fix the
  model/invariant).

## Correct model

**Invariant:** `implemented[N]` ⟺ a PR that delivers N exists (open or
merged). `findActionableIssues` already computes the authoritative negation
of this (approved issues with **no** linked open/merged PR) — it is the same
check the orchestrator trusts to decide what to implement.

**Self-heal:** each cycle, reconcile the cache to the invariant. Any N that
is BOTH still returned by `findActionableIssues` (no delivering PR per the
live check) AND present in `repoState.implemented` is provably stale → prune
it, persist, log, let it re-implement. The dead-zone becomes
unrepresentable: an issue cannot remain `implemented` while the live
authoritative check says it has no delivering PR.

This does **not** reintroduce the re-implement loop the cache guards
against — that loop is "a PR exists but linkage detection missed it"; here
the same linkage check reports *no* PR, so there is nothing to loop on.
Genuine loops stay bounded by `failureCount`/cooldown + the skip back-off.

## Why this fix (not per-issue branches)

Per-issue branches would also dissolve the family but change the
`features`-branch / `.ai-agent.json` / env contract — a non-additive,
OSS-contract-breaking change (`feedback_foreman_oss_backward_compat`). The
self-heal is the minimal correct fix at the right layer (the invariant),
additive, no state-shape / config / branch-model change. Per-issue branches
remain a possible future proposal, not required to make the dead-zone
impossible.

## Scope / out of scope

In: the self-heal prune + log + persist before the `alreadyImplemented`
filter. Out: the one-time incident tail where #540's stale-scope commit is
physically commingled on Console `features` under #541 — handled
operationally after this lands (not a model defect).
