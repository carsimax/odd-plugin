// Versioned result format of the bench (`odd-claude.bench-result/v1`) and its structural validator.
import { BLOCK_CLASSES, DIMENSION_NAMES, type MetricSet } from "./metrics.js";

export const RESULT_SCHEMA_ID = "odd-claude.bench-result/v1";
export type Subject = "odd" | "oracle";
export type JourneyStatus = "passed" | "failed" | "unsupported";
/** Normalized outcome projection: outcome, state, gate decision, block class, counts. Never raw bytes or hashes. */
export type Projection = Record<string, unknown>;

export interface RunMeta {
  subject: Subject;
  binary: { path: string; version: string };
  node: string;
  os: { platform: string; arch: string; release: string };
  commit: string;
  started_at: string;
}

export interface JourneyRow {
  id: string;
  status: JourneyStatus;
  outcome: Projection | null;
  metrics: MetricSet | null;
  reason?: string;
}

export interface BenchResult {
  schema: typeof RESULT_SCHEMA_ID;
  meta: RunMeta;
  journeys: JourneyRow[];
  aggregate: { counts: Record<JourneyStatus, number>; metrics: MetricSet | null };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const DERIVATIONS = ["measured", "proxy", "unobservable"];

function checkMetrics(m: unknown, at: string, errs: string[]): void {
  if (!isObj(m)) return void errs.push(`${at}: expected an object`);
  for (const name of DIMENSION_NAMES) {
    const d = m[name];
    if (!isObj(d)) { errs.push(`${at}.${name}: expected a dimension object`); continue; }
    if (!DERIVATIONS.includes(d.derivation as string)) { errs.push(`${at}.${name}: derivation must be one of ${DERIVATIONS.join("|")}`); continue; }
    const unobs = d.derivation === "unobservable";
    if (unobs && d.value !== null) errs.push(`${at}.${name}: unobservable value must be null`);
    if (!unobs && !(typeof d.value === "number" && Number.isFinite(d.value))) errs.push(`${at}.${name}: ${String(d.derivation)} value must be a finite number`);
  }
  const b = m.blocks;
  if (!isObj(b) || !DERIVATIONS.includes(b.derivation as string)) errs.push(`${at}.blocks: expected {value,derivation}`);
  else if (b.derivation === "unobservable" ? b.value !== null : !isObj(b.value) || !BLOCK_CLASSES.every((c) => Number.isInteger((b.value as Record<string, unknown>)[c]))) {
    errs.push(`${at}.blocks: value must be null when unobservable, else counts for ${BLOCK_CLASSES.join(",")}`);
  }
  if (!isObj(m.latency)) return void errs.push(`${at}.latency: expected an object`);
  for (const [op, s] of Object.entries(m.latency)) {
    for (const k of ["samples", "median_ms", "p95_ms"]) if (!isObj(s) || typeof s[k] !== "number" || !Number.isFinite(s[k])) errs.push(`${at}.latency.${op}.${k}: expected a finite number`);
  }
}

/** Returns a list of `path: message` problems; empty means valid. */
export function validateResult(x: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(x)) return ["result: expected an object"];
  if (x.schema !== RESULT_SCHEMA_ID) errs.push(`schema: expected ${RESULT_SCHEMA_ID}`);
  const meta = x.meta;
  if (!isObj(meta)) errs.push("meta: expected an object");
  else {
    if (meta.subject !== "odd" && meta.subject !== "oracle") errs.push("meta.subject: expected odd|oracle");
    for (const k of ["node", "commit", "started_at"]) if (typeof meta[k] !== "string" || meta[k] === "") errs.push(`meta.${k}: expected a non-empty string`);
    const bin = meta.binary;
    if (!isObj(bin) || typeof bin.path !== "string" || typeof bin.version !== "string") errs.push("meta.binary: expected {path,version}");
    const os = meta.os;
    if (!isObj(os) || typeof os.platform !== "string" || typeof os.arch !== "string" || typeof os.release !== "string") errs.push("meta.os: expected {platform,arch,release}");
  }
  const counts: Record<string, number> = { passed: 0, failed: 0, unsupported: 0 };
  if (!Array.isArray(x.journeys)) errs.push("journeys: expected an array");
  else {
    const ids = new Set<string>();
    x.journeys.forEach((row: unknown, i: number) => {
      const at = `journeys[${i}]`;
      if (!isObj(row)) return void errs.push(`${at}: expected an object`);
      if (typeof row.id !== "string" || row.id === "") errs.push(`${at}.id: expected a non-empty string`);
      else if (ids.has(row.id)) errs.push(`${at}.id: duplicate ${row.id}`);
      else ids.add(row.id);
      const st = row.status;
      if (st !== "passed" && st !== "failed" && st !== "unsupported") return void errs.push(`${at}.status: expected passed|failed|unsupported`);
      counts[st] = (counts[st] ?? 0) + 1;
      if (st === "unsupported") {
        if (typeof row.reason !== "string" || row.reason === "") errs.push(`${at}.reason: required for unsupported rows`);
        if (row.metrics !== null) errs.push(`${at}.metrics: must be null for unsupported rows`);
        if (row.outcome !== null) errs.push(`${at}.outcome: must be null for unsupported rows`);
      } else {
        if (!isObj(row.outcome)) errs.push(`${at}.outcome: expected an object`);
        if (row.metrics === null || row.metrics === undefined) errs.push(`${at}.metrics: required for ${st} rows`);
        else checkMetrics(row.metrics, `${at}.metrics`, errs);
      }
    });
  }
  const agg = x.aggregate;
  if (!isObj(agg)) errs.push("aggregate: expected an object");
  else {
    const c = agg.counts;
    if (!isObj(c) || ["passed", "failed", "unsupported"].some((k) => c[k] !== counts[k])) errs.push("aggregate.counts: must equal the journey status counts");
    if (agg.metrics !== null) checkMetrics(agg.metrics, "aggregate.metrics", errs);
  }
  return errs;
}
