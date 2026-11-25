import test from "node:test";
import assert from "node:assert/strict";
import { slowTaskAlerts, run, formatDuration } from "../../src/index.js";

test("alert lines keep minutes-only durations past one hour", () => {
  assert.deepEqual(slowTaskAlerts([{ name: "e2e", durationMs: 3_723_000 }], 3_600_000), [
    "ALERT e2e took 62m 03s (budget 60m 00s)",
  ]);
});

test("alert lines still match the pager rules", () => {
  const [line] = slowTaskAlerts([{ name: "nightly", durationMs: 9_000_000 }], 3_600_000);
  assert.match(line, /took \d+m \d{2}s/);
  assert.match(line, /budget \d+m \d{2}s/);
  assert.equal(line, "ALERT nightly took 150m 00s (budget 60m 00s)");
});

test("the cli alerts command is unchanged for long tasks", () => {
  const records = [{ name: "e2e", startedAt: 0, finishedAt: 7_265_000 }];
  assert.equal(run(["alerts", "--budget-seconds=3600"], records), "ALERT e2e took 121m 05s (budget 60m 00s)");
});

test("durations under an hour look as before everywhere", () => {
  assert.equal(formatDuration(3_599_000), "59m 59s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(run(["report"], [{ name: "a", startedAt: 0, finishedAt: 3_599_000 }]), "a  59m 59s");
  assert.equal(run(["alerts", "--budget-seconds=10"], [{ name: "a", startedAt: 0, finishedAt: 307_000 }]), "ALERT a took 5m 07s (budget 10s)");
});
