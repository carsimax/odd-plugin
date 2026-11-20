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

// ---- T4: thresholds, kinds, latency and verdict math ----
import { DEFAULT_THRESHOLDS, efficiencyVerdict, type Thresholds } from "./compare.js";

const withLatency = (r: JourneyRow, median: number, p95 = median, op = "journey.total"): JourneyRow => {
  r.metrics!.latency[op] = { samples: 3, median_ms: median, p95_ms: p95 };
  return r;
};
const cmp1 = (odd: JourneyRow, ora: JourneyRow, t?: Thresholds) => compareResults(result("odd", [odd]), result("oracle", [ora]), t).journeys[0]!;

test("default thresholds: counts are exact, bytes and tokens use a 10% tolerance", () => {
  assert.deepEqual(DEFAULT_THRESHOLDS.default, { relative: 0, absolute: 0 });
  const odd = row("a", 1), ora = row("a", 1);
  odd.metrics!.commands_to_completion = measured(11);
  ora.metrics!.commands_to_completion = measured(10);
  odd.metrics!.human_surface_bytes = measured(1090); ora.metrics!.human_surface_bytes = measured(1000);
  odd.metrics!.manual_tokens = measured(12); ora.metrics!.manual_tokens = measured(10);
  const j = cmp1(odd, ora);
  assert.equal(j.metrics.commands_to_completion!.verdict, "worse");
  assert.equal(j.metrics.human_surface_bytes!.verdict, "equal");
  assert.equal(j.metrics.manual_tokens!.verdict, "worse");
});

test("absolute tolerance (±N) and the boundary are inclusive; zero against zero is equal; zero against some is better", () => {
  const t: Thresholds = { default: { relative: 0, absolute: 0 }, per_metric: { commands_to_completion: { relative: 0, absolute: 2 } } };
  const mk = (o: number, r: number) => { const a = row("a", 0), b = row("a", 0); a.metrics!.commands_to_completion = measured(o); b.metrics!.commands_to_completion = measured(r); return cmp1(a, b, t).metrics.commands_to_completion!.verdict; };
  assert.equal(mk(12, 10), "equal");
  assert.equal(mk(8, 10), "equal");
  assert.equal(mk(13, 10), "worse");
  assert.equal(mk(7, 10), "better");
  assert.equal(cmp1(row("a", 0), row("a", 0)).metrics.human_prompts!.verdict, "equal");
  assert.equal(cmp1(row("a", 0), row("a", 3)).metrics.human_prompts!.verdict, "better");
  assert.equal(cmp1(row("a", 3), row("a", 0)).metrics.human_prompts!.verdict, "worse");
});

test("blocks compare by total, and by_design still counts", () => {
  const odd = row("a", 1), ora = row("a", 1);
  odd.metrics!.blocks = { value: { self_recovered: 0, in_band: 1, out_of_band: 0, by_design: 0, dead_end: 0 }, derivation: "measured" };
  ora.metrics!.blocks = { value: { self_recovered: 0, in_band: 0, out_of_band: 0, by_design: 1, dead_end: 0 }, derivation: "measured" };
  assert.deepEqual(cmp1(odd, ora).metrics.blocks, { odd: 1, oracle: 1, verdict: "equal" });
  const none = row("a", 1); // blocks stay unobservable
  assert.equal(cmp1(none, ora).metrics.blocks!.verdict, "not_comparable");
});

test("kinds: comparable, divergent (declared, never a win or loss), unsupported (with reason) and missing", () => {
  const div = row("d", 1); div.divergence = ["a decline persists nothing"];
  const oddD = row("d", 5);
  const unsup: JourneyRow = { id: "u", status: "unsupported", outcome: null, metrics: null, reason: "no deny in 4.6.0" };
  const rep = compareResults(result("odd", [row("a", 1), oddD, row("u", 1), row("m", 1)]), result("oracle", [row("a", 1), div, unsup]));
  const k = (id: string) => rep.journeys.find((j) => j.id === id)!;
  assert.equal(k("a").kind, "comparable");
  assert.equal(k("d").kind, "divergent");
  assert.equal(k("d").outcome, "not_comparable");
  assert.deepEqual(k("d").divergence, ["a decline persists nothing"]);
  assert.deepEqual(k("d").metrics.human_prompts, { odd: 5, oracle: 1, verdict: "not_comparable" }, "numbers kept, no verdict");
  assert.equal(k("u").kind, "unsupported");
  assert.equal(k("u").reason, "no deny in 4.6.0");
  assert.equal(k("m").kind, "missing");
  assert.deepEqual(rep.summary.journeys, { total: 4, comparable: 1, divergent: 1, unsupported: 1, missing: 1 });
  // the divergent journey (odd 5 vs 1) is excluded from every total and verdict count
  assert.equal(rep.summary.per_metric.human_prompts!.odd_total, 1);
  assert.equal(rep.summary.per_metric.human_prompts!.verdicts.worse, 0);
});

