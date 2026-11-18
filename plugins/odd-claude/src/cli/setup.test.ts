import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupCli } from "./setup.js";

const SAMPLE = '{\n  "model": "opus",\n  "permissions": { "allow": ["Bash(ls)"] }\n}\n';
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

function box() {
  const dir = mkdtempSync(join(tmpdir(), "odd-setup-cli-"));
  const settings = join(dir, "settings.json");
  writeFileSync(settings, SAMPLE);
  return { dir, settings, data: join(dir, "data"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("dry run prints the diff, exits 0 and writes nothing (declined path)", () => {
  const b = box();
  try {
    const before = sha(b.settings);
    const r = setupCli(["--mode", "plan", "--settings", b.settings, "--data-dir", b.data], {});
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /^\+.*"defaultMode": "plan"/m);
    assert.match(r.stdout, /dry run/);
    assert.equal(sha(b.settings), before);
    assert.equal(existsSync(b.data), false);
  } finally {
    b.cleanup();
  }
});

test("--apply writes, then --restore (dry) shows a diff and --restore --apply restores bytes", () => {
  const b = box();
  try {
    const before = sha(b.settings);
    const a = setupCli(["--mode", "plan", "--apply", "--settings", b.settings, "--data-dir", b.data], {});
    assert.equal(a.exitCode, 0);
    assert.match(a.stdout, /backup: .*settings\..*\.json/);
    assert.notEqual(sha(b.settings), before);
    const dry = setupCli(["--restore", "--settings", b.settings, "--data-dir", b.data], {});
    assert.equal(dry.exitCode, 0);
    assert.match(dry.stdout, /dry run/);
    const r = setupCli(["--restore", "--apply", "--settings", b.settings, "--data-dir", b.data], {});
    assert.equal(r.exitCode, 0);
    assert.equal(sha(b.settings), before);
  } finally {
    b.cleanup();
  }
});

test("invalid mode exits 1; usage errors exit 2; no args lists state and modes", () => {
  const b = box();
  try {
    const before = sha(b.settings);
    const bad = setupCli(["--mode", "yolo", "--apply", "--settings", b.settings, "--data-dir", b.data], {});
    assert.equal(bad.exitCode, 1);
    assert.match(bad.stderr, /invalid mode/);
    assert.equal(sha(b.settings), before);
    assert.equal(setupCli(["--apply", "--settings", b.settings, "--data-dir", b.data], {}).exitCode, 2);
    assert.equal(setupCli(["--bogus"], {}).exitCode, 2);
    const info = setupCli(["--settings", b.settings, "--data-dir", b.data], {});
    assert.equal(info.exitCode, 0);
    assert.match(info.stdout, /default, acceptEdits, auto, plan/);
    assert.equal(sha(b.settings), before);
  } finally {
    b.cleanup();
  }
});

test("--apply without any data dir exits 2 and writes nothing", () => {
  const b = box();
  try {
    const before = sha(b.settings);
    const r = setupCli(["--mode", "plan", "--apply", "--settings", b.settings], {});
    assert.equal(r.exitCode, 2);
    assert.equal(sha(b.settings), before);
  } finally {
    b.cleanup();
  }
});

test("--json emits a machine-readable result", () => {
  const b = box();
  try {
    const r = setupCli(["--mode", "plan", "--json", "--settings", b.settings, "--data-dir", b.data], {});
    const o = JSON.parse(r.stdout);
    assert.equal(o.status, "dry-run");
    assert.equal(o.changed, true);
    assert.equal(typeof o.diff, "string");
  } finally {
    b.cleanup();
  }
});
