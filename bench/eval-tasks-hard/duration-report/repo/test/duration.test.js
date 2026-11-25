import test from "node:test";
import assert from "node:assert/strict";
import { formatDuration, normalizeTask, percentile } from "../src/index.js";

test("seconds only below a minute", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45_000), "45s");
});

test("minutes and zero-padded seconds", () => {
  assert.equal(formatDuration(307_000), "5m 07s");
  assert.equal(formatDuration(60_000), "1m 00s");
});

test("negative durations count as zero", () => {
  assert.equal(formatDuration(-5), "0s");
});

test("normalizeTask computes the duration", () => {
  assert.deepEqual(normalizeTask({ name: "lint", startedAt: 1000, finishedAt: 4500 }), { name: "lint", durationMs: 3500 });
});

test("percentile uses nearest rank", () => {
  assert.equal(percentile([5, 1, 3], 50), 3);
  assert.equal(percentile([], 50), 0);
});
