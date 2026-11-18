// Pure rendering of the odd-claude statusLine (R44) and its tokens/s segment (R42).
// Port of the upstream status bar semantics: segments separated by a dim dot, context gauge tone
// turning warning at 80% and error at 95% (upstream shell-gauge thresholds), tokens/s computed from
// output tokens over API time (upstream TPS extension). No I/O here: callers pass everything in.

export const FALLBACK_LINE = "odd-claude";
const SEP = " · ";
const WARNING_THRESHOLD = 80;
const ERROR_THRESHOLD = 95;

export interface RenderOptions {
  color: boolean;
  /** Terminal width; the line never exceeds it. */
  cols: number;
  /** Coordinator mode on/off; omitted when unknown. */
  coordinator?: boolean;
  persona?: string;
  branch?: string;
  tps?: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Strips escape sequences, control and bidi characters: payload text is never trusted. */
export function cleanText(s: unknown): string {
  if (typeof s !== "string") return "";
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]?/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u061c\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
      .trim()
  );
}

function modelName(p: Obj): string {
  const m = p.model;
  if (typeof m === "string") return cleanText(m);
  if (!isObj(m)) return "";
  return cleanText(m.display_name) || cleanText(m.id);
}

/** Context window usage in percent: the payload value, else derived from current_usage. */
function contextPercent(p: Obj): number | undefined {
  const cw = p.context_window;
  if (!isObj(cw)) return undefined;
  const used = num(cw.used_percentage);
  if (used !== undefined) return used;
  const size = num(cw.context_window_size);
  const cu = cw.current_usage;
  if (size === undefined || size <= 0 || !isObj(cu)) return undefined;
  const total = (num(cu.input_tokens) ?? 0) + (num(cu.cache_read_input_tokens) ?? 0) + (num(cu.cache_creation_input_tokens) ?? 0);
  return (total / size) * 100;
}

function rateLimit(p: Obj, key: string): number | undefined {
  const rl = p.rate_limits;
  if (!isObj(rl)) return undefined;
  const w = rl[key];
  return isObj(w) ? num(w.used_percentage) : undefined;
}

export interface UsageSample {
  outputTokens: number;
  apiMs: number;
}

/** Cumulative output tokens and API time of the session, or undefined when the payload lacks them. */
export function extractUsage(payload: unknown): UsageSample | undefined {
  if (!isObj(payload)) return undefined;
  const cw = payload.context_window;
  const cost = payload.cost;
  const outputTokens = isObj(cw) ? num(cw.total_output_tokens) : undefined;
  const apiMs = isObj(cost) ? num(cost.total_api_duration_ms) : undefined;
  return outputTokens === undefined || apiMs === undefined ? undefined : { outputTokens, apiMs };
}

/**
 * Tokens per second. Between two invocations: output delta over API-time delta; with no previous
 * sample or after the counters went backwards: the session average; when no API time elapsed: the
 * previous reading. Undefined when there is nothing to compute from.
 */
export function computeTps(cur: UsageSample | undefined, prev?: UsageSample & { tps?: number }): number | undefined {
  if (cur === undefined) return undefined;
  const average = cur.apiMs > 0 && cur.outputTokens > 0 ? cur.outputTokens / (cur.apiMs / 1000) : undefined;
  if (prev === undefined || cur.outputTokens < prev.outputTokens || cur.apiMs < prev.apiMs) return average;
  const dOut = cur.outputTokens - prev.outputTokens;
  const dMs = cur.apiMs - prev.apiMs;
  if (dMs > 0 && dOut > 0) return dOut / (dMs / 1000);
  return prev.tps ?? average;
}

interface Segment {
  text: string;
  sgr: string;
}

function tone(percent: number): string {
  return percent >= ERROR_THRESHOLD ? "31" : percent >= WARNING_THRESHOLD ? "33" : "38;5;211";
}

function buildSegments(payload: unknown, o: RenderOptions): Segment[] {
  const p = isObj(payload) ? payload : {};
  const segs: Segment[] = [];
  const model = modelName(p);
  if (model) segs.push({ text: model, sgr: "1" });
  const ctx = contextPercent(p);
  if (ctx !== undefined) segs.push({ text: `ctx ${Math.round(ctx)}%`, sgr: tone(ctx) });
  if (o.coordinator !== undefined) segs.push({ text: `coord ${o.coordinator ? "ON" : "OFF"}`, sgr: o.coordinator ? "32" : "2" });
  const persona = cleanText(o.persona);
  if (persona) segs.push({ text: persona, sgr: "36" });
  const five = rateLimit(p, "five_hour");
  const seven = rateLimit(p, "seven_day");
  const limits = [five !== undefined ? `5h ${Math.round(five)}%` : "", seven !== undefined ? `7d ${Math.round(seven)}%` : ""].filter(Boolean);
  if (limits.length > 0) segs.push({ text: limits.join(" "), sgr: tone(Math.max(five ?? 0, seven ?? 0)) });
  const branch = cleanText(o.branch);
  if (branch) segs.push({ text: branch, sgr: "37" });
  if (o.tps !== undefined && Number.isFinite(o.tps) && o.tps > 0) {
    segs.push({ text: `${o.tps >= 10 ? Math.round(o.tps) : o.tps.toFixed(1)} tok/s`, sgr: "2" });
  }
  return segs;
}

/** One line, never wider than `cols`: lowest-priority segments (rightmost) are dropped first. */
export function renderStatusline(payload: unknown, o: RenderOptions): string {
  let segs = buildSegments(payload, o);
  if (segs.length === 0) return FALLBACK_LINE;
  const cols = Number.isFinite(o.cols) && o.cols > 0 ? Math.floor(o.cols) : 80;
  const width = (s: Segment[]): number => [...s.map((x) => x.text).join(SEP)].length;
  while (segs.length > 1 && width(segs) > cols) segs = segs.slice(0, -1);
  if (width(segs) > cols) {
    const chars = [...segs[0]!.text];
    segs = [{ ...segs[0]!, text: cols > 1 ? chars.slice(0, cols - 1).join("") + "…" : chars.slice(0, cols).join("") }];
  }
  if (!o.color) return segs.map((s) => s.text).join(SEP);
  return segs.map((s) => `\u001b[${s.sgr}m${s.text}\u001b[0m`).join(`\u001b[2m${SEP}\u001b[0m`);
}
