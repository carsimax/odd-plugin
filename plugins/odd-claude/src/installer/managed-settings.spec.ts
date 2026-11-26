import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManagedSettings, restoreManagedSettings } from "./managed-settings.js";

function sandbox(initial?: string) {
  const dir = mkdtempSync(join(tmpdir(), "odd-managed-"));
  const settingsPath = join(dir, "settings.json");
  if (initial !== undefined) writeFileSync(settingsPath, initial);
  const paths = { settingsPath, statePath: join(dir, "odd", "settings-state.json"), backupDir: join(dir, "odd", "backups") };
  return { dir, paths, read: () => JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("apply sets values, keeps unknown keys, writes 2-space JSON with trailing newline and a 0600 backup", () => {
  const s = sandbox('{"theme":"dark","env":{"A":"1"}}');
  try {
    const r = applyManagedSettings(s.paths, [{ path: ["outputStyle"], value: "odd" }, { path: ["enabledPlugins", "x@builtin"], value: false }]);
    assert.equal(r.status, "applied");
    assert.equal(readFileSync(s.paths.settingsPath, "utf8"), JSON.stringify({ theme: "dark", env: { A: "1" }, outputStyle: "odd", enabledPlugins: { "x@builtin": false } }, null, 2) + "\n");
    const backups = readdirSync(s.paths.backupDir);
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(s.paths.backupDir, backups[0]), "utf8"), '{"theme":"dark","env":{"A":"1"}}');
    assert.equal(statSync(join(s.paths.backupDir, backups[0])).mode & 0o777, 0o600);
    assert.equal(r.backupPath, join(s.paths.backupDir, backups[0]));
  } finally {
    s.cleanup();
  }
});

test("apply creates settings.json when absent and restore removes the key again", () => {
  const s = sandbox();
  try {
    assert.equal(applyManagedSettings(s.paths, [{ path: ["outputStyle"], value: "odd" }]).status, "applied");
    assert.deepEqual(s.read(), { outputStyle: "odd" });
    assert.equal(existsSync(s.paths.backupDir), false);
    const r = restoreManagedSettings(s.paths);
    assert.deepEqual(r.restored, [["outputStyle"]]);
    assert.deepEqual(s.read(), {});
  } finally {
    s.cleanup();
  }
});

test("restore puts back the previous value, or deletes the key when it was absent (pruning emptied parents)", () => {
  const s = sandbox('{"outputStyle":"concise","keep":1}');
  try {
    applyManagedSettings(s.paths, [{ path: ["outputStyle"], value: "odd" }, { path: ["enabledPlugins", "x@builtin"], value: false }]);
    const r = restoreManagedSettings(s.paths);
    assert.equal(r.status, "applied");
    assert.deepEqual(r.kept, []);
    assert.deepEqual(s.read(), { outputStyle: "concise", keep: 1 });
    assert.equal(restoreManagedSettings(s.paths).status, "unchanged");
  } finally {
    s.cleanup();
  }
});

test("re-apply keeps the original previous value", () => {
  const s = sandbox('{"outputStyle":"concise"}');
  try {
    applyManagedSettings(s.paths, [{ path: ["outputStyle"], value: "odd" }]);
    const again = applyManagedSettings(s.paths, [{ path: ["outputStyle"], value: "odd" }]);
    assert.equal(again.status, "unchanged");
    applyManagedSettings(s.paths, [{ path: ["outputStyle"], value: "odd2" }]);
    restoreManagedSettings(s.paths);
    assert.deepEqual(s.read(), { outputStyle: "concise" });
  } finally {
    s.cleanup();
  }
});

test("restore keeps and reports a value the user changed after we wrote it", () => {
  const s = sandbox('{"outputStyle":"concise"}');
  try {
    applyManagedSettings(s.paths, [{ path: ["outputStyle"], value: "odd" }, { path: ["statusLine"], value: { type: "command", command: "x" } }]);
    writeFileSync(s.paths.settingsPath, JSON.stringify({ outputStyle: "mine", statusLine: { type: "command", command: "x" } }));
    const r = restoreManagedSettings(s.paths);
    assert.deepEqual(r.restored, [["statusLine"]]);
    assert.equal(r.kept.length, 1);
    assert.deepEqual(r.kept[0].path, ["outputStyle"]);
    assert.deepEqual(s.read(), { outputStyle: "mine" });
  } finally {
    s.cleanup();
  }
});

test("restore can be limited to some paths", () => {
  const s = sandbox("{}");
  try {
    applyManagedSettings(s.paths, [{ path: ["a"], value: 1 }, { path: ["b"], value: 2 }]);
    restoreManagedSettings(s.paths, [["a"]]);
    assert.deepEqual(s.read(), { b: 2 });
  } finally {
    s.cleanup();
  }
});

test("invalid JSON aborts with a clear error and writes nothing", () => {
  const s = sandbox("{ not json");
  try {
    const r = applyManagedSettings(s.paths, [{ path: ["outputStyle"], value: "odd" }]);
    assert.equal(r.status, "error");
    assert.match(r.error ?? "", /not valid JSON/);
    assert.equal(readFileSync(s.paths.settingsPath, "utf8"), "{ not json");
    assert.equal(existsSync(s.paths.backupDir), false);
    assert.equal(existsSync(s.paths.statePath), false);
    assert.equal(restoreManagedSettings(s.paths).status, "unchanged");
  } finally {
    s.cleanup();
  }
});

test("a non-object intermediate value aborts without writing", () => {
  const s = sandbox('{"enabledPlugins":"oops"}');
  try {
    const r = applyManagedSettings(s.paths, [{ path: ["enabledPlugins", "x@builtin"], value: false }]);
    assert.equal(r.status, "error");
    assert.equal(readFileSync(s.paths.settingsPath, "utf8"), '{"enabledPlugins":"oops"}');
    assert.equal(existsSync(s.paths.statePath), false);
  } finally {
    s.cleanup();
  }
});

test("a symlinked settings.json keeps its link and updates the target", () => {
  const s = sandbox();
  try {
    const target = join(s.dir, "real.json");
    writeFileSync(target, "{}");
    symlinkSync(target, s.paths.settingsPath);
    applyManagedSettings(s.paths, [{ path: ["outputStyle"], value: "odd" }]);
    assert.equal(lstatSync(s.paths.settingsPath).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { outputStyle: "odd" });
  } finally {
    s.cleanup();
  }
});
