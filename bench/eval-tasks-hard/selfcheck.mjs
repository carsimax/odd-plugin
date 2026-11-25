#!/usr/bin/env node
// Self-check for the hard eval tasks. For every task (repo/ + hidden/ copied to a temp dir):
//   shipped   : visible tests PASS, acceptance FAIL;
//   reference : (repo/ + _reference/<id>/) visible, acceptance, regression and the full grade command all PASS;
//   naive     : (repo/ + _naive/<id>/) acceptance PASS and regression FAIL (it falls into the trap).
// Prints one line per task, then the names of the regression tests the naive overlay fails.
// Usage: node bench/eval-tasks-hard/selfcheck.mjs [taskId ...]
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const DIFFICULTIES = ["regression-trap", "precise-spec", "multi-step"];
const KINDS = ["bugfix", "feature", "refactor"];
const ids = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_") && existsSync(join(root, d.name, "task.json")))
  .map((d) => d.name)
  .filter((id) => only.length === 0 || only.includes(id))
  .sort();

const temps = [];
function workspace(id, overlay) {
  const dir = mkdtempSync(join(tmpdir(), `eval-hard-selfcheck-${id}-`));
  temps.push(dir);
  cpSync(join(root, id, "repo"), dir, { recursive: true });
  if (overlay) cpSync(join(root, overlay, id), dir, { recursive: true });
  cpSync(join(root, id, "hidden"), join(dir, "hidden"), { recursive: true });
  return dir;
}
function run(cwd, command) {
  return spawnSync("sh", ["-c", command], { cwd, encoding: "utf8", timeout: 180_000 });
}
const passes = (cwd, command) => run(cwd, command).status === 0;
const word = (ok) => (ok ? "PASS" : "FAIL");
function failingNames(cwd, command) {
  const out = run(cwd, command.replace("node --test", "node --test --test-reporter=tap")).stdout ?? "";
  return [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
}

const rows = [];
try {
  for (const id of ids) {
    const task = JSON.parse(readFileSync(join(root, id, "task.json"), "utf8"));
    const problems = [];
    for (const f of ["id", "kind", "size", "difficulty", "prompt", "grade", "checks", "timeout_s"]) if (task[f] === undefined) problems.push(`task.json missing ${f}`);
    if (task.id !== id) problems.push("task.json id differs from directory");
    if (task.size !== "large") problems.push("size must be large");
    if (!DIFFICULTIES.includes(task.difficulty)) problems.push("unknown difficulty");
    if (!KINDS.includes(task.kind)) problems.push("unknown kind");
    if (!task.checks?.acceptance || !task.checks?.regression) problems.push("checks need acceptance and regression");
    for (const dir of ["acceptance", "regression"]) if (!existsSync(join(root, id, "hidden", dir))) problems.push(`hidden/${dir} missing`);
    for (const overlay of ["_reference", "_naive"]) if (!existsSync(join(root, overlay, id))) problems.push(`${overlay}/${id} missing`);
    if (problems.length > 0) {
      rows.push({ id, difficulty: task.difficulty, line: "", problems, names: [] });
      continue;
    }
    const { acceptance, regression } = task.checks;

    const shipped = workspace(id, null);
    const shippedVisible = passes(shipped, "npm test --silent");
    const shippedAcc = passes(shipped, acceptance);
    if (!shippedVisible) problems.push("shipped visible tests do not pass");
    if (shippedAcc) problems.push("shipped repo passes acceptance");

    const ref = workspace(id, "_reference");
    const refVisible = passes(ref, "npm test --silent");
    const refAcc = passes(ref, acceptance);
    const refReg = passes(ref, regression);
    const refGrade = passes(ref, task.grade);
    if (!refVisible) problems.push("reference fails visible tests");
    if (!refAcc) problems.push("reference fails acceptance");
    if (!refReg) problems.push("reference fails regression");
    if (!refGrade) problems.push("reference fails the grade command");

    const naive = workspace(id, "_naive");
    const naiveAcc = passes(naive, acceptance);
    const naiveReg = passes(naive, regression);
    if (!naiveAcc) problems.push("naive fails acceptance (task too contrived)");
    if (naiveReg) problems.push("naive passes regression (trap does not trip)");
    const names = naiveReg ? [] : failingNames(naive, regression);

    rows.push({
      id,
      difficulty: task.difficulty,
      line:
        `shipped[visible ${word(shippedVisible)} acc ${word(shippedAcc)}] ` +
        `ref[visible ${word(refVisible)} acc ${word(refAcc)} reg ${word(refReg)}] ` +
        `naive[acc ${word(naiveAcc)} reg ${word(naiveReg)}]`,
      problems,
      names,
    });
  }
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

const w = Math.max(0, ...rows.map((r) => r.id.length));
const wd = Math.max(0, ...rows.map((r) => String(r.difficulty).length));
for (const r of rows) console.log(`${r.id.padEnd(w)}  ${String(r.difficulty).padEnd(wd)}  ${r.line}  ${r.problems.length === 0 ? "ok" : "MISMATCH"}`);
for (const r of rows) {
  for (const p of r.problems) console.log(`  ${r.id}: ${p}`);
  for (const n of r.names) console.log(`  ${r.id}: naive fails regression: ${n}`);
}
if (rows.length === 0 || rows.some((r) => r.problems.length > 0)) process.exit(1);
