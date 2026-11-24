import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

test("skill odd: completion gate section with claim table and red flags", () => {
  const s = read("skills/odd/SKILL.md");
  assert.match(s, /^## Completion gate$/m);
  assert.match(s, /\| Claim \| Requires \| Not enough \|/);
  assert.match(s, /seen fail.*then pass/);
  assert.match(s, /check the diff, not the report/);
  assert.match(s, /Red flags/);
});

test("odd-worker: test-first excuse table and rewrite-from-test rule", () => {
  const s = read("agents/odd-worker.md");
  assert.match(s, /\| Excuse \| Answer \|/);
  assert.match(s, /rewritten from the test/);
});

test("odd-worker: never weaken the bar to reach green", () => {
  const s = read("agents/odd-worker.md");
  assert.match(s, /Never weaken the bar to reach green/);
  for (const t of ["@ts-ignore", "eslint-disable", ".skip", ".only"]) assert.ok(s.includes(t), t);
  assert.match(s, /return `partial`/);
});

test("test-first support points to the worker table instead of duplicating it", () => {
  const s = read("support/test-first.md");
  assert.match(s, /odd-worker/);
  assert.doesNotMatch(s, /\| Excuse \| Answer \|/);
});

test("odd-verify: a success claim is not evidence, weakening is a blocker", () => {
  const s = read("agents/odd-verify.md");
  assert.match(s, /success claims, conclusions or summary are not evidence/);
  assert.match(s, /weaken(s|ing)? .*not authorized by the spec.*blocker/i);
});

test("verification card: verify handoff carries artifact and contract, never the writer's claim", () => {
  const s = read("cards/verification.md");
  assert.match(s, /artifact/);
  assert.match(s, /never the writer's conclusions, success claims or summary/);
});

test("card sources: technique sources table with MIT attribution", () => {
  const s = read("cards/SOURCES.md");
  assert.match(s, /Technique sources/);
  assert.match(s, /Copyright \(c\) 2025 Jesse Vincent/);
  assert.match(s, /Copyright \(c\) 2025 Addy Osmani/);
});

test("output style stays unchanged: no new always-loaded sections", () => {
  const s = read("output-styles/odd.md");
  assert.doesNotMatch(s, /Completion gate/);
  assert.doesNotMatch(s, /\| Excuse \| Answer \|/);
  assert.doesNotMatch(s, /Never weaken the bar/);
});

test("odd-verify: claim-free line does not override reuse of observed writer checks", () => {
  const s = read("agents/odd-verify.md");
  assert.match(s, /Reuse observed writer checks/);
  assert.doesNotMatch(s, /verdict comes only from the artifact against the contract and your observed probes\./);
}); // S3(c), B1

test("completion gate keeps the passive-change readback exception", () => {
  assert.match(read("skills/odd/SKILL.md"), /readback/);
}); // S3(a), A2
