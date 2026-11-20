import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyMetricSet, measured, proxy, unobservable, summarizeLatency } from "./metrics.js";
import { compareResults } from "./compare.js";
import { aggregateRepeats, buildResult, renderReport } from "./report.js";
import { RESULT_SCHEMA_ID, validateResult, type BenchResult, type JourneyRow } from "./schema.js";

const meta = (subject: "odd" | "oracle", version: string): BenchResult["meta"] => ({ subject, binary: { path: `/x/${subject}`, version }, node: "v22.1.0", os: { platform: "darwin", arch: "arm64", release: "27.2.0" }, commit: "c", started_at: "2026-01-01T00:00:00.000Z", repeats: 3 });
const result = (subject: "odd" | "oracle", rows: JourneyRow[]): BenchResult => ({ schema: RESULT_SCHEMA_ID, meta: meta(subject, subject === "odd" ? "2.0.0" : "4.6.0"), journeys: rows, aggregate: { counts: { passed: rows.length, failed: 0, unsupported: 0 }, metrics: null } });
const row = (id: string, prompts: number, ms = 100): JourneyRow => {
  const m = emptyMetricSet();
  m.human_prompts = measured(prompts); m.manual_tokens = proxy(2); m.commands_to_completion = measured(4); m.recovery_round_trips = measured(0);
  m.model_runs = measured(0); m.human_surface_bytes = measured(100); m.git_subprocesses = measured(1);
  m.blocks = { value: { self_recovered: 0, in_band: 0, out_of_band: 0, by_design: 0, dead_end: 0 }, derivation: "measured" };
  m.latency["journey.total"] = { samples: 3, median_ms: ms, p95_ms: ms + 10 };
  return { id, status: "passed", outcome: { ok: true }, metrics: m };
};

function sampleReport(): string {
  const div = row("declined", 1); div.divergence = ["a decline persists nothing"];
  const unsup: JourneyRow = { id: "push-denied", status: "unsupported", outcome: null, metrics: null, reason: "validate --gate is non-deciding in 4.6.0" };
  const odd = result("odd", [row("alpha", 1), row("beta", 3), row("declined", 9), row("push-denied", 1)]);
  const ora = result("oracle", [row("alpha", 1), row("beta", 1), div, unsup]);
  return renderReport(compareResults(odd, ora));
}

test("report has the documented sections in order", () => {
  const md = sampleReport();
  const heads = ["# Efficiency report", "## Run", "## Summary", "## Efficiency verdict", "## Journeys", "## Unsupported journeys", "## Declared divergences", "## How to read"];
  let at = -1;
  for (const h of heads) {
    const i = md.search(new RegExp(`^${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(:.*)?$`, "m"));
    assert.ok(i > at, `${h} missing or out of order`);
    at = i;
  }
});

test("run section records node, OS, versions and repeats for both subjects", () => {
  const md = sampleReport();
  assert.match(md, /node v22\.1\.0/);
  assert.match(md, /darwin arm64 27\.2\.0/);
  assert.match(md, /odd[^\n]*2\.0\.0/);
  assert.match(md, /oracle[^\n]*4\.6\.0/);
  assert.match(md, /repeats: 3/);
});

