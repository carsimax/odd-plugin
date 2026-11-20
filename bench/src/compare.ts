// Comparison format (`odd-claude.bench-comparison/v1`): odd vs oracle per journey per metric. Lower is better for every dimension.
import { DIMENSION_NAMES, blocksTotal, type DimensionName, type LatencyStat } from "./metrics.js";
import type { BenchResult, JourneyRow } from "./schema.js";

export const COMPARISON_SCHEMA_ID = "odd-claude.bench-comparison/v1";
export type Verdict = "equal" | "better" | "worse" | "not_comparable";
export interface Threshold { relative: number; absolute: number }
/** Two values are `equal` when |odd - oracle| <= max(absolute, relative * max(odd, oracle)). */
export interface Thresholds {
  default: Threshold;
  per_metric: Partial<Record<DimensionName | "blocks", Threshold>>;
  /** Latency compares the ratio of medians: equal when 1/(1+tolerance) <= odd/oracle <= 1+tolerance, or when the medians differ by at most `floor_ms`. */
  latency?: { tolerance: number; floor_ms: number };
}
/** Counts (prompts, commands, blocks, model runs, git, recovery) are exact; bytes and the token proxy tolerate 10% (the two products word their output differently). */
export const DEFAULT_THRESHOLDS: Required<Thresholds> = {
  default: { relative: 0, absolute: 0 },
  per_metric: { human_surface_bytes: { relative: 0.1, absolute: 0 }, manual_tokens: { relative: 0.1, absolute: 0 } },
  latency: { tolerance: 0.25, floor_ms: 5 },
};
/** The per-operation sample the runner adds to every journey: the sum of every process time of one run, one sample per repeat. Comparable across subjects (their operation names differ). */
export const JOURNEY_TOTAL_OP = "journey.total";

export type JourneyKind = "comparable" | "divergent" | "unsupported" | "missing";
export interface MetricComparison { odd: number | null; oracle: number | null; verdict: Verdict }
type Stat = Pick<LatencyStat, "samples" | "median_ms" | "p95_ms">;
export interface LatencyComparison { odd: Stat; oracle?: Stat; ratio: number | null; verdict: Verdict }
export interface JourneyComparison {
  id: string;
  kind: JourneyKind;
  outcome: "equal" | "different" | "not_comparable";
  /** Why the journey is not comparable (unsupported rows). */
  reason?: string;
  /** Declared divergences of the oracle on this journey: findings, never wins or losses. */
  divergence?: string[];
  metrics: Partial<Record<DimensionName | "blocks", MetricComparison>>;
  /** Per operation present in odd; only operations the oracle also has get a verdict (`journey.total` always does). */
  latency: Record<string, LatencyComparison>;
}
export interface PerMetricSummary { verdicts: Record<Verdict, number>; odd_total: number; oracle_total: number }
export interface ComparisonReport {
  schema: typeof COMPARISON_SCHEMA_ID;
  odd: BenchResult["meta"];
  oracle: BenchResult["meta"];
  thresholds: Required<Thresholds>;
  journeys: JourneyComparison[];
  summary: {
    outcome: Record<"equal" | "different" | "not_comparable", number>;
    metrics: Record<Verdict, number>;
    journeys: { total: number; comparable: number; divergent: number; unsupported: number; missing: number };
    /** Over comparable journeys only (divergent and unsupported rows never count). */
    per_metric: Partial<Record<DimensionName | "blocks", PerMetricSummary>>;
    latency: { compared: number; verdicts: Record<Verdict, number>; median_ratio: number | null };
  };
}

function verdict(odd: number | null, oracle: number | null, t: Threshold): Verdict {
  if (odd === null || oracle === null) return "not_comparable";
  if (Math.abs(odd - oracle) <= Math.max(t.absolute, t.relative * Math.max(odd, oracle))) return "equal";
  return odd < oracle ? "better" : "worse";
}

