import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { isPidAlive, pidState } from "./pid.js";

function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "0"]);
  assert.ok(r.pid && r.pid > 0);
  return r.pid;
}

test("pidState: own pid is alive", () => {
  assert.equal(pidState(process.pid), "alive");
  assert.equal(isPidAlive(process.pid), true);
});

test("pidState: an exited child is dead (ESRCH)", () => {
  const pid = deadPid();
  assert.equal(pidState(pid), "dead");
  assert.equal(isPidAlive(pid), false);
});

test("pidState: invalid pids are never signalled and prove nothing", () => {
  for (const pid of [0, -1, -process.pid, NaN, Infinity, 1.5]) {
    assert.equal(pidState(pid), "invalid", String(pid));
    assert.equal(isPidAlive(pid), false, String(pid));
  }
});

test("pidState: EPERM maps to alive (the process exists, it is not ours)", () => {
  // pid 1 exists everywhere; unprivileged users get EPERM, root gets success. Both mean alive.
  assert.equal(pidState(1), "alive");
});