test("per metric totals sum only comparable journeys with both sides observed", () => {
  const rep = compareResults(result("odd", [row("a", 1), row("b", 2), row("c", 9)]), result("oracle", [row("a", 2), row("b", 2), row("c", null)]));
  const p = rep.summary.per_metric.human_prompts!;
  assert.deepEqual(p.verdicts, { equal: 1, better: 1, worse: 0, not_comparable: 1 });
  assert.equal(p.odd_total, 3);
  assert.equal(p.oracle_total, 4);
});

test("latency: ratio of medians with tolerance and floor, p95 carried, odd-only or zero oracle is not_comparable", () => {
  const v = (o: number, r: number, t?: Thresholds) => cmp1(withLatency(row("a", 1), o, o * 2), withLatency(row("a", 1), r), t).latency["journey.total"]!;
  assert.equal(v(1000, 1000).verdict, "equal");
  assert.equal(v(1200, 1000).verdict, "equal", "within the default 25% tolerance");
  assert.equal(v(1300, 1000).verdict, "worse");
  assert.equal(v(700, 1000).verdict, "better");
  assert.equal(v(810, 1000).verdict, "equal", "1/1.25 = 0.8 lower bound");
  assert.equal(v(1300, 1000, { ...DEFAULT_THRESHOLDS, latency: { tolerance: 0.5, floor_ms: 0 } }).verdict, "equal");
  assert.equal(v(2, 1).verdict, "equal", "difference under the floor");
  assert.equal(v(1000, 0).verdict, "not_comparable");
  const lat = v(1300, 1000);
  assert.equal(lat.ratio, 1.3);
  assert.equal(lat.odd.p95_ms, 2600);
  assert.equal(lat.oracle!.median_ms, 1000);
  const oddOnly = cmp1(withLatency(row("a", 1), 10, 10, "mcp.x"), withLatency(row("a", 1), 10)).latency["mcp.x"]!;
  assert.equal(oddOnly.verdict, "not_comparable");
  assert.equal(oddOnly.oracle, undefined);
});

test("summary latency: median of per-journey ratios over comparable journeys, divergent ones excluded", () => {
  const mk = (id: string, o: number, r: number, div = false) => [withLatency(row(id, 1), o), (() => { const x = withLatency(row(id, 1), r); if (div) x.divergence = ["d"]; return x; })()] as const;
  const a = mk("a", 50, 100), b = mk("b", 100, 100), c = mk("c", 200, 100), d = mk("d", 900, 100, true);
  const rep = compareResults(result("odd", [a[0], b[0], c[0], d[0]]), result("oracle", [a[1], b[1], c[1], d[1]]));
  assert.equal(rep.summary.latency.median_ratio, 1);
  assert.equal(rep.summary.latency.compared, 3);
  assert.deepEqual(rep.summary.latency.verdicts, { equal: 1, better: 1, worse: 1, not_comparable: 0 });
  assert.equal(compareResults(result("odd", [row("a", 1)]), result("oracle", [row("a", 1)])).summary.latency.median_ratio, null);
});

test("efficiency verdict per dimension: no worse journey means at least as efficient; nothing compared is not assessable", () => {
  const odd = [row("a", 1), row("b", 1)], ora = [row("a", 1), row("b", 3)];
  odd[1]!.metrics!.model_runs = measured(5); ora[1]!.metrics!.model_runs = measured(2);
  const ev = efficiencyVerdict(compareResults(result("odd", odd), result("oracle", ora)));
  const d = (n: string) => ev.dimensions.find((x) => x.dimension === n)!;
  assert.equal(d("human_prompts").verdict, "at_least_as_efficient");
  assert.equal(d("human_prompts").better, 1);
  assert.equal(d("model_runs").verdict, "less_efficient");
  assert.equal(d("model_runs").worse, 1);
  assert.equal(d("git_subprocesses").verdict, "not_assessable");
  assert.equal(d("latency").verdict, "not_assessable");
  assert.equal(ev.overall, "less_efficient");
  const ok = efficiencyVerdict(compareResults(result("odd", [row("a", 1)]), result("oracle", [row("a", 1)])));
  assert.equal(ok.dimensions.find((x) => x.dimension === "human_prompts")!.verdict, "at_least_as_efficient");
});

test("efficiency verdict for latency follows the overall median ratio", () => {
  const f = (o: number) => efficiencyVerdict(compareResults(result("odd", [withLatency(row("a", 1), o)]), result("oracle", [withLatency(row("a", 1), 100)]))).dimensions.find((x) => x.dimension === "latency")!;
  assert.equal(f(110).verdict, "at_least_as_efficient");
  assert.equal(f(300).verdict, "less_efficient");
});