export const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]));
  return v;
}

const comparable = (r: JourneyRow | undefined): r is JourneyRow & { metrics: NonNullable<JourneyRow["metrics"]> } => r !== undefined && r.status !== "unsupported" && r.metrics !== null;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const zeroVerdicts = (): Record<Verdict, number> => ({ equal: 0, better: 0, worse: 0, not_comparable: 0 });

function latencyVerdict(odd: Stat, oracle: Stat, t: { tolerance: number; floor_ms: number }): { ratio: number | null; verdict: Verdict } {
  if (!(oracle.median_ms > 0)) return { ratio: null, verdict: "not_comparable" };
  const ratio = odd.median_ms / oracle.median_ms;
  const out = round3(ratio);
  if (Math.abs(odd.median_ms - oracle.median_ms) <= t.floor_ms) return { ratio: out, verdict: "equal" };
  if (ratio > 1 + t.tolerance) return { ratio: out, verdict: "worse" };
  if (ratio < 1 / (1 + t.tolerance)) return { ratio: out, verdict: "better" };
  return { ratio: out, verdict: "equal" };
}

const medianOf = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

export function compareResults(odd: BenchResult, oracle: BenchResult, thresholds: Thresholds = DEFAULT_THRESHOLDS): ComparisonReport {
  const th: Required<Thresholds> = {
    default: thresholds.default,
    per_metric: thresholds === DEFAULT_THRESHOLDS ? DEFAULT_THRESHOLDS.per_metric : thresholds.per_metric,
    latency: thresholds.latency ?? DEFAULT_THRESHOLDS.latency,
  };
  const byId = new Map(oracle.journeys.map((j) => [j.id, j]));
  const summary: ComparisonReport["summary"] = {
    outcome: { equal: 0, different: 0, not_comparable: 0 },
    metrics: zeroVerdicts(),
    journeys: { total: 0, comparable: 0, divergent: 0, unsupported: 0, missing: 0 },
    per_metric: {},
    latency: { compared: 0, verdicts: zeroVerdicts(), median_ratio: null },
  };
  const ratios: number[] = [];
  const journeys = odd.journeys.map((o): JourneyComparison => {
    const r = byId.get(o.id);
    const divergence = [...(o.divergence ?? []), ...(r?.divergence ?? [])];
    const out: JourneyComparison = { id: o.id, kind: "comparable", outcome: "not_comparable", metrics: {}, latency: {} };
    if (r === undefined) out.kind = "missing";
    else if (o.status === "unsupported" || r.status === "unsupported") { out.kind = "unsupported"; out.reason = r.status === "unsupported" ? r.reason : o.reason; }
    else if (divergence.length > 0) { out.kind = "divergent"; out.divergence = divergence; }
    summary.journeys.total += 1;
    summary.journeys[out.kind] += 1;
    if (comparable(o) && comparable(r)) {
      const counted = out.kind === "comparable";
      if (counted) out.outcome = o.outcome !== null && r.outcome !== null && sameJson(o.outcome, r.outcome) ? "equal" : "different";
      const put = (name: DimensionName | "blocks", ov: number | null, rv: number | null): void => {
        const v = counted ? verdict(ov, rv, th.per_metric[name] ?? th.default) : "not_comparable";
        out.metrics[name] = { odd: ov, oracle: rv, verdict: v };
        if (!counted) return;
        const p = (summary.per_metric[name] ??= { verdicts: zeroVerdicts(), odd_total: 0, oracle_total: 0 });
        p.verdicts[v] += 1;
        if (ov !== null && rv !== null) { p.odd_total += ov; p.oracle_total += rv; }
      };
      for (const name of DIMENSION_NAMES) put(name, o.metrics[name].value, r.metrics[name].value);
      const ob = o.metrics.blocks.value, rb = r.metrics.blocks.value;
      put("blocks", ob && blocksTotal(ob), rb && blocksTotal(rb));
      for (const [op, s] of Object.entries(o.metrics.latency)) {
        const odds: Stat = { samples: s.samples, median_ms: s.median_ms, p95_ms: s.p95_ms };
        const rs = r.metrics.latency[op];
        if (rs === undefined) { out.latency[op] = { odd: odds, ratio: null, verdict: "not_comparable" }; continue; }
        const rstat: Stat = { samples: rs.samples, median_ms: rs.median_ms, p95_ms: rs.p95_ms };
        const lv = counted ? latencyVerdict(odds, rstat, th.latency) : { ratio: rstat.median_ms > 0 ? round3(odds.median_ms / rstat.median_ms) : null, verdict: "not_comparable" as Verdict };
        out.latency[op] = { odd: odds, oracle: rstat, ratio: lv.ratio, verdict: lv.verdict };
        if (counted && op === JOURNEY_TOTAL_OP) {
          summary.latency.verdicts[lv.verdict] += 1;
          if (lv.ratio !== null) { summary.latency.compared += 1; ratios.push(lv.ratio); }
        }
      }
    }
    summary.outcome[out.outcome] += 1;
    for (const m of Object.values(out.metrics)) summary.metrics[m.verdict] += 1;
    return out;
  });
  if (ratios.length > 0) summary.latency.median_ratio = round3(medianOf(ratios));
  return { schema: COMPARISON_SCHEMA_ID, odd: odd.meta, oracle: oracle.meta, thresholds: th, journeys, summary };
}

