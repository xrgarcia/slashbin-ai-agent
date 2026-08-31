import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The daemon registers its own PID at startup rather than relying on whoever
 * launched it to do so.
 *
 * agent-manager.mjs used to be the only writer, so a daemon started any other
 * way — `doppler run -- node dist/cli.js`, a detached shell, a supervisor —
 * left no PID file at all. `status` then reported "not running" about a daemon
 * that was actively merging PRs, and `start` would launch a second one on top
 * of it. Two Foremen racing on the same PRs is the failure this prevents.
 *
 * Self-registration fixes every launch path at once, because the daemon is the
 * one thing guaranteed to be present however it was started.
 */

/** Same convention agent-manager.mjs uses: <package root>/.agent[-<repo>].pid */
export function pidFilePath(repoFilter?: string): string {
  return resolve(__dirname, "..", `.agent${repoFilter ? `-${repoFilter}` : ""}.pid`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPidFile(path: string): number | null {
  try {
    const pid = parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export type PidClaim =
  | { ok: true; path: string }
  | { ok: false; pid: number };

/**
 * Claim the PID file for this process.
 *
 * Refuses only when the recorded PID belongs to a DIFFERENT live process. A
 * stale file (the previous daemon was killed) is taken over, and a file already
 * holding our own PID is accepted — agent-manager.mjs writes the child's PID
 * itself right after spawning, so the daemon routinely finds its own number
 * waiting for it.
 */
export function claimPidFile(repoFilter?: string): PidClaim {
  const path = pidFilePath(repoFilter);
  const existing = readPidFile(path);
  if (existing !== null && existing !== process.pid && isAlive(existing)) {
    return { ok: false, pid: existing };
  }
  writeFileSync(path, String(process.pid));
  return { ok: true, path };
}

/** Remove the PID file, but only while this process still owns it. */
export function releasePidFile(path: string): void {
  if (readPidFile(path) !== process.pid) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}
