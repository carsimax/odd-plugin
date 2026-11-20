// `npm run bench -- --subject odd|oracle|both --out <path> [--journey <id>]...`: runs the subject-neutral journeys against odd (real MCP
// server, hooks and CLI) and/or the upstream oracle binary and writes the result JSON. With `both` the two results are written side by
// side: `--out <dir>` gets `odd.json` and `oracle.json`; `--out <name>.json` gets `<name>.odd.json` and `<name>.oracle.json`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_SERVER_PATH, runJourney, type Subject as JourneySubject } from "./journey.js";
import { journeysFor } from "./journeys/index.js";
import { oddSubject } from "./subjects/odd.js";
import { captureOracleVersion, oracleAvailable, oracleBinaryPath, oracleSubject } from "./subjects/oracle.js";
import { buildResult } from "./report.js";
import { validateResult, type BenchResult } from "./schema.js";

export type SubjectChoice = "odd" | "oracle" | "both";
export interface Args { out?: string; only: string[]; subject: SubjectChoice; error?: string }

const USAGE = "usage: bench --out <results.json|dir> [--subject odd|oracle|both] [--journey <id>]...";

export function parse(argv: string[]): Args {
  const only: string[] = [];
  let out: string | undefined;
  let subject: SubjectChoice = "odd";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i];
    else if (a === "--journey") only.push(argv[++i] ?? "");
    else if (a === "--subject") {
      const v = argv[++i];
      if (v !== "odd" && v !== "oracle" && v !== "both") return { only, subject, error: `--subject must be odd, oracle or both (got ${String(v)})` };
      subject = v;
    } else return { only, subject, error: `unknown argument: ${a}` };
  }
  if (!out) return { only, subject, error: USAGE };
  return { out, only, subject };
}

/** Where each subject's result goes: the one file, or (with `both`) a pair next to each other. */
export function outputPaths(out: string, subject: SubjectChoice): Partial<Record<"odd" | "oracle", string>> {
  if (subject !== "both") return { [subject]: out };
  if (out.endsWith(".json")) return { odd: out.replace(/\.json$/, ".odd.json"), oracle: out.replace(/\.json$/, ".oracle.json") };
  return { odd: join(out, "odd.json"), oracle: join(out, "oracle.json") };
}

async function runSubject(subject: JourneySubject, only: string[]): Promise<{ result?: BenchResult; error?: string; failed: number }> {
  const all = journeysFor(subject);
  const selected = only.length ? all.filter((j) => only.includes(j.id)) : all;
  const missing = only.filter((id) => !all.some((j) => j.id === id));
  if (missing.length) return { error: `unknown journey: ${missing.join(", ")}`, failed: 0 };
  const rows = [];
  for (const j of selected) rows.push(await runJourney(j));
  let bin: { binaryPath: string; binaryVersion: string; commit: string };
  if (subject.name === "oracle") {
    bin = { binaryPath: oracleBinaryPath(), binaryVersion: await captureOracleVersion(), commit: "binary-only" };
  } else {
    const pluginDir = dirname(dirname(dirname(DEFAULT_SERVER_PATH)));
    const version = (JSON.parse(readFileSync(`${pluginDir}/package.json`, "utf8")) as { version: string }).version;
    bin = { binaryPath: DEFAULT_SERVER_PATH, binaryVersion: version, commit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: pluginDir, encoding: "utf8" }).stdout.trim() || "unknown" };
  }
  const result = buildResult(subject.name, rows, bin);
  const errs = validateResult(result);
  if (errs.length) return { error: `invalid ${subject.name} result: ${errs.join("; ")}`, failed: 0 };
  for (const r of rows) console.log(`${subject.name.padEnd(6)} ${r.status.padEnd(11)} ${r.id}${r.reason ? `  (${r.reason})` : ""}`);
  return { result, failed: result.aggregate.counts.failed };
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  if (args.error || !args.out) { console.error(args.error); return 2; }
  const wanted: JourneySubject[] = args.subject === "odd" ? [oddSubject] : args.subject === "oracle" ? [oracleSubject] : [oddSubject, oracleSubject];
  if (wanted.includes(oracleSubject) && !oracleAvailable()) { console.error(`oracle binary not found: ${oracleBinaryPath()} (set ODD_BENCH_ORACLE_BIN, or use --subject odd)`); return 2; }
  const paths = outputPaths(args.out, args.subject);
  let failed = 0;
  for (const subject of wanted) {
    const r = await runSubject(subject, args.only);
    if (r.error || !r.result) { console.error(r.error); return r.error?.startsWith("unknown journey") ? 2 : 3; }
    const file = paths[subject.name]!;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(r.result, null, 2) + "\n");
    failed += r.failed;
  }
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
