import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { peersCli } from "./peers.js";
import { allow } from "../lib/peer-grants.js";

const R = "rrrrrrrr-1111-4111-8111-rrrrrrrrrrrr";
const S = "ssssssss-2222-4222-8222-ssssssssssss";
const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "..", "..");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-pcli-"));
}
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      out.push(p);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

test("list shows this session's grants (read-only), closed by default", () => {
  const dir = tmp();
  try {
    const none = peersCli(["list", "--session", R, "--data-dir", dir], {});
    assert.equal(none.exitCode, 0);
    assert.match(none.stdout, /accepts messages from nobody/);
    allow(R, S, { dataDir: dir });
    const some = peersCli(["status", "--session", R, "--data-dir", dir], {});
    assert.equal(some.exitCode, 0);
    assert.ok(some.stdout.includes(S));
    assert.equal(peersCli(["list", "--session", "../x", "--data-dir", dir], {}).exitCode, 0);
    assert.equal(peersCli(["list"], {}).exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI has no write path: allow/revoke/anything else fail without touching the data dir", () => {
  const dir = tmp();
  try {
    allow(R, S, { dataDir: dir });
    const before = tree(dir);
    const contents = readFileSync(join(dir, "peers", ".grants", `${R}.json`), "utf8");
    for (const argv of [
      ["allow", S, "--session", R, "--data-dir", dir],
      ["revoke", S, "--session", R, "--data-dir", dir],
      ["revoke", "--all", "--session", R, "--data-dir", dir],
      ["grant", S, "--session", R, "--data-dir", dir],
      ["--session", R, "--data-dir", dir, "allow", S],
    ]) {
      const r = peersCli(argv, {});
      assert.notEqual(r.exitCode, 0, argv.join(" "));
      assert.match(r.stdout, /cannot grant|read-only|human/i);
    }
    assert.deepEqual(tree(dir), before);
    assert.equal(readFileSync(join(dir, "peers", ".grants", `${R}.json`), "utf8"), contents);
    // the same through the real process (the shipped dist file)
    const fresh = tmp();
    try {
      const p = spawnSync(process.execPath, [join(pluginRoot, "dist", "cli", "peers.js"), "allow", S, "--session", R, "--data-dir", fresh], { encoding: "utf8", timeout: 20_000 });
      assert.notEqual(p.status, 0);
      assert.equal(existsSync(join(fresh, "peers")), false);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI source does not import any grant writer", () => {
  const src = readFileSync(join(pluginRoot, "src", "cli", "peers.ts"), "utf8");
  for (const w of ["allow", "revoke", "revokeAll", "clearGrants", "atomicWriteFile", "writeFileSync"]) {
    assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), new RegExp(`import[^;]*\\b${w}\\b`), w);
  }
});

test("the peers skill disables model invocation and passes no user argument text to its command", () => {
  const skill = readFileSync(join(pluginRoot, "skills", "peers", "SKILL.md"), "utf8");
  const fm = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? "";
  assert.match(fm, /^name: peers$/m);
  assert.match(fm, /^disable-model-invocation: true$/m);
  assert.match(skill, /dist\/cli\/peers\.js" list --session/);
  assert.doesNotMatch(skill, /\b(allow|revoke)\b[^\n]*dist\/cli\/peers\.js|peers\.js"? (allow|revoke)/);
});

test("the CLI imports exactly { listGrants } from peer-grants and nothing that writes", () => {
  const src = readFileSync(join(pluginRoot, "src", "cli", "peers.ts"), "utf8");
  const code = src.replace(/\/\/.*$/gm, "");
  const lines = code.split("\n").map((l) => l.trim());
  assert.deepEqual(lines.filter((l) => /peer-grants/.test(l)), ['import { listGrants } from "../lib/peer-grants.js";']);
  assert.doesNotMatch(code, /import\s*\*\s*as/);
  assert.doesNotMatch(code, /import[^;]*["'][^"']*\/(lock|state)\.js["']/);
  for (const w of ["allow", "revoke", "revokeAll", "atomicWriteFile", "writeFileSync", "rmSync"]) {
    assert.doesNotMatch(code, new RegExp(`\\b${w}\\s*\\(`), w);
  }
});
