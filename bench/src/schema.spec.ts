import { test } from "node:test";
import assert from "node:assert/strict";
import { measured, emptyMetricSet, aggregateMetrics } from "./metrics.js";
import { RESULT_SCHEMA_ID, validateResult, type BenchResult } from "./schema.js";

function sample(): BenchResult {
  const m = emptyMetricSet();
  m.human_prompts = measured(1);
  return {
    schema: RESULT_SCHEMA_ID,
    meta: { subject: "odd", binary: { path: "dist/mcp/review-server.js", version: "2.0.0" }, node: "v20.0.0", os: { platform: "darwin", arch: "arm64", release: "1" }, commit: "abc", started_at: "2026-01-01T00:00:00.000Z" },
    journeys: [
      { id: "j1", status: "passed", outcome: { a: 1 }, metrics: m },
      { id: "j2", status: "unsupported", outcome: null, metrics: null, reason: "no such step" },
    ],
    aggregate: { counts: { passed: 1, failed: 0, unsupported: 1 }, metrics: aggregateMetrics([m]) },
  };
}

test("schema id is versioned", () => assert.equal(RESULT_SCHEMA_ID, "odd-claude.bench-result/v1"));

test("a well-formed result validates", () => assert.deepEqual(validateResult(sample()), []));

test("a result survives a JSON round trip", () => assert.deepEqual(validateResult(JSON.parse(JSON.stringify(sample()))), []));

test("rejects wrong schema id, subject, status and missing fields with precise paths", () => {
  const r = sample() as unknown as Record<string, any>;
  r.schema = "odd-claude.bench-result/v0";
  r.meta.subject = "other";
  r.journeys[0].status = "maybe";
  delete r.meta.node;
  const errs = validateResult(r);
  assert.ok(errs.includes("schema: expected odd-claude.bench-result/v1"), errs.join("|"));
  assert.ok(errs.some((e) => e.startsWith("meta.subject:")));
  assert.ok(errs.some((e) => e.startsWith("journeys[0].status:")));
  assert.ok(errs.some((e) => e.startsWith("meta.node:")));
});

test("unobservable dimensions must be null and others must not be", () => {
  const r = sample() as unknown as Record<string, any>;
  r.journeys[0].metrics.model_runs = { value: 3, derivation: "unobservable" };
  r.journeys[0].metrics.git_subprocesses = { value: null, derivation: "measured" };
  const errs = validateResult(r);
  assert.ok(errs.some((e) => e.startsWith("journeys[0].metrics.model_runs:")));
  assert.ok(errs.some((e) => e.startsWith("journeys[0].metrics.git_subprocesses:")));
});

test("passed/failed rows need metrics; unsupported rows need a reason and null metrics; counts must match", () => {
  const r = sample() as unknown as Record<string, any>;
  r.journeys[0].metrics = null;
  delete r.journeys[1].reason;
  r.aggregate.counts.passed = 5;
  const errs = validateResult(r);
  assert.ok(errs.some((e) => e.startsWith("journeys[0].metrics:")));
  assert.ok(errs.some((e) => e.startsWith("journeys[1].reason:")));
  assert.ok(errs.some((e) => e.startsWith("aggregate.counts:")));
});

test("non-objects and non-finite numbers are rejected", () => {
  assert.deepEqual(validateResult(null), ["result: expected an object"]);
  const r = sample() as unknown as Record<string, any>;
  r.journeys[0].metrics.latency = { op: { samples: 1, median_ms: Number.NaN, p95_ms: 1 } };
  assert.ok(validateResult(r).some((e) => e.includes("median_ms")));
});