test("journeys show odd vs oracle per metric with a verdict; unsupported and divergent are listed apart", () => {
  const md = sampleReport();
  assert.match(md, /### alpha[\s\S]*?\| human_prompts \| 1 \| 1 \| equal \|/);
  assert.match(md, /### beta[\s\S]*?\| human_prompts \| 3 \| 1 \| worse \|/);
  const unsup = md.slice(md.indexOf("## Unsupported journeys"), md.indexOf("## Declared divergences"));
  assert.match(unsup, /push-denied/);
  assert.match(unsup, /non-deciding/);
  const divs = md.slice(md.indexOf("## Declared divergences"), md.indexOf("## How to read"));
  assert.match(divs, /declined/);
  assert.match(divs, /a decline persists nothing/);
  assert.match(divs, /never counted as wins or losses/);
  const journeys = md.slice(md.indexOf("## Journeys"), md.indexOf("## Unsupported journeys"));
  assert.doesNotMatch(journeys, /### push-denied/);
  assert.doesNotMatch(journeys, /### declined/);
});

test("summary counts journeys and metric verdicts; latency shows the median ratio and p95", () => {
  const md = sampleReport();
  assert.match(md, /comparable: 2 of 4/);
  assert.match(md, /divergent: 1/);
  assert.match(md, /unsupported: 1/);
  assert.match(md, /\| human_prompts \| 1 \| 0 \| 1 \| 0 \| 4 \| 2 \|/); // equal, better, worse, n/c, odd total, oracle total
  assert.match(md, /median ratio 1\.00/);
  assert.match(md, /p95/);
});

test("efficiency verdict states the answer per dimension and the accounting caveats", () => {
  const md = sampleReport();
  const v = md.slice(md.indexOf("## Efficiency verdict"), md.indexOf("## Journeys"));
  assert.match(v, /human_prompts[^\n]*less_efficient/);
  assert.match(v, /commands_to_completion[^\n]*at_least_as_efficient/);
  assert.match(v, /Overall: /);
  assert.match(v, /cost forecast/);
  assert.match(v, /two commands/);
  assert.match(v, /git_subprocesses/);
  assert.match(v, /4\.6\.0/);
});

test("a fully equal run reads as at least as efficient overall", () => {
  const md = renderReport(compareResults(result("odd", [row("a", 1)]), result("oracle", [row("a", 1)])));
  assert.match(md, /Overall: odd-claude is at least as efficient/);
});

test("pipes in reasons are escaped so tables stay intact", () => {
  const unsup: JourneyRow = { id: "u", status: "unsupported", outcome: null, metrics: null, reason: "a | b" };
  const md = renderReport(compareResults(result("odd", [row("u", 1)]), result("oracle", [unsup])));
  assert.match(md, /a \\\| b/);
});

// ---- K-repeat aggregation ----
const run = (samples: Record<string, number[]>, over: Partial<JourneyRow> = {}): JourneyRow => {
  const r = row("j", 1);
  r.metrics!.latency = Object.fromEntries(Object.entries(samples).map(([op, xs]) => [op, summarizeLatency(xs)]));
  return { ...r, ...over };
};

test("aggregateRepeats pools samples per operation and records the median of per-run totals as journey.total", () => {
  const agg = aggregateRepeats([run({ "cli.a": [10, 20] }), run({ "cli.a": [30, 40] }), run({ "cli.a": [100, 200] })]);
  assert.equal(agg.status, "passed");
  assert.equal(agg.metrics!.latency["cli.a"]!.samples, 6);
  assert.equal(agg.metrics!.latency["cli.a"]!.median_ms, 35);
  // totals per run: 30, 70, 300 -> median 70, p95 300
  assert.equal(agg.metrics!.latency["journey.total"]!.median_ms, 70);
  assert.equal(agg.metrics!.latency["journey.total"]!.p95_ms, 300);
  assert.equal(agg.metrics!.latency["journey.total"]!.samples, 3);
  assert.deepEqual(validateResult(buildResult("odd", [agg], { binaryPath: "x", binaryVersion: "y", commit: "z", repeats: 3 })), []);
});

test("aggregateRepeats keeps friction from the runs when they agree, and a single run still gets journey.total", () => {
  const one = aggregateRepeats([run({ "mcp.x": [5, 7] })]);
  assert.equal(one.metrics!.latency["journey.total"]!.median_ms, 12);
  assert.equal(one.metrics!.human_prompts.value, 1);
});

test("aggregateRepeats fails a journey whose friction differs between repeats, or that failed once", () => {
  const b = run({ "cli.a": [1] }); b.metrics!.commands_to_completion = measured(9);
  const unstable = aggregateRepeats([run({ "cli.a": [1] }), b]);
  assert.equal(unstable.status, "failed");
  assert.match(unstable.reason ?? "", /unstable across repeats: commands_to_completion/);
  const failed = aggregateRepeats([run({ "cli.a": [1] }), run({ "cli.a": [1] }, { status: "failed", reason: "boom" })]);
  assert.equal(failed.status, "failed");
  assert.match(failed.reason ?? "", /boom/);
});

test("aggregateRepeats passes an unsupported row through untouched and keeps ref_id", () => {
  const u: JourneyRow & { ref_id?: string } = { id: "u", status: "unsupported", outcome: null, metrics: null, reason: "r", ref_id: "up" };
  assert.deepEqual(aggregateRepeats([u, u]), u);
});

test("unobservable dimensions that agree across repeats stay unobservable", () => {
  const a = run({ "cli.a": [1] }); a.metrics!.git_subprocesses = unobservable("n/a");
  const b = run({ "cli.a": [1] }); b.metrics!.git_subprocesses = unobservable("n/a");
  assert.equal(aggregateRepeats([a, b]).metrics!.git_subprocesses.value, null);
});

test("buildResult records repeats when given", () => {
  assert.equal(buildResult("odd", [], { binaryPath: "x", binaryVersion: "y", commit: "z", repeats: 3 }).meta.repeats, 3);
  assert.equal(buildResult("odd", [], { binaryPath: "x", binaryVersion: "y", commit: "z" }).meta.repeats, undefined);
});
