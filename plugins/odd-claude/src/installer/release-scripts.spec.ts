import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PAYLOAD_ITEMS } from "./payload.js";

// Compiled to dist-test/installer/, so the plugin root is two levels up.
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS = join(PLUGIN_ROOT, "scripts");

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const run = (cwd: string, script: string, args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
const tar = (args: string[]): string => {
  const r = spawnSync("tar", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

/** A temp layout `<root>/plugins/odd-claude/{scripts,dist,...}` with a small fake payload and a real copy of the compiled installer. */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "odd-rel-"));
  const plugin = join(root, "plugins", "odd-claude");
  mkdirSync(join(plugin, "scripts"), { recursive: true });
  for (const s of ["release-payload.mjs", "bump-version.mjs"]) if (existsSync(join(SCRIPTS, s))) cpSync(join(SCRIPTS, s), join(plugin, "scripts", s));
  cpSync(join(PLUGIN_ROOT, "dist", "installer"), join(plugin, "dist", "installer"), { recursive: true });
  const put = (rel: string, body: string, mode = 0o644) => {
    mkdirSync(dirname(join(plugin, rel)), { recursive: true });
    writeFileSync(join(plugin, rel), body, { mode });
  };
  put("agents/odd-worker.md", "worker ${CLAUDE_PLUGIN_ROOT}\n");
  put("support/a/b.md", "doc\n");
  put("hooks/run.sh", "#!/bin/sh\n", 0o755);
  put("package.json", '{\n  "name": "odd-claude",\n  "version": "5.3.0"\n}\n');
  put("node_modules/x/index.js", "never shipped\n");
  put("src/not-shipped.ts", "x\n");
  return { root, plugin, put, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("release-payload: tarball has the versioned top dir with only PAYLOAD_ITEMS and checksums verify", () => {
  const r = makeRepo();
  try {
    const out = join(r.root, "out");
    const bundle = join(r.root, "b.mjs");
    writeFileSync(bundle, "// bundle\n");
    const res = run(r.plugin, "scripts/release-payload.mjs", ["--version", "5.3.0", "--out", out, "--bundle", bundle]);
    assert.equal(res.status, 0, res.stderr);
    const tgz = join(out, "odd-claude-payload-5.3.0.tar.gz");
    const names = tar(["-tzf", tgz]).split("\n").filter(Boolean).filter((n) => !n.endsWith("/")).sort();
    for (const n of ["agents/odd-worker.md", "support/a/b.md", "hooks/run.sh", "package.json"]) assert.ok(names.includes(`odd-claude-5.3.0/${n}`), n);
    assert.ok(names.some((n) => n.startsWith("odd-claude-5.3.0/dist/installer/payload.js")));
    for (const n of names) {
      assert.ok(n.startsWith("odd-claude-5.3.0/"), n);
      assert.ok((PAYLOAD_ITEMS as readonly string[]).includes(n.split("/")[1]!), `unexpected top item in ${n}`);
    }
    // content is raw (placeholders unresolved) and the exec bit survives
    const ex = mkdtempSync(join(tmpdir(), "odd-rel-x-"));
    try {
      tar(["-xzf", tgz, "-C", ex]);
      assert.equal(readFileSync(join(ex, "odd-claude-5.3.0/agents/odd-worker.md"), "utf8"), "worker ${CLAUDE_PLUGIN_ROOT}\n");
      assert.equal(statSync(join(ex, "odd-claude-5.3.0/hooks/run.sh")).mode & 0o111, 0o111);
    } finally {
      rmSync(ex, { recursive: true, force: true });
    }
    const lines = readFileSync(join(out, "checksums.txt"), "utf8").trim().split("\n");
    assert.deepEqual(lines.map((l) => l.split("  ")[1]).sort(), ["odd-claude-payload-5.3.0.tar.gz", "odd-claude.mjs"]);
    for (const l of lines) {
      const [h, f] = l.split("  ");
      assert.equal(h, sha(readFileSync(join(out, f!))), f);
    }
    assert.equal(readFileSync(join(out, "odd-claude.mjs"), "utf8"), "// bundle\n");
  } finally {
    r.done();
  }
});

test("release-payload: deterministic output; without a bundle only the tarball is listed", () => {
  const r = makeRepo();
  try {
    const a = join(r.root, "a");
    const b = join(r.root, "b");
    assert.equal(run(r.plugin, "scripts/release-payload.mjs", ["--version", "1.0.0", "--out", a]).status, 0);
    assert.equal(run(r.plugin, "scripts/release-payload.mjs", ["--version", "1.0.0", "--out", b]).status, 0);
    assert.equal(readFileSync(join(a, "checksums.txt"), "utf8"), readFileSync(join(b, "checksums.txt"), "utf8"));
    assert.equal(readFileSync(join(a, "checksums.txt"), "utf8").trim().split("\n").length, 1);
  } finally {
    r.done();
  }
});

test("release-payload: rejects a missing or unsafe version, writing nothing", () => {
  const r = makeRepo();
  try {
    const out = join(r.root, "out");
    const none = run(r.plugin, "scripts/release-payload.mjs", ["--out", out]);
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /--version/);
    const bad = run(r.plugin, "scripts/release-payload.mjs", ["--version", "../x", "--out", out]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /invalid version/);
    assert.equal(existsSync(out), false);
  } finally {
    r.done();
  }
});

const pj = (root: string): string => JSON.parse(readFileSync(join(root, "plugins/odd-claude/package.json"), "utf8")).version as string;

test("bump-version: updates package.json, plugin.json and marketplace.json preserving format", () => {
  const r = makeRepo();
  try {
    r.put(".claude-plugin/plugin.json", '{\n  "name": "odd-claude",\n  "version": "5.3.0"\n}\n');
    mkdirSync(join(r.root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(r.root, ".claude-plugin/marketplace.json"), '{\n  "plugins": [\n    { "name": "odd-claude", "version": "5.3.0" }\n  ]\n}\n');
    const res = run(r.plugin, "scripts/bump-version.mjs", ["5.4.0"]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(pj(r.root), "5.4.0");
    assert.equal(readFileSync(join(r.plugin, ".claude-plugin/plugin.json"), "utf8"), '{\n  "name": "odd-claude",\n  "version": "5.4.0"\n}\n');
    assert.match(readFileSync(join(r.root, ".claude-plugin/marketplace.json"), "utf8"), /"version": "5.4.0" \}/);
  } finally {
    r.done();
  }
});

test("bump-version: tolerates missing plugin.json and marketplace.json", () => {
  const r = makeRepo();
  try {
    const res = run(r.plugin, "scripts/bump-version.mjs", ["6.0.0-rc.1"]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(pj(r.root), "6.0.0-rc.1");
    assert.equal(existsSync(join(r.plugin, ".claude-plugin")), false);
  } finally {
    r.done();
  }
});

test("bump-version: rejects bad semver and downgrades, leaving files untouched; --allow-downgrade permits", () => {
  const r = makeRepo();
  try {
    for (const v of ["5.4", "v5.4.0", "01.2.3", "x"]) {
      const res = run(r.plugin, "scripts/bump-version.mjs", [v]);
      assert.notEqual(res.status, 0, v);
      assert.match(res.stderr, /invalid semver/);
    }
    const down = run(r.plugin, "scripts/bump-version.mjs", ["5.2.9"]);
    assert.notEqual(down.status, 0);
    assert.match(down.stderr, /downgrade/);
    assert.notEqual(run(r.plugin, "scripts/bump-version.mjs", ["5.3.0-rc.1"]).status, 0, "a prerelease of the same version is lower");
    assert.equal(pj(r.root), "5.3.0");
    const ok = run(r.plugin, "scripts/bump-version.mjs", ["5.2.9", "--allow-downgrade"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(pj(r.root), "5.2.9");
  } finally {
    r.done();
  }
});
