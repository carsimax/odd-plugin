import test from "node:test";
import assert from "node:assert/strict";
import { renderReport, renderSummary, run } from "../../src/index.js";

test("report shows hours for long tasks", () => {
  const tasks = [
    { name: "e2e", durationMs: 3_723_000 },
    { name: "unit", durationMs: 59_000 },
  ];
  assert.equal(renderReport(tasks), "e2e   1h 02m 03s\nunit  59s");
});

test("exactly one hour keeps zero padding", () => {
  assert.equal(renderReport([{ name: "x", durationMs: 3_600_000 }]), "x  1h 00m 00s");
});

test("summary shows hours in total, median and slowest", () => {
  const tasks = [
    { name: "a", durationMs: 3_723_000 },
    { name: "b", durationMs: 7_200_000 },
  ];
  assert.equal(renderSummary(tasks), "Tasks: 2\nTotal: 3h 02m 03s\nMedian: 1h 02m 03s\nSlowest: b (2h 00m 00s)");
});

test("the cli report and summary commands use hours", () => {
  const records = [{ name: "deploy", startedAt: 0, finishedAt: 5_025_000 }];
  assert.equal(run(["report"], records), "deploy  1h 23m 45s");
  assert.match(run(["summary"], records), /Total: 1h 23m 45s/);
});
