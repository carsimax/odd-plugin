import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

// A rule is pinned by a literal phrase that occurs exactly once in its file, so removing the rule breaks the test.
const pin = (file: string, phrases: string[]): void => {
  const s = read(file);
  for (const p of phrases) assert.equal(s.split(p).length - 1, 1, `${file}: exactly one "${p}"`);
};

const CREATOR = "skills/skill-creator/SKILL.md";
const IMPROVER = "skills/skill-improver/SKILL.md";
const REF = "skills/skill-creator/references/pressure-testing.md";
const TPL = "skills/skill-creator/assets/pressure-scenario.md";

test("pressure-testing reference and template exist", () => {
  assert.ok(existsSync(join(root, REF)));
  assert.ok(existsSync(join(root, TPL)));
});

test("reference: RED, GREEN, REFACTOR loop", () => {
  pin(REF, [
    "RED: run the scenario with a fresh subagent without the skill",
    "record its choice and its rationalizations word for word",
    "GREEN: write only the counters those observed failures need",
    "rerun the same scenario with the skill",
    "REFACTOR: give each new rationalization an explicit counter",
    "then retest until it holds",
  ]);
});

test("reference: pressure types", () => {
  const s = read(REF);
  for (const t of ["time", "sunk cost", "authority", "economic", "exhaustion", "social", "pragmatic"]) {
    assert.ok(s.includes(t), t);
  }
});

test("reference: scenario shape and pass/fail", () => {
  pin(REF, [
    "at least three stacked pressures",
    'forced A/B/C choice asked as "What do you do?"',
    "an action, not what the agent should do",
    "Pass: picks the compliant option, cites the skill, names the temptation",
    "Fail: a new rationalization, argues the skill is wrong, or picks a hybrid",
  ]);
});

test("reference: when it is required and when not", () => {
  pin(REF, [
    "Required for discipline skills",
    "Not needed for pure reference or technique-lookup skills",
    "Prohibitions only fix discipline failures",
    "changing the form (template, example, output contract), not by adding",
  ]);
});

test("template: skeleton and results block", () => {
  const s = read(TPL);
  for (const h of ["What do you do?", "A)", "B)", "C)", "Baseline choice", "Rationalizations (verbatim)", "With-skill choice", "Counters added", "Retest result"]) {
    assert.ok(s.includes(h), h);
  }
});

test("skill-creator: gate row, execution step, output contract, reference link", () => {
  pin(CREATOR, [
    "| Discipline skill (new or edited) | Run the RED baseline before writing and the GREEN/REFACTOR retest before reporting done |",
    "Pressure-test a discipline skill",
    "Pressure-test scenarios run and their results, or why testing did not apply",
    "(references/pressure-testing.md)",
    "(assets/pressure-scenario.md)",
  ]);
});

test("skill-improver: audit flag, before/after reruns, reference by skill name", () => {
  pin(IMPROVER, [
    "Flag a discipline skill with no pressure-test evidence",
    "rerun its scenarios before and after a change to a discipline rule and report both results",
    "pressure-testing reference of `/skill-creator`",
  ]);
});

test("both SKILL.md bodies stay within the 1000-token budget", () => {
  for (const f of [CREATOR, IMPROVER]) {
    const body = read(f).replace(/^---\n[\s\S]*?\n---\n/, "");
    assert.ok(body.length / 4 <= 1000, `${f} ~${Math.round(body.length / 4)} tokens`);
  }
});
