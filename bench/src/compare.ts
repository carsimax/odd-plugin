// Comparison format (`odd-claude.bench-comparison/v1`): odd vs oracle per journey per metric. Lower is better for every dimension.
import { DIMENSION_NAMES, blocksTotal, type DimensionName, type LatencyStat } from "./metrics.js";
import type { BenchResult, JourneyRow } from "./schema.js";

export const COMPARISON_SCHEMA_ID = "odd-claude.bench-comparison/v1";
export type Verdict = "equal" | "better" | "worse" | "not_comparable";
export interface Threshold { relative: number; absolute: number }
/** Two values are `equal` when |odd - oracle| <= max(absolute, relative * max(odd, oracle)). */
export interface Thresholds { default: Threshold; per_metric: Partial<Record<DimensionName | "blocks", Threshold>> }
export const DEFAULT_THRESHOLDS: Thresholds = { default: { relative: 0.1, absolute: 0 }, per_metric: {} };

export interface MetricComparison { odd: number | null; oracle: number | null; verdict: Verdict }
export interface JourneyComparison {
  id: string;
  outcome: "equal" | "different" | "not_comparable";
  metrics: Partial<Record<DimensionName | "blocks", MetricComparison>>;
  /** Odd-only: the oracle has no latency, so every verdict is not_comparable. */
  latency: Record<string, { odd: Pick<LatencyStat, "samples" | "median_ms" | "p95_ms">; verdict: "not_comparable" }>;
}
export interface ComparisonReport {
  schema: typeof COMPARISON_SCHEMA_ID;
  odd: BenchResult["meta"];
  oracle: BenchResult["meta"];
  thresholds: Thresholds;
  journeys: JourneyComparison[];
  summary: { outcome: Record<"equal" | "different" | "not_comparable", number>; metrics: Record<Verdict, number> };
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

export function compareResults(odd: BenchResult, oracle: BenchResult, thresholds: Thresholds = DEFAULT_THRESHOLDS): ComparisonReport {
  const byId = new Map(oracle.journeys.map((j) => [j.id, j]));
  const summary: ComparisonReport["summary"] = { outcome: { equal: 0, different: 0, not_comparable: 0 }, metrics: { equal: 0, better: 0, worse: 0, not_comparable: 0 } };
  const journeys = odd.journeys.map((o): JourneyComparison => {
    const r = byId.get(o.id);
    const out: JourneyComparison = { id: o.id, outcome: "not_comparable", metrics: {}, latency: {} };
    if (comparable(o) && comparable(r)) {
      out.outcome = o.outcome !== null && r.outcome !== null && sameJson(o.outcome, r.outcome) ? "equal" : "different";
      for (const name of DIMENSION_NAMES) {
        out.metrics[name] = { odd: o.metrics[name].value, oracle: r.metrics[name].value, verdict: verdict(o.metrics[name].value, r.metrics[name].value, thresholds.per_metric[name] ?? thresholds.default) };
      }
      const ob = o.metrics.blocks.value, rb = r.metrics.blocks.value;
      out.metrics.blocks = { odd: ob && blocksTotal(ob), oracle: rb && blocksTotal(rb), verdict: verdict(ob && blocksTotal(ob), rb && blocksTotal(rb), thresholds.per_metric.blocks ?? thresholds.default) };
      for (const [op, s] of Object.entries(o.metrics.latency)) out.latency[op] = { odd: { samples: s.samples, median_ms: s.median_ms, p95_ms: s.p95_ms }, verdict: "not_comparable" };
    }
    summary.outcome[out.outcome] += 1;
    for (const m of Object.values(out.metrics)) summary.metrics[m.verdict] += 1;
    return out;
  });
  return { schema: COMPARISON_SCHEMA_ID, odd: odd.meta, oracle: oracle.meta, thresholds, journeys, summary };
}
