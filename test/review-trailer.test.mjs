// Regression tests for the FOREMAN_REVIEW trailer contract and the label it
// implies. Run with `npm test` (node:test, no dependencies) after `npm run build`.
//
// These cover the two things that must never silently change:
//   1. the FOUR-FIELD trailer is the published contract — every downstream
//      reviewer emits it, and the optional `hold=` field must not disturb it;
//   2. the trailer → label mapping only ever fires on an unambiguous report,
//      because it now performs a real write instead of only logging.
import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewTrailerRecords } from "../dist/agent.js";
import { labelFromTrailer } from "../dist/orchestrator.js";

test("the original four-field trailer parses unchanged (backward compat)", () => {
  const [t] = parseReviewTrailerRecords(
    "FOREMAN_REVIEW pr=#100 verdict=APPROVE merged=yes deploy=SUCCESS",
  );
  assert.equal(t.pr, 100);
  assert.equal(t.verdict, "APPROVE");
  assert.equal(t.merged, true);
  assert.equal(t.deploy, "SUCCESS");
  assert.equal(t.hold, undefined, "absent hold must stay undefined, not false-y noise");
});

test("bare pr number (no #) and lowercase still parse", () => {
  const [t] = parseReviewTrailerRecords(
    "foreman_review pr=42 verdict=approve merged=y deploy=na",
  );
  assert.equal(t.pr, 42);
  assert.equal(t.verdict, "APPROVE");
  assert.equal(t.merged, true);
  assert.equal(t.deploy, "NA");
});

test("trailer survives stream-JSON pollution immediately after it", () => {
  // The Claude CLI emits the trailer inside a single-line JSON envelope; an
  // unbounded \S+ used to swallow the closing punctuation into `deploy`.
  const [t] = parseReviewTrailerRecords(
    'FOREMAN_REVIEW pr=#585 verdict=APPROVE merged=yes deploy=SUCCESS"}],"STOP_REASON":NULL',
  );
  assert.equal(t.deploy, "SUCCESS");
  assert.equal(labelFromTrailer(t), "pr approved");
});

test("optional hold= is captured as a reason", () => {
  const [t] = parseReviewTrailerRecords(
    "FOREMAN_REVIEW pr=#585 verdict=APPROVE merged=yes deploy=SUCCESS hold=criterion-not-observable-until-0300z",
  );
  assert.equal(t.deploy, "SUCCESS");
  assert.equal(t.hold, "criterion-not-observable-until-0300z");
});

test("hold=no is not a hold", () => {
  for (const v of ["no", "No", "none", "false", "0"]) {
    const [t] = parseReviewTrailerRecords(
      `FOREMAN_REVIEW pr=#1 verdict=APPROVE merged=yes deploy=SUCCESS hold=${v}`,
    );
    assert.equal(t.hold, undefined, `hold=${v} must not read as a hold`);
  }
});

test("multiple trailers parse independently, mixing old and new forms", () => {
  const out = parseReviewTrailerRecords(`
FOREMAN_REVIEW pr=#1 verdict=APPROVE merged=yes deploy=SUCCESS
FOREMAN_REVIEW pr=#2 verdict=REQUEST_CHANGES merged=no deploy=NA
FOREMAN_REVIEW pr=#3 verdict=APPROVE merged=yes deploy=SUCCESS hold=waiting-on-window
`);
  assert.equal(out.length, 3);
  assert.equal(out[0].hold, undefined);
  assert.equal(out[1].merged, false);
  assert.equal(out[2].hold, "waiting-on-window");
});

test("label mapping: merged + APPROVE + deploy ok => pr approved", () => {
  for (const deploy of ["SUCCESS", "NA", "N/A", "NONE", "PASS"]) {
    assert.equal(
      labelFromTrailer({ pr: 1, verdict: "APPROVE", merged: true, deploy }),
      "pr approved",
      `deploy=${deploy}`,
    );
  }
});

test("label mapping: a failed deploy routes to revise, not approval", () => {
  assert.equal(
    labelFromTrailer({ pr: 1, verdict: "APPROVE", merged: true, deploy: "FAILURE" }),
    "pr pending actions",
  );
});

