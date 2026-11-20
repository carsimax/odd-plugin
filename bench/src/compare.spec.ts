import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyMetricSet, measured, unobservable, summarizeLatency } from "./metrics.js";
import { compareResults, COMPARISON_SCHEMA_ID } from "./compare.js";
import { RESULT_SCHEMA_ID, type BenchResult, type JourneyRow } from "./schema.js";

function result(subject: "odd" | "oracle", rows: JourneyRow[]): BenchResult {
  return {
    schema: RESULT_SCHEMA_ID,
    meta: { subject, binary: { path: "x", version: "1" }, node: "v20", os: { platform: "p", arch: "a", release: "r" }, commit: "c", started_at: "t" },
    journeys: rows,
    aggregate: { counts: { passed: 0, failed: 0, unsupported: 0 }, metrics: null },
  };
}
const row = (id: string, prompts: number | null, outcome: Record<string, unknown> = { ok: true }): JourneyRow => {
  const m = emptyMetricSet();
  m.human_prompts = prompts === null ? unobservable("n/a") : measured(prompts);
  m.commands_to_completion = measured(10);
  return { id, status: "passed", outcome, metrics: m };
};

test("verdicts: equal within threshold, better when odd is lower, worse when higher", () => {
  const rep = compareResults(result("odd", [row("a", 1), row("b", 1), row("c", 5)]), result("oracle", [row("a", 1), row("b", 3), row("c", 2)]));
  assert.equal(rep.schema, COMPARISON_SCHEMA_ID);
  const v = (id: string) => rep.journeys.find((j) => j.id === id)!.metrics.human_prompts!.verdict;
  assert.equal(v("a"), "equal");
  assert.equal(v("b"), "better");
  assert.equal(v("c"), "worse");
});

test("relative threshold makes near values equal", () => {
  const odd = row("a", 1); odd.metrics!.human_surface_bytes = measured(1050);
  const ora = row("a", 1); ora.metrics!.human_surface_bytes = measured(1000);
  const rep = compareResults(result("odd", [odd]), result("oracle", [ora]), { default: { relative: 0.1, absolute: 0 }, per_metric: {} });
  assert.equal(rep.journeys[0]!.metrics.human_surface_bytes!.verdict, "equal");
  const strict = compareResults(result("odd", [odd]), result("oracle", [ora]), { default: { relative: 0, absolute: 0 }, per_metric: {} });
  assert.equal(strict.journeys[0]!.metrics.human_surface_bytes!.verdict, "worse");
});

test("unobservable on either side, missing journeys and unsupported rows are not_comparable", () => {
  const unsup: JourneyRow = { id: "u", status: "unsupported", outcome: null, metrics: null, reason: "r" };
  const rep = compareResults(result("odd", [row("a", 1), row("u", 1), row("only-odd", 1)]), result("oracle", [row("a", null), unsup]));
  assert.equal(rep.journeys.find((j) => j.id === "a")!.metrics.human_prompts!.verdict, "not_comparable");
  const u = rep.journeys.find((j) => j.id === "u")!;
  assert.equal(u.outcome, "not_comparable");
  assert.deepEqual(u.metrics, {});
  assert.equal(rep.journeys.find((j) => j.id === "only-odd")!.outcome, "not_comparable");
});

test("outcome projections compare by deep equality; summary counts verdicts; latency is odd-only", () => {
  const odd = row("a", 1, { gate: "deny" }); odd.metrics!.latency["op"] = summarizeLatency([1, 2]);
  const ora = row("a", 1, { gate: "allow" });
  const rep = compareResults(result("odd", [odd]), result("oracle", [ora]));
  assert.equal(rep.journeys[0]!.outcome, "different");
  assert.equal(rep.journeys[0]!.latency["op"]!.verdict, "not_comparable");
  assert.equal(rep.summary.outcome.different, 1);
  assert.equal(rep.summary.metrics.equal >= 1, true);
});
