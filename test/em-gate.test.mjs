// Regression tests for the EM outcome-gate guard.
//
// `ready for prod release` is the one label that authorizes production. The
// review path writes labels through an agent the Foreman cannot intercept, so
// the guarantee is: whatever the agent does, an EM gate that existed before a
// review run still exists after it.
//
// Origin: Slashbin-io-docs, 2026-08-04. The gate was signed at 20:20:15Z and
// overwritten with `pr approved` at 20:22:12Z by a review run that had started
// at 20:11:59Z — before the gate existed, so the trigger-time exclusion in
// findPRsNeedingReview could not see it. findReadyForProdIssues then returned an
// empty set, tryPromotion returned early, and the promotion sat stalled for an
// hour with no error and no log line.
//
// Run with `npm test` (node:test, no dependencies) after `npm run build`.
import test from "node:test";
import assert from "node:assert/strict";
import { planEmGateRestore, EM_GATE_LABEL } from "../dist/github.js";

const issue = (number, ...labels) => ({ number, labels: labels.map((name) => ({ name })) });

test("the label constant is the exact string the promotion query filters on", () => {
  // findReadyForProdIssues filters on this literal; a typo here is a silent stall.
  assert.equal(EM_GATE_LABEL, "ready for prod release");
});

test("a gate replaced by 'pr approved' is restored, and the replacement stripped", () => {
  const steps = planEmGateRestore([225], [issue(225, "feature", "S3", "pr approved")]);
  assert.deepEqual(steps, [{ number: 225, dropPrApproved: true }]);
});

test("a gate removed outright is restored without touching anything else", () => {
  const steps = planEmGateRestore([225], [issue(225, "feature", "S3")]);
  assert.deepEqual(steps, [{ number: 225, dropPrApproved: false }]);
});

test("an intact gate is left alone — the healthy path writes nothing", () => {
  const steps = planEmGateRestore([225], [issue(225, "feature", EM_GATE_LABEL)]);
  assert.deepEqual(steps, [], "a run that behaved must be bit-for-bit unchanged");
});

test("a gate alongside 'pr approved' is still intact — no write", () => {
  // Both labels present is untidy but not a revocation; promotion still finds it.
  const steps = planEmGateRestore([225], [issue(225, EM_GATE_LABEL, "pr approved")]);
  assert.deepEqual(steps, []);
});

test("a closed issue is never re-labeled", () => {
  // Absent from the OPEN set = closed. Re-labeling would put a finished issue
  // back in the Foreman's pickup list, which is the no-op-cycle bug in reverse.
  const steps = planEmGateRestore([225], []);
  assert.deepEqual(steps, [], "closed issues must not be resurrected by the guard");
});

test("only issues that carried the gate BEFORE the run are candidates", () => {
  // #300 has no gate and never had one. The guard must not invent authorization.
  const steps = planEmGateRestore([225], [issue(225, "pr approved"), issue(300, "pr approved")]);
  assert.deepEqual(steps, [{ number: 225, dropPrApproved: true }]);
});

test("an empty before-snapshot can never produce a write", () => {
  // snapshotEmGate returns [] on any lookup failure. That must mean "restore
  // nothing", never "restore everything" — a failed read must not manufacture
  // production authorization.
  const steps = planEmGateRestore([], [issue(225, "pr approved"), issue(300)]);
  assert.deepEqual(steps, []);
});

test("multiple revoked gates in one run are all restored", () => {
  const steps = planEmGateRestore(
    [225, 226, 227],
    [issue(225, "pr approved"), issue(226, EM_GATE_LABEL), issue(227, "pr pending actions")],
  );
  assert.deepEqual(steps, [
    { number: 225, dropPrApproved: true },
    { number: 227, dropPrApproved: false },
  ]);
});

// --- Timeline-based revocation detection -----------------------------------
//
// The first version of this guard snapshotted which issues held the gate BEFORE
// a review run and restored those. It shipped, and then failed on the exact
// scenario the bug report described. Slashbin-io-docs#269:
//
//   13:52:25Z  review run triggered   -> snapshot taken, gate not yet applied
//   13:57:41Z  EM signs the gate      -> invisible to the snapshot
//   13:58:20Z  review agent removes it
//   13:58:xx   guard restores nothing, because its snapshot was empty
//
// The rule below is time-symmetric: it asks whether the label was taken away
// during the window, never whether it existed before the window.
import { wasGateRevokedSince } from "../dist/github.js";

const RUN_START = Date.parse("2026-08-06T13:52:25Z");
const ev = (event, name, at) => ({ event, label: { name }, created_at: at });

test("gate signed DURING the run and then removed is detected", () => {
  // The case the previous guard missed entirely.
  const events = [
    ev("labeled", EM_GATE_LABEL, "2026-08-06T13:57:41Z"),
    ev("unlabeled", EM_GATE_LABEL, "2026-08-06T13:58:20Z"),
  ];
  assert.equal(wasGateRevokedSince(events, RUN_START), true);
});

test("gate that existed before the run and was removed during it is detected", () => {
  const events = [
    ev("labeled", EM_GATE_LABEL, "2026-08-06T13:00:00Z"),
    ev("unlabeled", EM_GATE_LABEL, "2026-08-06T13:58:20Z"),
  ];
  assert.equal(wasGateRevokedSince(events, RUN_START), true);
});

test("a removal BEFORE the run is not this run's doing", () => {
  // Usually stripReadyForProd on an earlier promotion. Not ours to undo.
  const events = [ev("unlabeled", EM_GATE_LABEL, "2026-08-06T11:00:00Z")];
  assert.equal(wasGateRevokedSince(events, RUN_START), false);
});

test("removing a DIFFERENT label is not a revocation", () => {
  const events = [
    ev("unlabeled", "pr under review", "2026-08-06T13:58:20Z"),
    ev("unlabeled", "approved", "2026-08-06T13:58:20Z"),
  ];
  assert.equal(wasGateRevokedSince(events, RUN_START), false);
});

test("APPLYING the gate during the run is not a revocation", () => {
  const events = [ev("labeled", EM_GATE_LABEL, "2026-08-06T13:57:41Z")];
  assert.equal(wasGateRevokedSince(events, RUN_START), false);
});

test("an empty or unparseable timeline restores nothing", () => {
  assert.equal(wasGateRevokedSince([], RUN_START), false);
  assert.equal(wasGateRevokedSince([{ event: "unlabeled" }], RUN_START), false);
  assert.equal(
    wasGateRevokedSince([ev("unlabeled", EM_GATE_LABEL, "not-a-date")], RUN_START),
    false,
    "an unparseable timestamp must not manufacture a restore",
  );
});

test("a removal exactly at the run start counts — the boundary is inclusive", () => {
  const events = [ev("unlabeled", EM_GATE_LABEL, "2026-08-06T13:52:25Z")];
  assert.equal(wasGateRevokedSince(events, RUN_START), true);
});
