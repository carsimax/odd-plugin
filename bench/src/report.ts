// Result building, K-repeat aggregation and the human-readable comparison report (`report.md`).
import { DIMENSION_NAMES, aggregateMetrics, summarizeLatency, type DimensionName, type MetricSet } from "./metrics.js";
import { JOURNEY_TOTAL_OP, efficiencyVerdict, sameJson, type ComparisonReport, type JourneyComparison, type Verdict } from "./compare.js";
import { RESULT_SCHEMA_ID, type BenchResult, type JourneyRow, type Subject } from "./schema.js";
import { release } from "node:os";

export function buildResult(subject: Subject, rows: JourneyRow[], bin: { binaryPath: string; binaryVersion: string; commit: string; repeats?: number }): BenchResult {
  const counts = { passed: 0, failed: 0, unsupported: 0 };
  for (const r of rows) counts[r.status] += 1;
  const withMetrics = rows.flatMap((r) => (r.metrics ? [r.metrics] : []));
  return {
    schema: RESULT_SCHEMA_ID,
    meta: { subject, binary: { path: bin.binaryPath, version: bin.binaryVersion }, node: process.version, os: { platform: process.platform, arch: process.arch, release: release() }, commit: bin.commit, started_at: new Date().toISOString(), ...(bin.repeats !== undefined ? { repeats: bin.repeats } : {}) },
    journeys: rows,
    aggregate: { counts, metrics: withMetrics.length > 0 ? aggregateMetrics(withMetrics) : null },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// K repeats
// ---------------------------------------------------------------------------------------------------------------------------

const runTotal = (m: MetricSet): number => Object.entries(m.latency).reduce((n, [op, s]) => (op === JOURNEY_TOTAL_OP ? n : n + (s.samples_ms ? s.samples_ms.reduce((a, b) => a + b, 0) : s.median_ms * s.samples)), 0);
const frictionOf = (m: MetricSet): Record<string, unknown> => { const { latency: _latency, ...rest } = m; return rest; };

/**
 * Folds the K runs of one journey into one row. Friction is deterministic, so every passed run must agree on it (otherwise the journey
 * is `failed` as unstable, never averaged); latency samples are pooled per operation and `journey.total` holds one sample per run (the
 * sum of that run's process times), so its median is the median of K whole-journey times.
 */
export function aggregateRepeats<R extends JourneyRow>(runs: readonly R[]): R {
  const first = runs[0];
  if (first === undefined) throw new Error("aggregateRepeats needs at least one run");
  if (first.status === "unsupported") return first;
  const failed = runs.find((r) => r.status === "failed");
  const withMetrics = runs.filter((r): r is R & { metrics: MetricSet } => r.metrics !== null);
  const base = failed ?? first;
  const pooled = new Map<string, number[]>();
  for (const r of withMetrics) for (const [op, s] of Object.entries(r.metrics.latency)) if (op !== JOURNEY_TOTAL_OP) pooled.set(op, [...(pooled.get(op) ?? []), ...(s.samples_ms ?? Array<number>(s.samples).fill(s.median_ms))]);
  const metrics: MetricSet = { ...(first.metrics as MetricSet), latency: {} };
  for (const [op, xs] of pooled) metrics.latency[op] = summarizeLatency(xs);
  if (withMetrics.length > 0) metrics.latency[JOURNEY_TOTAL_OP] = summarizeLatency(withMetrics.map((r) => runTotal(r.metrics)));
  let status = base.status, reason = base.reason;
  if (failed) reason = `repeat failed: ${failed.reason ?? "unknown"}`;
  else {
    const unstable = DIMENSION_NAMES.filter((n: DimensionName) => withMetrics.some((r) => !sameJson(r.metrics[n], first.metrics![n]))) as string[];
    if (withMetrics.some((r) => !sameJson(r.metrics.blocks, first.metrics!.blocks))) unstable.push("blocks");
    if (unstable.length > 0) { status = "failed"; reason = `unstable across repeats: ${unstable.join(", ")}`; }
  }
  return { ...base, status, ...(reason !== undefined ? { reason } : {}), metrics } as R;
}

// ---------------------------------------------------------------------------------------------------------------------------
// report.md
// ---------------------------------------------------------------------------------------------------------------------------

const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const num = (n: number | null): string => (n === null ? "n/a" : Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const ms = (n: number): string => `${Math.round(n * 10) / 10} ms`;
const VERDICTS: Verdict[] = ["equal", "better", "worse", "not_comparable"];

function metaLine(label: string, m: ComparisonReport["odd"]): string {
  return `- ${label}: ${m.binary.version} (${esc(m.binary.path)}), commit ${m.commit.slice(0, 12)}, node ${m.node}, ${m.os.platform} ${m.os.arch} ${m.os.release}, repeats: ${m.repeats ?? 1}, started ${m.started_at}`;
}

function journeySection(j: JourneyComparison): string[] {
  const out = [`### ${j.id}`, "", `Outcome projection: **${j.outcome}**`, "", "| metric | odd | oracle | verdict |", "| --- | --- | --- | --- |"];
  for (const [name, m] of Object.entries(j.metrics)) out.push(`| ${name} | ${num(m.odd)} | ${num(m.oracle)} | ${m.verdict} |`);
  const t = j.latency[JOURNEY_TOTAL_OP];
  if (t?.oracle) out.push(`| latency (median of whole-journey time) | ${ms(t.odd.median_ms)} | ${ms(t.oracle.median_ms)} | ${t.verdict} (ratio ${t.ratio === null ? "n/a" : t.ratio.toFixed(2)}; p95 ${ms(t.odd.p95_ms)} vs ${ms(t.oracle.p95_ms)}) |`);
  return [...out, ""];
}

/** Renders the comparison as Markdown. Pure: no clock, no I/O. */
export function renderReport(c: ComparisonReport): string {
  const ev = efficiencyVerdict(c);
  const s = c.summary;
  const th = c.thresholds;
  const L: string[] = ["# Efficiency report: odd-claude vs upstream oracle", ""];
  L.push("## Run", "", metaLine("odd", c.odd), metaLine("oracle", c.oracle), "",
    "Both subjects ran in the same bench invocation on this machine, each journey in fresh processes inside its own sandbox, repeated `repeats` times; latency uses the median of the repeats.",
    c.odd.binary.version !== c.oracle.binary.version ? `The oracle is ${c.oracle.binary.version}; the journeys were ported from sources pinned at 08317b9 (version skew, see docs/bench.md).` : "", "");

  L.push("## Summary", "",
    `- journeys: ${s.journeys.total}; comparable: ${s.journeys.comparable} of ${s.journeys.total}; divergent: ${s.journeys.divergent}; unsupported: ${s.journeys.unsupported}; missing: ${s.journeys.missing}`,
    `- outcome projections on comparable journeys: equal ${s.outcome.equal}, different ${s.outcome.different}`,
    `- thresholds: counts exact (±${th.default.absolute}, ${th.default.relative * 100}%); ${Object.entries(th.per_metric).map(([k, t]) => `${k} ±${t.absolute} or ${t.relative * 100}%`).join("; ") || "no per-metric overrides"}; latency: ratio of medians within ×${(1 + th.latency.tolerance).toFixed(2)} (or ${th.latency.floor_ms} ms apart) is equal`,
    "", "Per metric over the comparable journeys (lower is better; totals sum journeys where both sides are observable):", "",
    "| metric | equal | better | worse | not_comparable | odd total | oracle total |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const name of [...DIMENSION_NAMES, "blocks"] as const) {
    const p = s.per_metric[name];
    if (p) L.push(`| ${name} | ${VERDICTS.map((v) => p.verdicts[v]).join(" | ")} | ${num(p.odd_total)} | ${num(p.oracle_total)} |`);
  }
  const lat = s.latency;
  L.push("", `Latency (whole-journey time, median of repeats): ${lat.compared} journeys compared; equal ${lat.verdicts.equal}, better ${lat.verdicts.better}, worse ${lat.verdicts.worse}; median ratio ${lat.median_ratio === null ? "n/a" : lat.median_ratio.toFixed(2)} (odd / oracle, below 1 is faster); p95 per journey is in the tables below.`, "");

  L.push("## Efficiency verdict", "", "Is odd-claude at least as efficient as upstream on the comparable journeys, per dimension? (`less_efficient` as soon as one comparable journey is worse; latency by the overall median ratio.)", "",
    "| dimension | verdict | equal | better | worse | note |", "| --- | --- | --- | --- | --- | --- |");
  for (const d of ev.dimensions) L.push(`| ${d.dimension} | ${d.verdict} | ${d.equal} | ${d.better} | ${d.worse} | ${esc(d.note)} |`);
  const bad = ev.dimensions.filter((d) => d.verdict === "less_efficient").map((d) => d.dimension);
  L.push("", ev.overall === "at_least_as_efficient" ? `Overall: odd-claude is at least as efficient as upstream on all ${s.journeys.comparable} comparable journeys, in every assessable dimension.`
    : ev.overall === "less_efficient" ? `Overall: odd-claude is less efficient than upstream in: ${bad.join(", ")}. Read the caveats below before concluding anything.`
    : "Overall: nothing could be assessed (no comparable journey).",
    "", "Caveats (accounting conventions, see docs/bench.md):", "",
    "- Human prompts: odd asks the human to approve a reviewer cost forecast before running reviewers; the oracle has no cost forecast, so its only human prompt is the consent answer. Odd therefore shows more prompts by design (a safety step, not friction a user of the oracle avoids by being smarter).",
    "- Commands: every process is one command. Starting and inspecting a review cost two commands on the oracle (its status preflight, then the start); odd does it in one call.",
    "- `git_subprocesses` counts only `git` invocations that go through the sandbox `PATH` shim (what each product spawns); a git call made by an absolute path or an in-process library is invisible, and setup git calls are never counted.",
    "- `manual_tokens` is a proxy (bytes / 4 of declared human text); `human_surface_bytes` counts stdout and stderr, so it compares how verbose each product is, not how useful.",
    `- Latency compares different surfaces (odd: MCP server, hooks and CLI on node; oracle: one native binary per command), so it is a same-machine cost comparison, not a quality one.${c.odd.binary.version !== c.oracle.binary.version ? ` The oracle is ${c.oracle.binary.version}, not the pinned reference.` : ""}`,
    `- Unsupported (${s.journeys.unsupported}) and divergent (${s.journeys.divergent}) journeys are excluded from every verdict above.`, "");

  const cmp = c.journeys.filter((j) => j.kind === "comparable");
  L.push("## Journeys", "", cmp.length ? "Comparable journeys: odd vs oracle per metric." : "No comparable journey.", "");
  for (const j of cmp) L.push(...journeySection(j));

  const unsup = c.journeys.filter((j) => j.kind === "unsupported" || j.kind === "missing");
  L.push("## Unsupported journeys", "", "The oracle cannot express these (marked, never faked); they are not wins or losses.", "");
  if (unsup.length) L.push("| journey | reason |", "| --- | --- |", ...unsup.map((j) => `| ${j.id} | ${esc(j.reason ?? (j.kind === "missing" ? "not present in the oracle result" : "unsupported"))} |`), "");
  else L.push("None.", "");

  const div = c.journeys.filter((j) => j.kind === "divergent");
  L.push("## Declared divergences", "", "Where the oracle legitimately behaves differently from the shared expectation. Declared findings, never counted as wins or losses; the raw numbers are shown for information.", "");
  if (div.length) {
    L.push("| journey | divergence | human_prompts odd/oracle | commands odd/oracle |", "| --- | --- | --- | --- |");
    for (const j of div) L.push(`| ${j.id} | ${esc((j.divergence ?? []).join("; "))} | ${num(j.metrics.human_prompts?.odd ?? null)} / ${num(j.metrics.human_prompts?.oracle ?? null)} | ${num(j.metrics.commands_to_completion?.odd ?? null)} / ${num(j.metrics.commands_to_completion?.oracle ?? null)} |`);
    L.push("");
  } else L.push("None.", "");

  L.push("## How to read", "", "- `equal | better | worse | not_comparable` are from odd's point of view; lower is better for every metric. `not_comparable` means a side is unobservable, unsupported or divergent.",
    "- Counts are exact by default; bytes and tokens tolerate 10%; latency uses the ratio of medians with the tolerance above. Details, derivations and limits: docs/bench.md.", "");
  return L.join("\n");
}
