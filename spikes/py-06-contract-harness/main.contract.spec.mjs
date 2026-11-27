// Throwaway spike: copy of plugins/odd-claude/src/cli/main.spec.ts (black-box, S21-S23) with the entry command
// chosen by ODD_IMPL=ts|py. Only the entry resolution differs; the assertions are the original ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IMPL = process.env.ODD_IMPL ?? "ts";

// shortcut: py is a placeholder that fails loudly; replace with the Python console script when a port exists.
function entry(cli) {
  if (IMPL === "ts") return [process.execPath, [join(REPO, "plugins", "odd-claude", "dist", "cli", `${cli}.js`)]];
  if (IMPL === "py") return ["sh", ["-c", 'echo "ODD_IMPL=py: no Python port of odd-$0 exists yet" >&2; exit 97', cli]];
  throw new Error(`ODD_IMPL must be ts or py, got ${IMPL}`);
}
function spawnCli(cli, args, opts) {
  const [cmd, pre] = entry(cli);
  return spawnSync(cmd, [...pre, ...args], { encoding: "utf8", ...opts });
}
const run = (cli, args, env = {}) => spawnCli(cli, args, { env: { PATH: process.env.PATH ?? "", ...env } });
const tmp = () => mkdtempSync(join(tmpdir(), "odd-contract-"));

test("S21: a failing action prints to stderr and exits non-zero (relative --data-dir)", () => {
  const cwd = tmp();
  try {
    const r = spawnCli("coordinator", ["--action", "on", "--data-dir", "rel/dir"], { cwd, env: { PATH: process.env.PATH ?? "" } });
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
    const cmd = (n) => ({ hooks: [{ type: "command", command: `node /x/${n}` }] });
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ hooks: { SessionStart: [cmd("dist/hooks/run.js")], Stop: [cmd("other.js")] } }));
    const r = run("status", ["--data-dir", join(cfg, "d")], { CLAUDE_CONFIG_DIR: cfg });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^hooks: SessionStart$/m);
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});
