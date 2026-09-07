// Regression tests for the dependency BATCH issue — the path a version bump
// takes once Dependabot targets the feature branch.
//
// Origin: owner decision, 2026-09-07. Until now a dependency PR was merged by a
// phase that reads a CI check rollup and nothing else — no session, no build, no
// server started. A check rollup proves the code compiles; it never proves the
// application still runs, which is why `express` 4 -> 5 sat green and one review
// away from production in two repos on the same day.
//
// The fix routes bumps through the implement session instead, and that session
// is issue-driven: the review phase starts from issues labelled `pr under
// review`, promotion queries issues carrying the EM gate, and the promotion PR
// body is a list of issue numbers. A dependency PR with no issue can reach
// `develop` and then has no route to `main` at all.
//
// Run with `npm test` (node:test, no dependencies) after `npm run build`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  describeDependencyPR,
  isMajorBump,
  buildDependencyBatchIssue,
  DEPENDENCY_BATCH_TITLE_PREFIX,
} from "../dist/github.js";

// --- Title parsing. All four shapes were observed live on 2026-09-07. --------

test("a versioned bump yields the package and both versions", () => {
  const c = describeDependencyPR(415, "chore(deps): bump vite from 5.4.21 to 8.2.2");
  assert.deepEqual(c.packages, ["vite"]);
  assert.equal(c.from, "5.4.21");
  assert.equal(c.to, "8.2.2");
  assert.equal(c.major, true);
});

test("the bare `Bump X from A to B` shape parses identically", () => {
  const c = describeDependencyPR(11, "Bump form-data from 4.0.5 to 4.0.6");
  assert.deepEqual(c.packages, ["form-data"]);
  assert.equal(c.major, false);
});

test("a grouped bump lists its packages and claims NO version", () => {
  // The title carries no versions. Inventing one would put a wrong number in
  // front of the person deciding whether to approve, so both stay undefined.
  const c = describeDependencyPR(315, "chore(deps): bump qs and express");
  assert.deepEqual(c.packages, ["qs", "express"]);
  assert.equal(c.from, undefined);
  assert.equal(c.to, undefined);
  assert.equal(c.major, false, "unknown versions must not be reported as a major");
});

test("a grouped bump drops the trailing directory qualifier", () => {
  const c = describeDependencyPR(469, "chore(deps-dev): bump react-dom and @types/react-dom in /desktop");
  assert.deepEqual(c.packages, ["react-dom", "@types/react-dom"]);
});

// --- Major detection --------------------------------------------------------

test("a leading-component change is a major", () => {
  assert.equal(isMajorBump("4.21.2", "5.2.1"), true);
  assert.equal(isMajorBump("3.25.76", "4.5.4"), true);
});

test("0.x counts every minor as breaking — the esbuild case", () => {
  // Under semver a 0.y release may break on every minor. Reading 0.25 -> 0.28 as
  // "not a major" would file an issue calling a breaking upgrade routine.
  assert.equal(isMajorBump("0.25.12", "0.28.1"), true);
  assert.equal(isMajorBump("0.28.0", "0.28.1"), false);
});

test("a patch or minor inside a stable major is not a major", () => {
  assert.equal(isMajorBump("4.0.5", "4.0.6"), false);
  assert.equal(isMajorBump("10.9.0", "10.11.0"), false);
});

test("a caret or other prefix does not defeat the comparison", () => {
  assert.equal(isMajorBump("^4.21.2", "^5.2.1"), true);
});

test("an unparseable version is reported as NOT major rather than guessed", () => {
  assert.equal(isMajorBump("latest", "5.0.0"), false);
});

// --- The issue body ---------------------------------------------------------

const changes = [
  describeDependencyPR(415, "chore(deps): bump vite from 5.4.21 to 8.2.2"),
  describeDependencyPR(11, "Bump form-data from 4.0.5 to 4.0.6"),
];

test("the title carries the idempotency prefix, the count and the major count", () => {
  const { title } = buildDependencyBatchIssue("features", changes);
  assert.ok(title.startsWith(DEPENDENCY_BATCH_TITLE_PREFIX),
    "the prefix IS the at-most-one-open-issue mechanism — a title that loses it files a duplicate every cycle");
  assert.match(title, /2 dependency updates/);
  assert.match(title, /\(1 major\)/);
});

test("a batch with no major says so instead of claiming one", () => {
  const { title, body } = buildDependencyBatchIssue("features", [changes[1]]);
  assert.doesNotMatch(title, /major\)/);
  assert.match(body, /None of these crosses a major version/);
  assert.match(title, /1 dependency update\b/, "singular, not '1 dependency updates'");
});

test("every PR appears in the table and in References", () => {
  const { body } = buildDependencyBatchIssue("features", changes);
  for (const c of changes) {
    assert.ok(body.includes(`| #${c.number} |`), `PR #${c.number} missing from the table`);
    assert.ok(body.includes(`- #${c.number}`), `PR #${c.number} missing from References`);
  }
});

test("the body demands the app be STARTED, not merely built", () => {
  // This is the whole point of the change. A body that only says "build" would
  // reproduce the CI-rollup gate the issue exists to replace.
  const { body } = buildDependencyBatchIssue("features", changes);
  assert.match(body, /Start the application and confirm it serves/);
  assert.match(body, /Exercise the flows/);
});

test("the body carries the flight-gate sections the approval gate requires", () => {
  const { body } = buildDependencyBatchIssue("features", changes);
  // Match whole lines: `## Problem` is the first line of the body, so a
  // "\n## Problem\n" test would fail on a body that is perfectly correct.
  const headings = new Set(body.split("\n").map((l) => l.trim()));
  for (const section of ["## Problem", "## Required Changes", "## Acceptance", "## Pre-Flight", "## References"]) {
    assert.ok(headings.has(section), `missing ${section}`);
  }
  assert.match(body, /\*\*No-Script:\*\*/, "the acceptance hatch needs a stated reason, not an omission");
  for (const bullet of ["Design locked", "Preconditions", "Dev-safety"]) {
    assert.ok(body.includes(bullet), `Pre-Flight missing ${bullet}`);
  }
});

test("a grouped PR renders as 'read the PR' rather than a fabricated version", () => {
  const { body } = buildDependencyBatchIssue("features", [describeDependencyPR(315, "chore(deps): bump qs and express")]);
  assert.match(body, /grouped — read the PR/);
  assert.ok(body.includes("qs, express"));
});

test("the feature branch name is taken from config, never hardcoded", () => {
  const { title, body } = buildDependencyBatchIssue("wip", changes);
  assert.match(title, /on `wip`/);
  assert.ok(body.includes("`wip`"));
  assert.ok(!body.includes("`features`"));
});
