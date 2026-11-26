import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync, lstatSync, statSync, chmodSync, readdirSync } from "node:fs";
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
    assert.match(info.stdout, /default, acceptEdits, auto, plan, bypassPermissions/);
    assert.equal(sha(b.settings), before);
  } finally {
    b.cleanup();
  }
});

test("--apply without --data-dir or data env backs up under ODD_CLAUDE_HOME/data", () => {
  const b = box();
  try {
    const r = setupCli(["--mode", "plan", "--apply", "--settings", b.settings], { ODD_CLAUDE_HOME: join(b.dir, "home") });
    assert.equal(r.exitCode, 0);
    assert.match(readFileSync(b.settings, "utf8"), /"defaultMode": "plan"/);
    assert.equal(readdirSync(join(b.dir, "home", "data", "backups")).length, 1);
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

test("bypassPermissions is accepted: dry run shows the diff plus an explicit warning and writes nothing; apply writes it", () => {
  const b = box();
  try {
    const before = sha(b.settings);
    const dry = setupCli(["--mode", "bypassPermissions", "--settings", b.settings, "--data-dir", b.data], {});
    assert.equal(dry.exitCode, 0);
    assert.match(dry.stdout, /\+.*"defaultMode": "bypassPermissions"/);
    assert.match(dry.stdout, /WARNING: bypassPermissions/);
    assert.match(dry.stdout, /hooks stay active/);
    assert.equal(sha(b.settings), before);
    const json = JSON.parse(setupCli(["--mode", "bypassPermissions", "--json", "--settings", b.settings, "--data-dir", b.data], {}).stdout);
    assert.match(json.warning, /bypassPermissions/);
    const ap = setupCli(["--mode", "bypassPermissions", "--apply", "--settings", b.settings, "--data-dir", b.data], {});
    assert.equal(ap.exitCode, 0);
    assert.match(ap.stdout, /WARNING: bypassPermissions/);
    assert.equal(JSON.parse(readFileSync(b.settings, "utf8")).permissions.defaultMode, "bypassPermissions");
  } finally {
    b.cleanup();
  }
});

test("bypassPermissions apply through a symlink keeps the link and the 0600 target; backups are 0600; WARNING shown", { skip: process.platform === "win32" }, () => {
  const b = box();
  try {
    const link = join(b.dir, "link.json");
    chmodSync(b.settings, 0o600);
    symlinkSync(b.settings, link);
    const ap = setupCli(["--mode", "bypassPermissions", "--apply", "--settings", link, "--data-dir", b.data], {});
    assert.equal(ap.exitCode, 0);
    assert.match(ap.stdout, /WARNING: bypassPermissions/);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(JSON.parse(readFileSync(b.settings, "utf8")).permissions.defaultMode, "bypassPermissions");
    assert.equal(statSync(b.settings).mode & 0o777, 0o600);
    const files = readdirSync(b.data, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /settings\..*\.json$/.test(e.name));
    assert.ok(files.length >= 1);
    for (const f of files) assert.equal(statSync(join(f.parentPath, f.name)).mode & 0o777, 0o600);
  } finally {
    b.cleanup();
  }
});

test("near-miss invalid modes are rejected with the exact error and leave settings untouched", () => {
  const b = box();
  try {
    const before = sha(b.settings);
    for (const m of ["dontAsk", "BypassPermissions", "bypasspermissions", "bypassPermissions "]) {
      const r = setupCli(["--mode", m, "--apply", "--settings", b.settings, "--data-dir", b.data], {});
      assert.equal(r.exitCode, 1, m);
      assert.equal(r.stderr, `error: invalid mode ${JSON.stringify(m)}; valid modes: default, acceptEdits, auto, plan, bypassPermissions`);
      assert.equal(sha(b.settings), before, m);
    }
  } finally {
    b.cleanup();
  }
});

test("the other modes carry no warning", () => {
  const b = box();
  try {
    const dry = setupCli(["--mode", "acceptEdits", "--settings", b.settings, "--data-dir", b.data], {});
    assert.equal(dry.exitCode, 0);
    assert.doesNotMatch(dry.stdout, /WARNING/);
  } finally {
    b.cleanup();
  }
});
