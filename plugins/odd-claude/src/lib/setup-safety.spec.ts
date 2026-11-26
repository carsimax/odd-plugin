import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMode, applyRestore, listBackups } from "./setup-fs.js";

const SAMPLE = '{\n  "env": { "K": "secret" },\n  "permissions": { "defaultMode": "default" }\n}\n';
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const perm = (p: string): number => statSync(p).mode & 0o777;
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "odd-setup-safe-"));
  return { dir, settings: join(dir, "settings.json"), data: join(dir, "data"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// F2
test("apply preserves the original file mode (0600) and creates 0600 backups", () => {
  const s = sandbox();
  try {
    writeFileSync(s.settings, SAMPLE);
    chmodSync(s.settings, 0o600);
    const r = applyMode({ settingsPath: s.settings, dataDir: s.data, mode: "plan" });
    assert.equal(r.status, "applied");
    assert.equal(perm(s.settings), 0o600);
    assert.equal(perm(r.backupPath!), 0o600);
  } finally {
    s.cleanup();
  }
});

test("restore preserves the file mode and writes 0600 backups", () => {
  const s = sandbox();
  try {
    writeFileSync(s.settings, SAMPLE);
    chmodSync(s.settings, 0o640);
    applyMode({ settingsPath: s.settings, dataDir: s.data, mode: "plan", now: new Date("2026-11-18T17:00:00.000Z") });
    const r = applyRestore({ settingsPath: s.settings, dataDir: s.data, now: new Date("2026-11-18T17:00:01.000Z") });
    assert.equal(r.status, "applied");
    assert.equal(perm(s.settings), 0o640);
    for (const b of listBackups(s.data)) assert.equal(perm(join(s.data, "backups", b)), 0o600);
  } finally {
    s.cleanup();
  }
});

test("apply and restore refuse a read-only settings file: error, nothing written, no backup", { skip: isRoot }, () => {
  const s = sandbox();
  try {
    writeFileSync(s.settings, SAMPLE);
    chmodSync(s.settings, 0o400);
    const before = sha(s.settings);
    const r = applyMode({ settingsPath: s.settings, dataDir: s.data, mode: "plan" });
    assert.equal(r.status, "error");
    assert.match(r.error ?? "", /not writable/);
    assert.equal(sha(s.settings), before);
    assert.equal(perm(s.settings), 0o400);
    assert.equal(listBackups(s.data).length, 0);
    const rr = applyRestore({ settingsPath: s.settings, dataDir: s.data });
    assert.equal(rr.status, "error");
  } finally {
    chmodSync(s.settings, 0o600);
    s.cleanup();
  }
});

// F3
test("a symlinked settings.json stays a symlink and its target is updated; restore too", () => {
  const s = sandbox();
  try {
    const real = join(s.dir, "dotfiles", "settings.real.json");
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, SAMPLE);
    symlinkSync(real, s.settings);
    const original = sha(real);
    const r = applyMode({ settingsPath: s.settings, dataDir: s.data, mode: "plan", now: new Date("2026-11-18T17:00:00.000Z") });
    assert.equal(r.status, "applied");
    assert.equal(lstatSync(s.settings).isSymbolicLink(), true);
    assert.equal(JSON.parse(readFileSync(real, "utf8")).permissions.defaultMode, "plan");
    assert.equal(readFileSync(r.backupPath!, "utf8"), SAMPLE);
    assert.deepEqual(readdirSync(dirname(real)).filter((f) => f.endsWith(".tmp")), []);
    const rr = applyRestore({ settingsPath: s.settings, dataDir: s.data, now: new Date("2026-11-18T17:00:01.000Z") });
    assert.equal(rr.status, "applied");
    assert.equal(lstatSync(s.settings).isSymbolicLink(), true);
    assert.equal(sha(real), original);
  } finally {
    s.cleanup();
  }
});

test("a dangling symlink is an error and nothing is written", () => {
  const s = sandbox();
  try {
    symlinkSync(join(s.dir, "nowhere.json"), s.settings);
    const r = applyMode({ settingsPath: s.settings, dataDir: s.data, mode: "plan" });
    assert.equal(r.status, "error");
    assert.equal(lstatSync(s.settings).isSymbolicLink(), true);
    assert.equal(listBackups(s.data).length, 0);
  } finally {
    s.cleanup();
  }
});

// F1
test("SKILL.md never lets user argument text reach a `!` shell command", () => {
  const skill = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "odd-setup", "SKILL.md");
  const text = readFileSync(skill, "utf8");
  const bang = text.split("\n").filter((l) => l.includes("!`"));
  assert.ok(bang.length >= 1, "expects at least one ! injection");
  for (const l of bang) assert.doesNotMatch(l, /\$ARGUMENTS|\$\{?ARGUMENTS|\$\d|\$\{?\d|\$\{?[A-Za-z_]+\[|\$name/, l);
  // only the two plugin variables are allowed inside injected commands
  for (const l of bang) {
    for (const m of l.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
      assert.ok(["CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA"].includes(m[1]!), `unexpected variable ${m[1]} in: ${l}`);
    }
  }
  // the model-run commands must only use a whitelisted mode, never raw $ARGUMENTS
  assert.doesNotMatch(text.split("\n").filter((l) => l.includes("dist/cli/setup.js")).join("\n"), /\$ARGUMENTS/);
});
