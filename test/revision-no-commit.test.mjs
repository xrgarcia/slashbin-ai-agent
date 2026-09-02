// A revision round that correctly changes nothing must be able to say so.
//
// Slashbin-console#843, 2026-09-02. The reviewer requested changes; the reviser
// determined the branch was already correct and pushed nothing; the SHA guard
// marked the run failed; the orchestrator therefore never transitioned
// "pr pending actions" -> "pr under review"; and the review phase only picks up
// PRs at "pr under review". The PR became permanently unreviewable, and from
// outside it looked like the Foreman had simply stopped reviewing.
//
// Behavioural halves, both pinned here:
//   1. a DECLARED no-commit returns success (so the labels move), while a
//      SILENT one still fails (the guard's original purpose is intact), and
//   2. two declared no-commits in a row escalate instead of ping-ponging.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agent = readFileSync(join(root, "src/agent.ts"), "utf-8");
const orchestrator = readFileSync(join(root, "src/orchestrator.ts"), "utf-8");

/** The live regex, lifted from source so the test cannot drift from it. */
function noCommitPattern() {
  const m = agent.match(/const REVISION_NO_COMMIT = (\/.+\/[a-z]*);/);
  assert.ok(m, "REVISION_NO_COMMIT is gone — the declared no-commit path cannot work");
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

test("a declared no-commit parses, and carries its reason", () => {
  const re = noCommitPattern();
  const out = [
    "Read the review. Verified HEAD 9f78390 already satisfies every ask.",
    "FOREMAN_REVISION no-commit reason=the last review asked for no commit; the S2 guard is already in place",
  ].join("\n");
  const m = re.exec(out);
  assert.ok(m, "a well-formed trailer must parse");
  assert.match(m[1], /already in place/, "the reason must be captured, not just detected");
});

test("a bare no-commit claim without a reason does NOT parse", () => {
  const re = noCommitPattern();
  assert.equal(re.exec("FOREMAN_REVISION no-commit"), null,
    "a reasonless claim is indistinguishable from the silent no-op the guard exists to catch");
  assert.equal(re.exec("I decided no commit was needed."), null,
    "prose must never satisfy the gate — that is the lesson of the review-body gate (EM 9ed3c02)");
});

test("the SHA guard returns success ONLY on a declared no-commit", () => {
  const guard = agent.slice(agent.indexOf("if (beforeSha && afterSha && beforeSha === afterSha)"));
  const block = guard.slice(0, 2000);
  assert.match(block, /REVISION_NO_COMMIT\.exec/,
    "the guard must consult the trailer before failing the run");
  assert.match(block, /return \{ success: true, noCommit: true/,
    "a declared no-commit must return success, or the labels never move");
  assert.match(block, /return \{ success: false, error: "no commits pushed/,
    "an UNdeclared no-op must still fail — that is the guard's original purpose");
  assert.ok(block.indexOf("REVISION_NO_COMMIT.exec") < block.indexOf("success: false"),
    "the declaration must be checked BEFORE the failure path, not after");
});

test("the agent is told how to declare it, in both prompt branches", () => {
  assert.match(agent, /FOREMAN_REVISION no-commit reason=/,
    "an agent that is never told the trailer exists will never emit it");
  const uses = agent.match(/\$\{noCommitNote\}/g) ?? [];
  assert.equal(uses.length, 2,
    `both the skill-driven and fallback prompts must carry it — found ${uses.length}`);
});

test("two declared no-commits in a row escalate instead of looping", () => {
  assert.match(orchestrator, /const consecutiveNoCommit = new Map<string, number>\(\)/,
    "no bookkeeping means a reviewer/reviser disagreement ping-pongs forever");
  const block = orchestrator.slice(orchestrator.indexOf("if (result.noCommit)"), orchestrator.indexOf("if (result.noCommit)") + 2000);
  assert.match(block, /MAX_CONSECUTIVE_NO_COMMIT/, "the cap must be applied, not just declared");
  assert.match(block, /events\.push/, "a stalemate nobody is told about looks exactly like an idle queue");
  assert.match(block, /level: "error"/, "two agents deadlocked is an error-level condition");
  assert.match(block, /return null/, "on escalation it must NOT re-label, or the loop continues");
});

test("the no-commit streak clears on a real push and when feedback clears", () => {
  const deletes = orchestrator.match(/consecutiveNoCommit\.delete\(repoName\)/g) ?? [];
  assert.ok(deletes.length >= 2,
    `a streak that never resets escalates a healthy repo later — found ${deletes.length} clear sites`);
});
