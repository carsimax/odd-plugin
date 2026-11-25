#!/usr/bin/env node
// Self-check for the eval tasks. For every task:
//   1. shipped repo/ + hidden/ must FAIL the grade command (and pass its own visible tests);
//   2. repo/ + the reference overlay from _reference/<id>/ + hidden/ must PASS visible tests and grade.
// Usage: node bench/eval-tasks/selfcheck.mjs [taskId ...]
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const ids = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_") && existsSync(join(root, d.name, "task.json")))
  .map((d) => d.name)
  .filter((id) => only.length === 0 || only.includes(id))
  .sort();

const temps = [];
function workspace(id, { reference }) {
  const dir = mkdtempSync(join(tmpdir(), `eval-selfcheck-${id}-`));
  temps.push(dir);
  cpSync(join(root, id, "repo"), dir, { recursive: true });
  if (reference) cpSync(join(root, "_reference", id), dir, { recursive: true });
  cpSync(join(root, id, "hidden"), join(dir, "hidden"), { recursive: true });
  return dir;
}
function sh(cwd, command) {
  return spawnSync("sh", ["-c", command], { cwd, encoding: "utf8", timeout: 120_000 }).status;
}

const rows = [];
try {
  for (const id of ids) {
    const task = JSON.parse(readFileSync(join(root, id, "task.json"), "utf8"));
    const problems = [];
    for (const f of ["id", "kind", "size", "prompt", "grade", "timeout_s"]) if (task[f] === undefined) problems.push(`task.json missing ${f}`);
    if (task.id !== id) problems.push("task.json id differs from directory");

    const shipped = workspace(id, { reference: false });
    const shippedVisible = sh(shipped, "npm test --silent");
    const shippedGrade = sh(shipped, task.grade);
    if (shippedVisible !== 0) problems.push("shipped visible tests do not pass");
    if (shippedGrade === 0) problems.push("shipped repo passes hidden tests");

    let refVisible = "n/a";
    let refGrade = "n/a";
    if (existsSync(join(root, "_reference", id))) {
      const ref = workspace(id, { reference: true });
      refVisible = sh(ref, "npm test --silent") === 0 ? "PASS" : "FAIL";
      refGrade = sh(ref, task.grade) === 0 ? "PASS" : "FAIL";
      if (refVisible !== "PASS") problems.push("reference fails visible tests");
      if (refGrade !== "PASS") problems.push("reference fails hidden tests");
    } else {
      problems.push("no reference solution");
    }
    rows.push({
      id,
      kind: task.kind,
      size: task.size,
      shippedVisible: shippedVisible === 0 ? "PASS" : "FAIL",
      shippedGrade: shippedGrade === 0 ? "PASS" : "FAIL",
      refVisible,
      refGrade,
      ok: problems.length === 0 ? "ok" : "MISMATCH",
      problems,
    });
  }
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

const head = ["task", "kind", "size", "shipped visible (want PASS)", "shipped hidden (want FAIL)", "ref visible (want PASS)", "ref hidden (want PASS)", "result"];
const table = [head, ...rows.map((r) => [r.id, r.kind, r.size, r.shippedVisible, r.shippedGrade, r.refVisible, r.refGrade, r.ok])];
const widths = head.map((_, i) => Math.max(...table.map((r) => r[i].length)));
for (const r of table) console.log(r.map((c, i) => c.padEnd(widths[i])).join("  "));
for (const r of rows) for (const p of r.problems) console.log(`  ${r.id}: ${p}`);
if (rows.length === 0 || rows.some((r) => r.problems.length > 0)) process.exit(1);
