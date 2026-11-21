import { test } from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "./process.js";

test("runProcess returns exit code and output, and flags a deadline kill", async () => {
  const ok = await runProcess(process.execPath, ["-e", "process.stdout.write('a'); process.exit(3)"], { deadlineMs: 5_000 });
  assert.deepEqual([ok.code, ok.stdout, ok.timedOut], [3, "a", false]);
  const slow = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { deadlineMs: 100 });
  assert.equal(slow.timedOut, true);
});

test("an aborted signal kills the child and rejects instead of waiting for the deadline", async () => {
  const ac = new AbortController();
  const p = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { deadlineMs: 60_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  const t0 = Date.now();
  await assert.rejects(p, /aborted/);
  assert.ok(Date.now() - t0 < 3_000);
  await assert.rejects(runProcess(process.execPath, ["-e", "0"], { deadlineMs: 5_000, signal: AbortSignal.abort() }), /aborted/, "an already aborted signal never starts the process");
});
