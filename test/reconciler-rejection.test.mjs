// Guards for the reconciler's rejection handling and its git error reporting.
//
// Source-level assertions on purpose: reconcileRepo shells out to `git` and `gh`
// against a real clone, so exercising it here would need a fixture repo and a
// GitHub double. What actually regressed in the incidents these guard was the
// SHAPE of the code — a lookup that only saw open PRs, and a catch block that
// threw away the reason — and that is what these pin.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reconciler = readFileSync(join(root, "src/reconciler.ts"), "utf-8");
const orchestrator = readFileSync(join(root, "src/orchestrator.ts"), "utf-8");
const state = readFileSync(join(root, "src/state.ts"), "utf-8");

test("the reconciler looks up closed-unmerged PRs, not only open ones", () => {
  assert.match(
    reconciler,
    /function findLastClosedUnmergedPR/,
    "no closed-unmerged lookup — a rejected PR is invisible again",
  );
  const fn = reconciler.slice(reconciler.indexOf("function findLastClosedUnmergedPR"));
  assert.match(fn.slice(0, 900), /"--state", "closed"/, "the lookup must query closed PRs");
  assert.match(fn.slice(0, 900), /!p\.mergedAt/, "a merged PR is a delivery, not a rejection");
});

test("a branch unchanged since its rejection does not get a new PR", () => {
  const guard = reconciler.slice(reconciler.indexOf("const lastRejected"));
  assert.match(guard.slice(0, 1200), /headSha === lastRejected\.headSha/,
    "the guard must compare the branch head against the rejected head");
  const beforeCreate = guard.slice(0, guard.indexOf("createReconciliationPR"));
  assert.match(beforeCreate, /continue;/,
    "on a match it must skip the branch, not fall through to PR creation");
});

test("new commits on top of a rejection still reconcile, but say the bundle is dirty", () => {
  const guard = reconciler.slice(reconciler.indexOf("const lastRejected"));
  assert.match(guard.slice(0, 2000), /has new commits on top of a rejected PR/,
    "moving on without a warning is how a rejected diff rides along unnoticed");
});

test("git failures carry stderr and distinguish a shutdown from a fault", () => {
  assert.match(reconciler, /function formatGitError/, "no git error formatter");
  assert.match(reconciler, /cancelled: signal === "SIGTERM" \|\| signal === "SIGINT"/,
    "a signal-killed fetch must be reported as cancelled, not failed");
  const fetchCatch = reconciler.slice(reconciler.indexOf('git(["fetch", "origin"]'));
  assert.match(fetchCatch.slice(0, 900), /if \(failure\.cancelled\)/,
    "the fetch catch must branch on cancellation");
  assert.doesNotMatch(
    fetchCatch.slice(0, 900),
    /logger\.warn\("git fetch failed[^]*?error: err instanceof Error \? err\.message/,
    "the message-only warn is what masked the cause",
  );
});

test("a rejected branch is announced once per head SHA, not every cycle", () => {
  assert.match(state, /rejectedBranches\?: Record<string, string>/,
    "no persisted record — the alert would repeat every reconcile pass");
  const block = orchestrator.slice(orchestrator.indexOf("for (const r of result.rejected"));
  assert.match(block.slice(0, 1800), /alreadyAlerted === r\.headSha/,
    "dedup must key on the head SHA so new commits re-alert");
  assert.match(block.slice(0, 2400), /saveRepoState/, "the alert must be recorded");
});

test("the reconciler never force-pushes or resets a shared branch on its own", () => {
  assert.doesNotMatch(reconciler, /force-with-lease|--force|force=true|reset --hard/,
    "clearing pollution is destructive and stays a human decision (foreman#24)");
});
