// `npm run bench -- --subject odd|oracle|both --out <path> [--journey <id>]...`: runs the subject-neutral journeys against odd (real MCP
// server, hooks and CLI) and/or the upstream oracle binary and writes the result JSON. With `both` the two results are written side by
// side: `--out <dir>` gets `odd.json`, `oracle.json`, `comparison.json` and `report.md`; `--out <name>.json` gets `<name>.odd.json`, `<name>.oracle.json`,
// `<name>.comparison.json` and `<name>.report.md`. `--repeat K` (default 3) runs each journey K times; `--compare <odd.json> <oracle.json> [--out]` rebuilds the report from saved results.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_PLUGIN_DIR, DEFAULT_SERVER_PATH, runJourney, type JourneyResultRow, type Subject as JourneySubject } from "./journey.js";
import { journeysFor } from "./journeys/index.js";
import { oddSubject } from "./subjects/odd.js";
import { captureOracleVersion, oracleAvailable, oracleBinaryPath, oracleSubject } from "./subjects/oracle.js";
import { aggregateRepeats, buildResult, renderReport } from "./report.js";
import { validateResult, type BenchResult } from "./schema.js";
import { compareResults, sameJson } from "./compare.js";
import { JOURNEY_DEFS } from "./journeys/index.js";
import { expectedProjection } from "./journey.js";
import { DIVERGENCES, oracleExpected } from "./subjects/oracle.js";

export type SubjectChoice = "odd" | "oracle" | "both";
export interface Args { out?: string; only: string[]; subject: SubjectChoice; repeat?: number; compare?: [string, string]; error?: string }

const USAGE = "usage: bench --out <results.json|dir> [--subject odd|oracle|both] [--journey <id>]... [--repeat K]\n       bench --compare <odd.json> <oracle.json> [--out <dir|name.json>]";
export const DEFAULT_REPEATS = 3;

export function parse(argv: string[]): Args {
  const only: string[] = [];
  let out: string | undefined;
  let subject: SubjectChoice = "odd";
  let repeat: number | undefined;
  let compare: [string, string] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i];
    else if (a === "--journey") only.push(argv[++i] ?? "");
    else if (a === "--subject") {
      const v = argv[++i];
      if (v !== "odd" && v !== "oracle" && v !== "both") return { only, subject, error: `--subject must be odd, oracle or both (got ${String(v)})` };
      subject = v;
    } else if (a === "--repeat") {
      const raw = argv[++i] ?? "";
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || n < 1 || n > 20) return { only, subject, error: `--repeat must be an integer from 1 to 20 (got ${raw})` };
      repeat = n;
    } else if (a === "--compare") {
      const x = argv[++i], y = argv[++i];
      if (!x || !y || x.startsWith("--") || y.startsWith("--")) return { only, subject, error: "--compare needs two files: --compare <odd.json> <oracle.json>" };
      compare = [x, y];
    } else return { only, subject, error: `unknown argument: ${a}` };
  }
  if (!out && !compare) return { only, subject, error: USAGE };
  return { ...(out !== undefined ? { out } : {}), only, subject, ...(repeat !== undefined ? { repeat } : {}), ...(compare ? { compare } : {}) };
}

/** A path under the home directory as `~/...`: recorded metadata names no user. */
export function tildePath(p: string): string {
  const home = homedir();
  return p === home ? "~" : p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p;
}

/** Where each subject's result goes: the one file, or (with `both`) a pair next to each other. */
export function outputPaths(out: string, subject: SubjectChoice): Partial<Record<"odd" | "oracle", string>> {
  if (subject !== "both") return { [subject]: out };
  if (out.endsWith(".json")) return { odd: out.replace(/\.json$/, ".odd.json"), oracle: out.replace(/\.json$/, ".oracle.json") };
  return { odd: join(out, "odd.json"), oracle: join(out, "oracle.json") };
}

/** Where the comparison goes: `<dir>/comparison.json` + `<dir>/report.md`, or next to a `<name>.json` as `<name>.comparison.json` / `<name>.report.md`. */
export function comparisonPaths(out: string): { comparison: string; report: string } {
  if (out.endsWith(".json")) return { comparison: out.replace(/\.json$/, ".comparison.json"), report: out.replace(/\.json$/, ".report.md") };
  return { comparison: join(out, "comparison.json"), report: join(out, "report.md") };
}

/**
 * Journey id to the declared reasons the oracle's expectation differs from the shared one: the divergences the oracle subject
 * declares, plus the product default RDD mode (on, where odd's is off) wherever a journey inspects it. Derived from the same
 * expectation functions the oracle runs with, so the list cannot drift from what the oracle row is checked against.
 */
export function declaredDivergences(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const def of JOURNEY_DEFS) {
    if (sameJson(oracleExpected(def), expectedProjection(def))) continue;
    const reasons = DIVERGENCES.filter((d) => d.journey === def.id).map((d) => `step ${d.step + 1}: ${d.comment}`);
    const own = new Set(DIVERGENCES.filter((d) => d.journey === def.id).map((d) => d.step));
    const steps = (oracleExpected(def) as { steps: unknown[] }).steps;
    const rdd = def.steps.some((s, i) => !own.has(i) && !sameJson(steps[i], { step: s.do.kind, ...s.expect }));
    if (rdd) reasons.push("product default RDD mode is on (odd: off)");
    out[def.id] = reasons;
  }
  return out;
}

