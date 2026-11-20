// Metric model of the efficiency bench. Friction dimensions mirror the upstream bench's vocabulary under odd names; each
// dimension carries how its number was obtained so a proxy can never be read as a measurement. Latency is odd-only.

export type Derivation = "measured" | "proxy" | "unobservable";

/** One friction number. `value` is null (never a fabricated 0) exactly when the derivation is `unobservable`. */
export interface Dimension {
  value: number | null;
  derivation: Derivation;
  note?: string;
}

export const BLOCK_CLASSES = ["self_recovered", "in_band", "out_of_band", "by_design", "dead_end"] as const;
export type BlockClass = (typeof BLOCK_CLASSES)[number];
/** Every block lands in exactly one bucket. `by_design` is a reclassification of out_of_band, never a subtraction: it still counts in the total. */
export type BlockCounts = Record<BlockClass, number>;

export interface BlocksDimension {
  value: BlockCounts | null;
  derivation: Derivation;
  note?: string;
}

export interface LatencyStat {
  samples: number;
  median_ms: number;
  p95_ms: number;
  /** Raw samples, kept so aggregates pool samples instead of averaging percentiles. */
  samples_ms?: number[];
}

export interface MetricSet {
  human_prompts: Dimension;
  manual_tokens: Dimension;
  commands_to_completion: Dimension;
  blocks: BlocksDimension;
  recovery_round_trips: Dimension;
  model_runs: Dimension;
  human_surface_bytes: Dimension;
  git_subprocesses: Dimension;
  /** Per operation (e.g. `mcp.review_status`), fresh process per sample. Odd-only. */
  latency: Record<string, LatencyStat>;
}

export const DIMENSION_NAMES = ["human_prompts", "manual_tokens", "commands_to_completion", "recovery_round_trips", "model_runs", "human_surface_bytes", "git_subprocesses"] as const;
export type DimensionName = (typeof DIMENSION_NAMES)[number];

/** How each metric is derived for odd's surface (MCP tools + hooks + review-mode CLI). */
export const METRIC_DERIVATIONS: Record<DimensionName | "blocks" | "latency", { derivation: Derivation; how: string }> = {
  human_prompts: { derivation: "measured", how: "Journey steps whose actor is `human` (consent answers, approvals): each is one prompt the human had to act on." },
  manual_tokens: { derivation: "proxy", how: "ceil(UTF-8 bytes / 4) of the text declared on human steps; no tokenizer is observable offline." },
  commands_to_completion: { derivation: "measured", how: "Agent steps executed until the journey ends: one MCP tool call, hook invocation or review-mode CLI command each." },
  blocks: { derivation: "measured", how: "Steps that return a block (hook deny, tool isError refusal), bucketed by the class the journey declares for it." },
  recovery_round_trips: { derivation: "measured", how: "Steps that succeed immediately after a blocked step: one retry round trip each." },
  model_runs: { derivation: "measured", how: "Invocations of the fake `claude` on the sandbox PATH (counting shim); no model ever runs." },
  human_surface_bytes: { derivation: "measured", how: "UTF-8 bytes of what the agent/human is shown: MCP tool text results, hook stdout and text relayed by human steps." },
  git_subprocesses: { derivation: "measured", how: "Invocations of `git` through the sandbox PATH shim, which counts and forwards to the real git." },
  latency: { derivation: "measured", how: "Wall-clock ms per operation from process spawn to result, fresh process per sample." },
};

export const measured = (value: number, note?: string): Dimension => ({ value, derivation: "measured", ...(note !== undefined ? { note } : {}) });
export const proxy = (value: number, note?: string): Dimension => ({ value, derivation: "proxy", ...(note !== undefined ? { note } : {}) });
export const unobservable = (note?: string): Dimension => ({ value: null, derivation: "unobservable", ...(note !== undefined ? { note } : {}) });

