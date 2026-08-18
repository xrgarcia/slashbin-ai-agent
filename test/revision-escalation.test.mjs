// Guards for the revision phase's escalation when retries are exhausted.
//
// Source-level assertions: the path only fires after two real failed Claude
// revision runs against a live PR, which no unit test can stage. What regressed
// was the SHAPE — a cap that returned early at `debug` level and told nobody —
// so that is what these pin.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const orchestrator = readFileSync(join(root, "src/orchestrator.ts"), "utf-8");

test("exhausted revision retries escalate instead of going quiet", () => {
  assert.match(orchestrator, /const revisionEscalated = new Set<string>\(\)/,
    "no escalation bookkeeping");
  const block = orchestrator.slice(orchestrator.indexOf("newCount >= MAX_RETRIES && !revisionEscalated"));
  assert.match(block.slice(0, 1500), /events\.push/,
    "hitting the cap must emit a notifier event, not just a log line");
  assert.match(block.slice(0, 1500), /level: "error"/, "a stuck PR is an error-level condition");
  assert.match(block.slice(0, 1500), /pending\.pr\.number/,
    "the escalation is useless without the PR it is about");
});

test("the escalation clears when the repo recovers", () => {
  assert.match(orchestrator, /revisionEscalated\.delete\(repoName\)/,
    "never clearing means a repo escalates once and then goes silent forever");
  const deletes = orchestrator.match(/revisionEscalated\.delete\(repoName\)/g) ?? [];
  assert.ok(deletes.length >= 2,
    `both recovery paths (success, feedback cleared) must clear it — found ${deletes.length}`);
});