function readResult(file: string): { result?: BenchResult; error?: string } {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { return { error: `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}` }; }
  const errs = validateResult(raw);
  if (errs.length) return { error: `invalid result ${file}: ${errs.slice(0, 5).join("; ")}` };
  return { result: raw as BenchResult };
}

/** Rebuilds the comparison from two saved results (no journey runs). Writes comparison.json and report.md only when `out` is given and the inputs are valid. */
export function runCompare(oddFile: string, oracleFile: string, out?: string): { code: number; report: string; error?: string } {
  const o = readResult(oddFile), r = readResult(oracleFile);
  const error = o.error ?? r.error ?? (o.result!.meta.subject !== "odd" ? `expected the odd result first, but ${oddFile} is the ${o.result!.meta.subject} result` : r.result!.meta.subject !== "oracle" ? `expected the oracle result second, but ${oracleFile} is the ${r.result!.meta.subject} result` : undefined);
  if (error !== undefined) return { code: 2, report: "", error };
  const comparison = compareResults(o.result!, r.result!);
  const report = renderReport(comparison);
  if (out !== undefined) {
    const p = comparisonPaths(out);
    mkdirSync(dirname(p.comparison), { recursive: true });
    writeFileSync(p.comparison, JSON.stringify(comparison, null, 2) + "\n");
    writeFileSync(p.report, report);
  }
  return { code: 0, report };
}

async function runSubject(subject: JourneySubject, only: string[], repeat: number): Promise<{ result?: BenchResult; error?: string; failed: number }> {
  const all = journeysFor(subject);
  const selected = only.length ? all.filter((j) => only.includes(j.id)) : all;
  const missing = only.filter((id) => !all.some((j) => j.id === id));
  if (missing.length) return { error: `unknown journey: ${missing.join(", ")}`, failed: 0 };
  const rows: JourneyResultRow[] = [];
  const divergences = subject.name === "oracle" ? declaredDivergences() : {};
  for (const j of selected) {
    // Fresh sandbox and fresh processes for every repeat; unsupported journeys do not run, so once is enough.
    const runs: JourneyResultRow[] = [];
    for (let k = 0; k < (j.unsupported !== undefined ? 1 : repeat); k++) runs.push(await runJourney(j));
    const row = aggregateRepeats(runs);
    rows.push(divergences[j.id] ? { ...row, divergence: divergences[j.id]! } : row);
  }
  let bin: { binaryPath: string; binaryVersion: string; commit: string };
  if (subject.name === "oracle") {
    bin = { binaryPath: tildePath(oracleBinaryPath()), binaryVersion: await captureOracleVersion(), commit: "binary-only" };
  } else {
    const version = (JSON.parse(readFileSync(join(DEFAULT_PLUGIN_DIR, "package.json"), "utf8")) as { version: string }).version;
    bin = { binaryPath: tildePath(DEFAULT_SERVER_PATH), binaryVersion: version, commit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: DEFAULT_PLUGIN_DIR, encoding: "utf8" }).stdout.trim() || "unknown" };
  }
  const result = buildResult(subject.name, rows, { ...bin, repeats: repeat });
  const errs = validateResult(result);
  if (errs.length) return { error: `invalid ${subject.name} result: ${errs.join("; ")}`, failed: 0 };
  for (const r of rows) console.log(`${subject.name.padEnd(6)} ${r.status.padEnd(11)} ${r.id}${r.reason ? `  (${r.reason})` : ""}`);
  return { result, failed: result.aggregate.counts.failed };
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  if (args.error) { console.error(args.error); return 2; }
  if (args.compare) {
    const res = runCompare(args.compare[0], args.compare[1], args.out);
    if (res.error) { console.error(res.error); return res.code; }
    if (args.out === undefined) console.log(res.report); else console.log(`wrote ${comparisonPaths(args.out).comparison} and ${comparisonPaths(args.out).report}`);
    return 0;
  }
  if (!args.out) { console.error(USAGE); return 2; }
  const wanted: JourneySubject[] = args.subject === "odd" ? [oddSubject] : args.subject === "oracle" ? [oracleSubject] : [oddSubject, oracleSubject];
  if (wanted.includes(oracleSubject) && !oracleAvailable()) { console.error(`oracle binary not found: ${oracleBinaryPath()} (set ODD_BENCH_ORACLE_BIN, or use --subject odd)`); return 2; }
  const paths = outputPaths(args.out, args.subject);
  let failed = 0;
  const results: Partial<Record<"odd" | "oracle", BenchResult>> = {};
  for (const subject of wanted) {
    const r = await runSubject(subject, args.only, args.repeat ?? DEFAULT_REPEATS);
    if (r.error || !r.result) { console.error(r.error); return r.error?.startsWith("unknown journey") ? 2 : 3; }
    const file = paths[subject.name]!;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(r.result, null, 2) + "\n");
    failed += r.failed;
    results[subject.name] = r.result;
  }
  if (results.odd && results.oracle && args.subject === "both") {
    const p = comparisonPaths(args.out);
    const comparison = compareResults(results.odd, results.oracle);
    writeFileSync(p.comparison, JSON.stringify(comparison, null, 2) + "\n");
    writeFileSync(p.report, renderReport(comparison));
    console.log(`wrote ${p.comparison} and ${p.report}`);
  }
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
