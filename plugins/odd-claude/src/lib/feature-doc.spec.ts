import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeFeatureDocSummary, FEATURE_DOC_SUMMARY_CAP } from "./feature-doc.js";

const DOC = (branch: string, extra = "") => `# Feature X
Goal: do it. Branch: \`${branch}\`.

## Specs

- **S1** first
- **S2** second

## Tasks

- T0 | S1 | worker | done — finished work
- T1 | S2 | worker | pending — open work
${extra}
## Log
- L1: first entry
- L2: last entry
`;

function repo(files: Record<string, string>): { root: string; exec: (c: string, a: string[]) => string | undefined; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "odd-fdoc-"));
  mkdirSync(join(root, "odd", "tasks"), { recursive: true });
  for (const [n, t] of Object.entries(files)) writeFileSync(join(root, "odd", "tasks", n), t);
  const exec = (_c: string, a: string[]): string | undefined => (a.includes("--show-toplevel") ? root : "feat/x");
  return { root, exec, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("matches the document by branch and summarizes path, header, spec ids, open tasks and the last log entry", () => {
  const r = repo({ "a.md": DOC("feat/other"), "b.md": DOC("feat/x") });
  try {
    const s = activeFeatureDocSummary(r.root, r.exec)!;
    assert.match(s, /odd\/tasks\/b\.md/);
    assert.match(s, /Header: # Feature X/);
    assert.match(s, /Specs: S1, S2/);
    assert.match(s, /T1 \| S2 \| worker \| pending/);
    assert.match(s, /Last log entry: - L2: last entry/);
    assert.doesNotMatch(s, /a\.md/);
  } finally {
    r.done();
  }
});

test("done tasks are excluded", () => {
  const r = repo({ "b.md": DOC("feat/x") });
  try {
    assert.doesNotMatch(activeFeatureDocSummary(r.root, r.exec)!, /T0/);
  } finally {
    r.done();
  }
});

test("no matching branch, no git and a missing odd/tasks dir add nothing", () => {
  const r = repo({ "a.md": DOC("feat/other") });
  try {
    assert.equal(activeFeatureDocSummary(r.root, r.exec), undefined);
    assert.equal(activeFeatureDocSummary(r.root, () => undefined), undefined);
    assert.equal(activeFeatureDocSummary(r.root, (_c, a) => (a.includes("--show-toplevel") ? join(r.root, "nope") : "feat/x")), undefined);
  } finally {
    r.done();
  }
});

test("the summary is hard-capped", () => {
  const many = Array.from({ length: 80 }, (_, i) => `- T${i + 10} | S1 | worker | pending — ${"x".repeat(150)}`).join("\n");
  const r = repo({ "b.md": DOC("feat/x", many) });
  try {
    const s = activeFeatureDocSummary(r.root, r.exec)!;
    assert.ok(s.length <= FEATURE_DOC_SUMMARY_CAP);
    assert.ok(s.length > FEATURE_DOC_SUMMARY_CAP - 10);
  } finally {
    r.done();
  }
});