export const emptyBlocks = (): BlockCounts => ({ self_recovered: 0, in_band: 0, out_of_band: 0, by_design: 0, dead_end: 0 });

export function addBlock(b: BlockCounts, cls: BlockClass): void {
  if (!(BLOCK_CLASSES as readonly string[]).includes(cls)) throw new Error(`unknown block class: ${String(cls)}`);
  b[cls] += 1;
}

export const blocksTotal = (b: BlockCounts): number => BLOCK_CLASSES.reduce((n, c) => n + b[c], 0);

export function emptyMetricSet(): MetricSet {
  return {
    human_prompts: unobservable(),
    manual_tokens: unobservable(),
    commands_to_completion: unobservable(),
    blocks: { value: null, derivation: "unobservable" },
    recovery_round_trips: unobservable(),
    model_runs: unobservable(),
    human_surface_bytes: unobservable(),
    git_subprocesses: unobservable(),
    latency: {},
  };
}

function sortedFinite(samples: readonly number[]): number[] {
  if (samples.length === 0) throw new Error("empty sample set");
  if (!samples.every(Number.isFinite)) throw new Error("samples must be finite numbers");
  return [...samples].sort((a, b) => a - b);
}

/** Nearest-rank percentile (rank in (0,100]); never mutates its input. */
export function percentile(samples: readonly number[], rank: number): number {
  const s = sortedFinite(samples);
  if (!(rank > 0 && rank <= 100)) throw new Error(`rank must be in (0,100], got ${rank}`);
  return s[Math.ceil((rank / 100) * s.length) - 1]!;
}

/** True median: the mean of the two middle samples for even counts. */
export function median(samples: readonly number[]): number {
  const s = sortedFinite(samples);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function summarizeLatency(samples: readonly number[]): LatencyStat {
  return { samples: samples.length, median_ms: round3(median(samples)), p95_ms: round3(percentile(samples, 95)), samples_ms: [...samples] };
}

const WEAKNESS: Record<Derivation, number> = { measured: 0, proxy: 1, unobservable: 2 };

function aggregateDimension(dims: readonly Dimension[]): Dimension {
  const seen = dims.filter((d) => d.value !== null);
  if (seen.length === 0) return unobservable();
  const weakest = seen.reduce<Derivation>((w, d) => (WEAKNESS[d.derivation] > WEAKNESS[w] ? d.derivation : w), "measured");
  const sum = seen.reduce((n, d) => n + (d.value as number), 0);
  if (seen.length < dims.length) return { value: sum, derivation: "unobservable", note: `${seen.length} of ${dims.length} journeys observable` };
  return { value: sum, derivation: weakest };
}

/** Sums observable values across rows (an unobservable row adds nothing and downgrades the derivation); latency pools raw samples. */
export function aggregateMetrics(sets: readonly MetricSet[]): MetricSet {
  const out = emptyMetricSet();
  if (sets.length === 0) return out;
  for (const name of DIMENSION_NAMES) out[name] = aggregateDimension(sets.map((s) => s[name]));
  const withBlocks = sets.filter((s) => s.blocks.value !== null);
  if (withBlocks.length > 0) {
    const total = emptyBlocks();
    for (const s of withBlocks) for (const c of BLOCK_CLASSES) total[c] += s.blocks.value![c];
    out.blocks = withBlocks.length < sets.length
      ? { value: total, derivation: "unobservable", note: `${withBlocks.length} of ${sets.length} journeys observable` }
      : { value: total, derivation: withBlocks.some((s) => s.blocks.derivation === "proxy") ? "proxy" : "measured" };
  }
  const pooled = new Map<string, number[]>();
  for (const s of sets) for (const [op, stat] of Object.entries(s.latency)) if (stat.samples_ms) pooled.set(op, [...(pooled.get(op) ?? []), ...stat.samples_ms]);
  for (const [op, xs] of pooled) out.latency[op] = summarizeLatency(xs);
  return out;
}
