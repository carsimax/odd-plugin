import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODES, planModeChange, unifiedDiff } from "./setup.js";
import { applyMode, applyRestore, planRestore, listBackups } from "./setup-fs.js";

const SAMPLE = `{
  "env": { "FOO": "bar" },
  "permissions": {
    "allow": ["Bash(git status)"],
    "${"de"}ny": ["Read(.env)"],
    "ask": ["Bash(rm:*)"],
    "defaultMode": "default"
  },
  "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "echo hi" }] }] },
  "model": "opus"
}
`;

function sandbox(): { dir: string; settings: string; data: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "odd-setup-"));
  return { dir, settings: join(dir, "settings.json"), data: join(dir, "data"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const backupCount = (data: string): number => listBackups(data).length;

test("MODES are exactly default, acceptEdits, auto, plan, bypassPermissions", () => {
  assert.deepEqual([...MODES], ["default", "acceptEdits", "auto", "plan", "bypassPermissions"]);
});

test("plan preserves every unrelated key and only changes permissions.defaultMode", () => {
  const p = planModeChange(SAMPLE, "plan");
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.equal(p.changed, true);
  const before = JSON.parse(SAMPLE);
  const after = JSON.parse(p.after);
  assert.equal(after.permissions.defaultMode, "plan");
  before.permissions.defaultMode = "plan";
  assert.deepEqual(after, before);
  assert.match(p.diff, /^-.*"defaultMode": "default"/m);
  assert.match(p.diff, /^\+.*"defaultMode": "plan"/m);
});

test("plan creates permissions when absent, keeping other keys", () => {
  const p = planModeChange('{"model":"opus","env":{"A":"1"}}', "acceptEdits");
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.deepEqual(JSON.parse(p.after), { model: "opus", env: { A: "1" }, permissions: { defaultMode: "acceptEdits" } });
});

test("plan is idempotent: same value means no changes", () => {
  const p = planModeChange(SAMPLE, "default");
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.equal(p.changed, false);
  assert.equal(p.diff, "no changes");
});

test("plan rejects invalid modes with a clear error", () => {
  for (const bad of ["yolo", "", "PLAN", "bypasspermissions"]) {
    const p = planModeChange(SAMPLE, bad);
    assert.equal(p.ok, false);
    if (!p.ok) assert.match(p.error, /invalid mode.*default, acceptEdits, auto, plan, bypassPermissions/);
  }
});

test("plan refuses invalid JSON, non-object roots and non-object permissions", () => {
  for (const bad of ["{ nope", "[]", "null", '{"permissions": []}', '{"permissions": "x"}']) {
    const p = planModeChange(bad, "plan");
    assert.equal(p.ok, false, bad);
  }
});

test("plan on a missing file (null) proposes a minimal file", () => {
  const p = planModeChange(null, "auto");
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.deepEqual(JSON.parse(p.after), { permissions: { defaultMode: "auto" } });
  assert.equal(p.changed, true);
});

test("unifiedDiff marks removed and added lines and says no changes when equal", () => {
  assert.equal(unifiedDiff("a\n", "a\n", "x", "y"), "no changes");
  const d = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "x", "y");
  assert.match(d, /^--- x$/m);
  assert.match(d, /^\+\+\+ y$/m);
  assert.match(d, /^-b$/m);
  assert.match(d, /^\+B$/m);
});

test("dry-run style planning writes nothing (plan is pure)", () => {
  const s = sandbox();
  try {
    writeFileSync(s.settings, SAMPLE);
    const before = sha(s.settings);
    planModeChange(readFileSync(s.settings, "utf8"), "plan");
    assert.equal(sha(s.settings), before);
    assert.equal(existsSync(s.data), false);
  } finally {
    s.cleanup();
  }
});

test("apply creates exactly one backup with the original bytes and valid JSON result", () => {
  const s = sandbox();
  try {
    writeFileSync(s.settings, SAMPLE);
    const r = applyMode({ settingsPath: s.settings, dataDir: s.data, mode: "plan", now: new Date("2026-11-18T17:00:00.123Z") });
    assert.equal(r.status, "applied");
    assert.equal(backupCount(s.data), 1);
    assert.ok(r.backupPath);
    assert.equal(readFileSync(r.backupPath!, "utf8"), SAMPLE);
    assert.match(r.backupPath!, /backups[\\/]settings\.20261118T170000123Z\.json$/);
    assert.equal(JSON.parse(readFileSync(s.settings, "utf8")).permissions.defaultMode, "plan");
    // plugin state records the backup path
    const state = JSON.parse(readFileSync(join(s.data, "setup.json"), "utf8"));
    assert.equal(state.data.lastBackup, r.backupPath);
    // atomic write leaves no temp files in either dir
    assert.deepEqual(readdirSync(s.dir).filter((f) => f.endsWith(".tmp")), []);
    assert.deepEqual(readdirSync(join(s.data, "backups")).filter((f) => f.endsWith(".tmp")), []);
    assert.deepEqual(readdirSync(s.data).filter((f) => f.endsWith(".tmp")), []);
  } finally {
    s.cleanup();
  }
});

test("apply with the same value is a no-op: no write, no backup, mtime unchanged", () => {
  const s = sandbox();
  try {
    writeFileSync(s.settings, SAMPLE);
    utimesSync(s.settings, new Date(1_000_000), new Date(1_000_000));
    const mtime = statSync(s.settings).mtimeMs;
    const before = sha(s.settings);
    const r = applyMode({ settingsPath: s.settings, dataDir: s.data, mode: "default" });
    assert.equal(r.status, "unchanged");
    assert.equal(r.diff, "no changes");
    assert.equal(statSync(s.settings).mtimeMs, mtime);
    assert.equal(sha(s.settings), before);
    assert.equal(backupCount(s.data), 0);
  } finally {
    s.cleanup();
  }
});

test("apply with an invalid mode errors and leaves the file and backups untouched", () => {
  const s = sandbox();
  try {
    writeFileSync(s.settings, SAMPLE);
    const before = sha(s.settings);
    const r = applyMode({ settingsPath: s.settings, dataDir: s.data, mode: "yolo" });
    assert.equal(r.status, "error");
    assert.match(r.error ?? "", /invalid mode/);
    assert.equal(sha(s.settings), before);
    assert.equal(backupCount(s.data), 0);
  } finally {
    s.cleanup();
  }
});

test("apply refuses an invalid JSON file and changes nothing", () => {
  const s = sandbox();
  try {
    writeFileSync(s.settings, "{ not json");
    const before = sha(s.settings);
    const r = applyMode({ settingsPath: s.settings, dataDir: s.data, mode: "plan" });
    assert.equal(r.status, "error");
    assert.match(r.error ?? "", /not valid JSON/);
    assert.equal(sha(s.settings), before);
    assert.equal(backupCount(s.data), 0);
  } finally {
    s.cleanup();
  }
});

test("apply on a missing settings file creates a minimal file and no backup", () => {
  const s = sandbox();
  try {
    const r = applyMode({ settingsPath: s.settings, dataDir: s.data, mode: "auto" });
    assert.equal(r.status, "applied");
    assert.equal(r.backupPath, undefined);
    assert.deepEqual(JSON.parse(readFileSync(s.settings, "utf8")), { permissions: { defaultMode: "auto" } });
    assert.equal(backupCount(s.data), 0);
  } finally {
    s.cleanup();
  }
});

test("restore round-trips to the original bytes, showing a diff first, and backs up the current file", () => {
  const s = sandbox();
  try {
    writeFileSync(s.settings, SAMPLE);
    const original = sha(s.settings);
    applyMode({ settingsPath: s.settings, dataDir: s.data, mode: "plan", now: new Date("2026-11-18T17:00:00.000Z") });
    assert.notEqual(sha(s.settings), original);
    const plan = planRestore({ settingsPath: s.settings, dataDir: s.data });
    assert.ok(plan.ok);
    if (!plan.ok) return;
    assert.equal(plan.changed, true);
    assert.match(plan.diff, /^-.*"defaultMode": "plan"/m);
    assert.match(plan.diff, /^\+.*"defaultMode": "default"/m);
    assert.equal(backupCount(s.data), 1, "planning writes nothing");
    const r = applyRestore({ settingsPath: s.settings, dataDir: s.data, now: new Date("2026-11-18T17:00:01.000Z") });
    assert.equal(r.status, "applied");
    assert.equal(sha(s.settings), original);
    assert.equal(backupCount(s.data), 2, "pre-restore state is backed up too");
    assert.deepEqual(readdirSync(s.dir).filter((f) => f.endsWith(".tmp")), []);
  } finally {
    s.cleanup();
  }
});

test("restore accepts a named backup and rejects path traversal and unknown names", () => {
  const s = sandbox();
  try {
    writeFileSync(s.settings, SAMPLE);
    const a = applyMode({ settingsPath: s.settings, dataDir: s.data, mode: "plan", now: new Date("2026-11-18T17:00:00.000Z") });
    applyMode({ settingsPath: s.settings, dataDir: s.data, mode: "auto", now: new Date("2026-11-18T17:00:05.000Z") });
    const name = a.backupPath!.split(/[\\/]/).pop()!;
    assert.ok(planRestore({ settingsPath: s.settings, dataDir: s.data, backup: name }).ok);
    assert.equal(planRestore({ settingsPath: s.settings, dataDir: s.data, backup: "../../etc/passwd" }).ok, false);
    assert.equal(planRestore({ settingsPath: s.settings, dataDir: s.data, backup: "settings.nope.json" }).ok, false);
    const before = sha(s.settings);
    const r = applyRestore({ settingsPath: s.settings, dataDir: s.data, backup: "../x" });
    assert.equal(r.status, "error");
    assert.equal(sha(s.settings), before);
  } finally {
    s.cleanup();
  }
});

test("restore with no backups errors and changes nothing", () => {
  const s = sandbox();
  try {
    writeFileSync(s.settings, SAMPLE);
    const before = sha(s.settings);
    const r = applyRestore({ settingsPath: s.settings, dataDir: s.data });
    assert.equal(r.status, "error");
    assert.match(r.error ?? "", /no backups/);
    assert.equal(sha(s.settings), before);
  } finally {
    s.cleanup();
  }
});
