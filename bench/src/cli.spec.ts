import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { comparisonPaths, declaredDivergences, parse, runCompare, tildePath } from "./cli.js";
import { COMPARISON_SCHEMA_ID } from "./compare.js";
import { emptyMetricSet, measured } from "./metrics.js";
import { RESULT_SCHEMA_ID, type BenchResult, type JourneyRow } from "./schema.js";

test("parse: --repeat and --compare, with the previous shape untouched when absent", () => {
  assert.deepEqual(parse(["--out", "r.json"]), { out: "r.json", only: [], subject: "odd" });
  assert.equal(parse(["--out", "d", "--repeat", "5"]).repeat, 5);
  for (const bad of ["0", "x", "1.5", "99", ""]) assert.match(parse(["--out", "d", "--repeat", bad]).error ?? "", /--repeat must be an integer from 1 to 20/);
  assert.deepEqual(parse(["--compare", "a.json", "b.json"]).compare, ["a.json", "b.json"]);
  assert.equal(parse(["--compare", "a.json", "b.json"]).error, undefined);
  assert.equal(parse(["--compare", "a.json", "b.json", "--out", "d"]).out, "d");
  assert.match(parse(["--compare", "a.json"]).error ?? "", /--compare needs two files/);
  assert.match(parse(["--subject", "both"]).error ?? "", /usage: bench --out/);
});

test("comparisonPaths: a directory or <name>.json", () => {
  assert.deepEqual(comparisonPaths("/t/out"), { comparison: "/t/out/comparison.json", report: "/t/out/report.md" });
  assert.deepEqual(comparisonPaths("/t/r.json"), { comparison: "/t/r.comparison.json", report: "/t/r.report.md" });
});

test("declaredDivergences lists the oracle's declared divergences and the RDD default, by journey id", () => {
  const d = declaredDivergences();
  assert.ok(d["consent-declined-creates-no-review"]!.some((t) => /decline persists nothing/.test(t)));
  assert.ok(d["duplicate-start-guard-during-correction"]);
  assert.ok(d["binding-drift-mid-run"]);
  const rdd = Object.entries(d).filter(([, v]) => v.some((t) => /RDD/.test(t)));
  assert.ok(rdd.length >= 1, "a journey that inspects the RDD default diverges");
  assert.equal(d["push-denied-unreviewed-high-risk"], undefined);
});

function fixture(subject: "odd" | "oracle", rows: JourneyRow[]): BenchResult {
  return { schema: RESULT_SCHEMA_ID, meta: { subject, binary: { path: "x", version: "1" }, node: "v22", os: { platform: "p", arch: "a", release: "r" }, commit: "c", started_at: "t", repeats: 1 }, journeys: rows, aggregate: { counts: { passed: rows.length, failed: 0, unsupported: 0 }, metrics: null } };
}
const row = (id: string, prompts: number): JourneyRow => { const m = emptyMetricSet(); m.human_prompts = measured(prompts); return { id, status: "passed", outcome: { ok: 1 }, metrics: m }; };

test("--compare rebuilds comparison.json and report.md from saved results without running anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-bench-cli-"));
  const o = join(dir, "odd.json"), r = join(dir, "oracle.json"), out = join(dir, "out");
  writeFileSync(o, JSON.stringify(fixture("odd", [row("a", 1), row("b", 2)])));
  writeFileSync(r, JSON.stringify(fixture("oracle", [row("a", 1), row("b", 1)])));
  const res = runCompare(o, r, out);
  assert.equal(res.code, 0);
  const cmp = JSON.parse(readFileSync(join(out, "comparison.json"), "utf8"));
  assert.equal(cmp.schema, COMPARISON_SCHEMA_ID);
  assert.equal(cmp.journeys.find((j: { id: string }) => j.id === "b").metrics.human_prompts.verdict, "worse");
  const md = readFileSync(join(out, "report.md"), "utf8");
  assert.match(md, /## Efficiency verdict/);
  assert.equal(md, res.report);
  // no --out: nothing is written, the report is returned
  const dry = runCompare(o, r);
  assert.equal(dry.code, 0);
  assert.match(dry.report, /# Efficiency report/);
});

test("--compare rejects unreadable, invalid or swapped inputs with exit 2 and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-bench-cli-"));
  const o = join(dir, "odd.json"), r = join(dir, "oracle.json"), bad = join(dir, "bad.json"), out = join(dir, "out");
  writeFileSync(o, JSON.stringify(fixture("odd", [row("a", 1)])));
  writeFileSync(r, JSON.stringify(fixture("oracle", [row("a", 1)])));
  writeFileSync(bad, JSON.stringify({ schema: "nope" }));
  const missing = runCompare(join(dir, "nope.json"), r, out);
  assert.equal(missing.code, 2); assert.match(missing.error ?? "", /cannot read/);
  const invalid = runCompare(bad, r, out);
  assert.equal(invalid.code, 2); assert.match(invalid.error ?? "", /invalid result/);
  const swapped = runCompare(r, o, out);
  assert.equal(swapped.code, 2); assert.match(swapped.error ?? "", /expected the odd result first/);
  assert.equal(existsSync(out), false);
});

test("tildePath shows a path under the home directory as ~/..., so recorded metadata names no user", () => {
  assert.equal(tildePath(join(homedir(), ".local/share/x")), "~/.local/share/x");
  assert.equal(tildePath(homedir()), "~");
  assert.equal(tildePath("/opt/other/bin"), "/opt/other/bin");
  assert.equal(tildePath(`${homedir()}-sibling/x`), `${homedir()}-sibling/x`, "a sibling directory with the same prefix is not under home");
});

test("test:bench lists spec files through the shell, not a quoted glob (node --test needs Node 21+ for that)", () => {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")) as { scripts: Record<string, string>; engines: { node: string } };
  assert.match(pkg.scripts["test:bench"]!, /node --test bench\/dist\/\*\.spec\.js bench\/dist\/\*\/\*\.spec\.js/);
  assert.doesNotMatch(pkg.scripts["test:bench"]!, /["']bench\/dist/);
  assert.equal(pkg.engines.node, ">=20");
});
