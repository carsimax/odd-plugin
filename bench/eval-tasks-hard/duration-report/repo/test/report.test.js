import test from "node:test";
import assert from "node:assert/strict";
import { renderReport, renderSummary, slowTaskAlerts, run } from "../src/index.js";

const tasks = [
  { name: "lint", durationMs: 12_000 },
  { name: "test", durationMs: 307_000 },
  { name: "build", durationMs: 95_000 },
];

test("report aligns names", () => {
  assert.equal(renderReport(tasks), "lint   12s\ntest   5m 07s\nbuild  1m 35s");
});

test("summary lists totals", () => {
  assert.equal(renderSummary(tasks), "Tasks: 3\nTotal: 6m 54s\nMedian: 1m 35s\nSlowest: test (5m 07s)");
});

test("alerts list tasks over budget", () => {
  assert.deepEqual(slowTaskAlerts(tasks, 90_000), [
    "ALERT test took 5m 07s (budget 1m 30s)",
    "ALERT build took 1m 35s (budget 1m 30s)",
  ]);
});

test("cli commands", () => {
  const records = [{ name: "a", startedAt: 0, finishedAt: 30_000 }];
  assert.equal(run(["report"], records), "a  30s");
  assert.equal(run(["alerts"], records), "No alerts.");
  assert.throws(() => run(["nope"], records), /Unknown command: nope/);
});
