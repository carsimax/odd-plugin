// Public-interface tests: the built CLIs run as real processes (needs `npm run build`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "cli");
const run = (cli: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [join(DIST, `${cli}.js`), ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
const tmp = () => mkdtempSync(join(tmpdir(), "odd-main-"));

test("S21: a failing action prints to stderr and exits non-zero (relative --data-dir)", () => {
  const cwd = tmp();
  try {
    const r = spawnSync(process.execPath, [join(DIST, "coordinator.js"), "--action", "on", "--data-dir", "rel/dir"], { encoding: "utf8", cwd, env: { PATH: process.env.PATH ?? "" } });
    assert.notEqual(r.status, 0);
    assert.notEqual(r.stderr, "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("S21 preserve: a successful coordinator status still exits 0 with the same output", () => {
  const dir = tmp();
  try {
    const r = run("coordinator", ["--action", "status", "--data-dir", dir]);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /^coordinator mode: on \(default\)\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S22: setup without --settings reads <CLAUDE_CONFIG_DIR>/settings.json", () => {
  const cfg = tmp();
  try {
    writeFileSync(join(cfg, "settings.json"), "{}");
    const r = run("setup", ["--data-dir", join(cfg, "d")], { CLAUDE_CONFIG_DIR: cfg });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes(`settings: ${join(cfg, "settings.json")}`), r.stdout);
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("S23: status lists hook events from <CLAUDE_CONFIG_DIR>/settings.json running dist/hooks/run.js", () => {
  const cfg = tmp();
  try {
    const cmd = (n: string) => ({ hooks: [{ type: "command", command: `node /x/${n}` }] });
    writeFileSync(
      join(cfg, "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [cmd("dist/hooks/run.js")], Stop: [cmd("other.js")] } }),
    );
    const r = run("status", ["--data-dir", join(cfg, "d")], { CLAUDE_CONFIG_DIR: cfg });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^hooks: SessionStart$/m);
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});
