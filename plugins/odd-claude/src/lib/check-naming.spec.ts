import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

// Forbidden words are assembled at runtime so this file passes its own check.
const G = "gen" + "tle";
const T = "tele" + "metry";

const script = new URL("../../scripts/check-naming.mjs", import.meta.url).pathname;

function run(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "odd-naming-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
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

test("plugin-namespaced agent or skill reference fails in shipped content", () => {
  const r = run({ "skills/a.md": "Use odd-claude:odd-worker for edits.\n" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /skills\/a\.md:1: plugin-namespaced agent\/skill reference/);
  assert.equal(run({ "README.md": "Use /odd-claude:status.\n" }).status, 1);
  assert.equal(run({ "support/a.md": "See /odd-claude:work-unit-commits.\n" }).status, 1);
});

test("plugin-namespaced MCP tool name fails in shipped content", () => {
  const r = run({ "agents/a.md": "tools: mcp__plugin_odd-claude_review__review_status\n" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plugin-namespaced MCP tool name/);
});

test("global names pass, an attributed reference is allowed, and runtime dirs are not scoped", () => {
  assert.equal(run({ "skills/a.md": "Use odd-worker, /odd-status and mcp__odd-review__review_status. odd-claude: plain prose.\n" }).status, 0);
  assert.equal(run({ "skills/a.md": "legacy odd-claude:delta <!-- odd-check: allow -->\n" }).status, 0);
  assert.equal(run({ "src/a.ts": "const w = 'odd-claude:odd-worker';\n" }).status, 0);
});