test("label mapping: nothing merged => no write", () => {
  // An unmerged PR is SUPPOSED to leave the issue at `pr under review`.
  assert.equal(
    labelFromTrailer({ pr: 1, verdict: "APPROVE", merged: false, deploy: "NA" }),
    null,
  );
  assert.equal(
    labelFromTrailer({ pr: 1, verdict: "REQUEST_CHANGES", merged: false, deploy: "NA" }),
    null,
  );
});

test("label mapping: self-contradictory or unknown reports => no write", () => {
  // Merged but changes requested is incoherent; so is an unrecognised deploy
  // token. The reconciler repairs a missing write, it never invents one.
  assert.equal(
    labelFromTrailer({ pr: 1, verdict: "REQUEST_CHANGES", merged: true, deploy: "SUCCESS" }),
    null,
  );
  assert.equal(
    labelFromTrailer({ pr: 1, verdict: "APPROVE", merged: true, deploy: "WEIRD" }),
    null,
  );
});

test("label mapping never yields the production authorization", () => {
  // `ready for prod release` is the EM outcome-gate's signature. No trailer,
  // however emphatic, may produce it (separation of duties, 2026-07-27).
  const combos = ["SUCCESS", "FAILURE", "NA", "WEIRD"].flatMap((deploy) =>
    [true, false].flatMap((merged) =>
      ["APPROVE", "REQUEST_CHANGES", "NONSENSE"].map((verdict) =>
        labelFromTrailer({ pr: 1, verdict, merged, deploy }),
      ),
    ),
  );
  assert.equal(combos.includes("ready for prod release"), false);
});

// --- Result extraction --------------------------------------------------
// Regression guard for the defect that made "no trailer emitted" a lie:
// extractStreamResult used to return text.slice(0, 2000), and the trailer is
// required to be the LAST thing the agent emits. Any review with a summary over
// 2000 chars had its outcome silently cut off, and the caller reported a
// complete review as having declared nothing. Real case: slashbin-io-worker
// PR #589 — 3,672-char result, trailer at index 3,571.
import { extractStreamResult, SUMMARY_DISPLAY_LIMIT } from "../dist/agent.js";

const streamLine = (resultText) =>
  JSON.stringify({ type: "result", result: resultText, uuid: "x" });

test("extractStreamResult returns the FULL result text, not a truncated copy", () => {
  const trailer = "FOREMAN_REVIEW pr=#589 verdict=APPROVE merged=yes deploy=SUCCESS";
  const long = "x".repeat(3500) + "\n\n" + trailer;
  const out = extractStreamResult(streamLine(long));
  assert.equal(out.length, long.length, "must not truncate");
  assert.ok(out.endsWith(trailer));
});

test("a trailer beyond the display limit still parses", () => {
  const trailer = "FOREMAN_REVIEW pr=#589 verdict=APPROVE merged=yes deploy=SUCCESS hold=cleanup-not-due-until-0300z";
  const long = "y".repeat(SUMMARY_DISPLAY_LIMIT + 1500) + "\n\n" + trailer;
  const full = extractStreamResult(streamLine(long));

  // What the old code did, reproduced to prove the bug is what we think it is.
  assert.equal(parseReviewTrailerRecords(full.slice(0, SUMMARY_DISPLAY_LIMIT)).length, 0);

  // What the fixed path does.
  const parsed = parseReviewTrailerRecords(full);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].pr, 589);
  assert.equal(parsed[0].hold, "cleanup-not-due-until-0300z");
});

test("extractStreamResult picks the LAST result event and tolerates non-JSON lines", () => {
  const stdout = [
    "not json at all",
    streamLine("first"),
    "{broken",
    streamLine("FOREMAN_REVIEW pr=#7 verdict=APPROVE merged=yes deploy=NA"),
  ].join("\n");
  const out = extractStreamResult(stdout);
  assert.equal(parseReviewTrailerRecords(out)[0].pr, 7);
});

test("no result event => undefined, so the caller can fall back to stdout", () => {
  assert.equal(extractStreamResult("no json here\n{also not}"), undefined);
});
