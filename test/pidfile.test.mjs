// Regression tests for daemon PID self-registration.
//
// The bug these pin down: only agent-manager.mjs used to write the PID file, so
// a daemon started any other way (`doppler run -- node dist/cli.js`) was
// invisible — `status` reported "not running" about a live daemon that was
// merging PRs, and `start` would launch a second one on top of it.
//
// Every test uses a unique --repo scope so it can never touch the real
// .agent.pid of a running daemon.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { claimPidFile, releasePidFile, pidFilePath, readPidFile } from "../dist/pidfile.js";

let n = 0;
const scope = () => `test-${process.pid}-${n++}`;

test("claiming writes this process's PID where the manager looks for it", () => {
  const s = scope();
  const claim = claimPidFile(s);
  assert.equal(claim.ok, true);
  assert.equal(claim.path, pidFilePath(s));
  assert.equal(readPidFile(claim.path), process.pid);
  releasePidFile(claim.path);
  assert.equal(existsSync(claim.path), false);
});

test("a second daemon is refused while the first is alive", () => {
  const s = scope();
  const path = pidFilePath(s);
  // process.ppid is a real, live process that is not us.
  writeFileSync(path, String(process.ppid));
  const claim = claimPidFile(s);
  assert.equal(claim.ok, false);
  assert.equal(claim.pid, process.ppid);
  // The refusal must not clobber the incumbent's registration.
  assert.equal(readPidFile(path), process.ppid);
  unlinkSync(path);
});

test("a stale PID file is taken over, not treated as a running daemon", () => {
  const s = scope();
  const path = pidFilePath(s);
  writeFileSync(path, "999999999"); // above pid_max — cannot be alive
  const claim = claimPidFile(s);
  assert.equal(claim.ok, true);
  assert.equal(readPidFile(path), process.pid);
  releasePidFile(path);
});

test("finding our own PID already recorded is accepted, not a self-collision", () => {
  // agent-manager.mjs writes the child's PID right after spawning, so the
  // daemon routinely starts up and finds its own number already there.
  const s = scope();
  const path = pidFilePath(s);
  writeFileSync(path, String(process.pid));
  const claim = claimPidFile(s);
  assert.equal(claim.ok, true);
  releasePidFile(path);
});

test("release only removes a file this process still owns", () => {
  const s = scope();
  const path = pidFilePath(s);
  writeFileSync(path, String(process.ppid)); // someone else's registration
  releasePidFile(path);
  assert.equal(existsSync(path), true, "must not delete another daemon's PID file");
  assert.equal(readPidFile(path), process.ppid);
  unlinkSync(path);
});

test("a garbage PID file does not read as a live daemon", () => {
  const s = scope();
  const path = pidFilePath(s);
  writeFileSync(path, "not-a-pid");
  assert.equal(readPidFile(path), null);
  const claim = claimPidFile(s);
  assert.equal(claim.ok, true);
  releasePidFile(path);
});

test("--repo scopes get their own PID file, so per-repo daemons coexist", () => {
  const a = scope(), b = scope();
  assert.notEqual(pidFilePath(a), pidFilePath(b));
  assert.notEqual(pidFilePath(a), pidFilePath());
  assert.match(pidFilePath(a), /\.agent-test-[0-9-]+\.pid$/);
});
