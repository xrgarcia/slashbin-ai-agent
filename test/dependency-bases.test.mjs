// Regression tests for which branches a Dependabot PR may be merged into.
//
// Origin: owner decision, 2026-09-07. Dependabot targeted `develop`, so every
// dependency bump landed on `develop` and left `features` — the branch the
// Foreman and a human both start work from — one commit further behind. The
// flow is `features → develop → main`; dependency updates were the one class of
// change skipping the first hop. Dependabot is being retargeted to `features`.
//
// The repos flip one at a time, so the merge phase has to accept BOTH branches
// for the duration. That widening is the risk this file exists to bound: the
// one outcome the dependency phase must never produce is a merge to `main`,
// which is the defect `jerky_shipping#237` closed on the producing side.
//
// Before this change `tryMergeDependencyPR`'s comment claimed to "re-assert
// both invariants" and asserted only the head-branch one — the caller's filter
// was the only thing keeping a bump off `main`. Widening that filter without
// asserting the base would have widened it to anything.
//
// Run with `npm test` (node:test, no dependencies) after `npm run build`.
import test from "node:test";
import assert from "node:assert/strict";
import { dependencyMergeBases } from "../dist/github.js";

test("the normal repo accepts features and develop, in that order", () => {
  assert.deepEqual(dependencyMergeBases("features", "develop"), ["features", "develop"]);
});

test("main is never an acceptable base, from either field", () => {
  assert.deepEqual(dependencyMergeBases("features", "main"), ["features"]);
  assert.deepEqual(dependencyMergeBases("main", "develop"), ["develop"]);
});

test("a main-only repo yields no acceptable base at all", () => {
  // featureBranch === baseBranch === "main". The caller already skips these;
  // this asserts the phase is safe even if that guard is ever removed.
  assert.deepEqual(dependencyMergeBases("main", "main"), []);
});

test("identical feature and base branches dedupe to one entry", () => {
  assert.deepEqual(dependencyMergeBases("develop", "develop"), ["develop"]);
});

test("missing config fields drop out rather than producing an empty-string base", () => {
  // An empty string would match no PR, but it would also read as a configured
  // branch in the refusal log. Filter it at the source.
  assert.deepEqual(dependencyMergeBases(undefined, "develop"), ["develop"]);
  assert.deepEqual(dependencyMergeBases("features", undefined), ["features"]);
  assert.deepEqual(dependencyMergeBases("", ""), []);
  assert.deepEqual(dependencyMergeBases(undefined, undefined), []);
});

test("a custom development branch name is honoured, not hardcoded to develop", () => {
  // baseBranch/featureBranch are per-repo config. Nothing here may assume the
  // house names — the guard is "not main", not "one of two known strings".
  assert.deepEqual(dependencyMergeBases("wip", "staging"), ["wip", "staging"]);
});
