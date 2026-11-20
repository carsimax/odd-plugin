import { test } from "node:test";
import assert from "node:assert/strict";
import { addBlock, aggregateMetrics, blocksTotal, emptyBlocks, emptyMetricSet, measured, median, percentile, proxy, summarizeLatency, unobservable } from "./metrics.js";

test("percentile uses nearest-rank on unsorted input", () => {
  const xs = Array.from({ length: 20 }, (_, i) => 20 - i);
  assert.equal(percentile(xs, 95), 19);
  assert.equal(percentile(xs, 100), 20);
  assert.equal(percentile(xs, 50), 10);
  assert.equal(percentile([7], 95), 7);
  assert.deepEqual(xs.slice(0, 2), [20, 19], "input is not mutated");
});

test("percentile and median reject empty input and bad ranks", () => {
  assert.throws(() => percentile([], 50), /empty/);
  assert.throws(() => median([]), /empty/);
  assert.throws(() => percentile([1], 0), /rank/);
  assert.throws(() => percentile([1], 101), /rank/);
  assert.throws(() => percentile([1, Number.NaN], 50), /finite/);
});

test("median averages the two middle samples for even counts", () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([5, 1, 3]), 3);
});

test("summarizeLatency reports samples, median and p95 and keeps raw samples", () => {
  const s = summarizeLatency([10, 30, 20, 40]);
  assert.equal(s.samples, 4);
  assert.equal(s.median_ms, 25);
  assert.equal(s.p95_ms, 40);
  assert.deepEqual(s.samples_ms, [10, 30, 20, 40]);
});

test("block counts: by_design is a reclassification that still counts in the total", () => {
  const b = emptyBlocks();
  addBlock(b, "out_of_band");
  addBlock(b, "by_design");
  addBlock(b, "dead_end");
  assert.equal(blocksTotal(b), 3);
  assert.throws(() => addBlock(b, "nope" as never), /unknown block class/);
});

test("aggregate sums observable values and keeps the weakest derivation", () => {
  const a = emptyMetricSet();
  a.human_prompts = measured(2);
  a.manual_tokens = proxy(10, "bytes/4");
  a.model_runs = measured(1);
  a.blocks = { value: { self_recovered: 1, in_band: 0, out_of_band: 2, by_design: 0, dead_end: 0 }, derivation: "measured" };
  a.latency["mcp.review_status"] = summarizeLatency([10, 20]);
  const b = emptyMetricSet();
  b.human_prompts = measured(3);
  b.manual_tokens = measured(5);
  b.model_runs = unobservable("not visible");
  b.blocks = { value: { self_recovered: 0, in_band: 1, out_of_band: 0, by_design: 1, dead_end: 0 }, derivation: "measured" };
  b.latency["mcp.review_status"] = summarizeLatency([30, 40]);
  const agg = aggregateMetrics([a, b]);
  assert.deepEqual(agg.human_prompts, { value: 5, derivation: "measured" });
  assert.equal(agg.manual_tokens.value, 15);
  assert.equal(agg.manual_tokens.derivation, "proxy");
  assert.equal(agg.model_runs.value, 1, "unobservable rows add nothing");
  assert.equal(agg.model_runs.derivation, "unobservable");
  assert.match(agg.model_runs.note ?? "", /1 of 2/);
  assert.deepEqual(agg.blocks.value, { self_recovered: 1, in_band: 1, out_of_band: 2, by_design: 1, dead_end: 0 });
  const lat = agg.latency["mcp.review_status"]!;
  assert.equal(lat.samples, 4);
  assert.equal(lat.median_ms, 25);
  assert.equal(lat.p95_ms, 40);
});

test("aggregate of all-unobservable stays null, of nothing is an empty set", () => {
  const a = emptyMetricSet();
  const agg = aggregateMetrics([a, emptyMetricSet()]);
  assert.equal(agg.human_prompts.value, null);
  assert.equal(agg.human_prompts.derivation, "unobservable");
  assert.equal(aggregateMetrics([]).human_prompts.value, null);
});
