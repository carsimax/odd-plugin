import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Forbidden words are assembled at runtime so this file passes its own check.
const G = "gen" + "tle";
const T = "tele" + "metry";

const script = new URL("../../scripts/check-naming.mjs", import.meta.url).pathname;

function run(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "odd-naming-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("clean tree passes", () => {
  const r = run({ "a.ts": "export const odd = 1;\n" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /check-naming: ok/);
});

test("prefix identifier fails", () => {
  const r = run({ "a.ts": `const x = '${G}-foo';\n` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a\.ts:1: .* identifier/);
});

test("upper-case prefix identifier fails", () => {
  assert.equal(run({ "a.ts": `process.env.${G.toUpperCase()}_X\n` }).status, 1);
});

test("tracking-word marker fails", () => {
  const r = run({ "a.ts": `send${T}();\n` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, / marker/);
});

test("attributed notice is allowed", () => {
  const r = run({
    "a.ts": `// ported from ${G}-shell odd-check: allow\n`,
    NOTICE: `Based on ${G}-shell (MIT)\n`,
  });
  assert.equal(r.status, 0);
});
