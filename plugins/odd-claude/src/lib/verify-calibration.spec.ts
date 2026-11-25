import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERIFY = "agents/odd-verify.md";
const read = (p: string): string => readFileSync(join(root, p), "utf8");

// A rule is pinned by a literal phrase that occurs exactly once in its file, so removing the rule breaks the test.
const pin = (file: string, phrases: string[]): void => {
  const s = read(file);
  for (const p of phrases) assert.equal(s.split(p).length - 1, 1, `${file}: exactly one "${p}"`);
};

test("odd-verify: calibration section sits between Evidence by change kind and Severity", () => {
  pin(VERIFY, ["## Calibration"]);
  const s = read(VERIFY);
  const at = (h: string): number => s.indexOf(h);
  assert.ok(at("## Evidence by change kind") < at("## Calibration"));
  assert.ok(at("## Calibration") < at("## Severity"));
});

test("odd-verify: skeptical default", () => {
  pin(VERIFY, ["an item is unmet until your own observed evidence shows it met"]);
});

test("odd-verify: five worked verdict examples", () => {
  pin(VERIFY, [
    "(a) The writer reports tests pass but the spec's example command was never run: unverified, which counts as unmet",
    "(b) The suite is green but the spec's exact error text differs from the observed output: unmet, a blocker",
    "(c) The behavior is already present at the baseline and the request did not ask to change it: a pre-existing advisory, not a blocker",
    "(d) A test was loosened or skipped to reach green without spec authorization: a blocker",
    "(e) Your observed output matches the spec example exactly: met",
  ]);
});

test("odd-verify: calibration section stays compact", () => {
  const s = read(VERIFY);
  const m = /^## Calibration\n([\s\S]*?)(?=^## )/m.exec(s);
  assert.ok(m, "Calibration section");
  assert.ok(Buffer.byteLength(m?.[1] ?? "") <= 1500, "section at most 1.5 KB");
});