export type EfficiencyVerdict = "at_least_as_efficient" | "less_efficient" | "not_assessable";
export interface DimensionVerdict { dimension: DimensionName | "blocks" | "latency"; verdict: EfficiencyVerdict; equal: number; better: number; worse: number; compared: number; note: string }
export interface EfficiencyReport { overall: EfficiencyVerdict; dimensions: DimensionVerdict[] }

/**
 * Is odd at least as efficient as the oracle on the comparable journeys, per dimension? A friction dimension is `less_efficient` as soon as
 * one comparable journey is `worse` (lower is better everywhere); latency follows the overall median ratio of per-journey totals against
 * `1 + tolerance`. A dimension with nothing compared is `not_assessable`, never a pass.
 */
export function efficiencyVerdict(report: ComparisonReport): EfficiencyReport {
  const dimensions: DimensionVerdict[] = [];
  for (const name of [...DIMENSION_NAMES, "blocks"] as const) {
    const v = report.summary.per_metric[name]?.verdicts ?? zeroVerdicts();
    const compared = v.equal + v.better + v.worse;
    const verdictOf: EfficiencyVerdict = compared === 0 ? "not_assessable" : v.worse > 0 ? "less_efficient" : "at_least_as_efficient";
    dimensions.push({ dimension: name, verdict: verdictOf, equal: v.equal, better: v.better, worse: v.worse, compared, note: `${v.worse} worse of ${compared} compared` });
  }
  const l = report.summary.latency;
  const tol = report.thresholds.latency.tolerance;
  const lv: EfficiencyVerdict = l.median_ratio === null ? "not_assessable" : l.median_ratio <= 1 + tol ? "at_least_as_efficient" : "less_efficient";
  dimensions.push({ dimension: "latency", verdict: lv, equal: l.verdicts.equal, better: l.verdicts.better, worse: l.verdicts.worse, compared: l.compared, note: l.median_ratio === null ? "no latency to compare" : `median ratio ${l.median_ratio.toFixed(2)} against a limit of ${(1 + tol).toFixed(2)}` });
  const assessed = dimensions.filter((d) => d.verdict !== "not_assessable");
  const overall: EfficiencyVerdict = assessed.length === 0 ? "not_assessable" : assessed.some((d) => d.verdict === "less_efficient") ? "less_efficient" : "at_least_as_efficient";
  return { overall, dimensions };
}
