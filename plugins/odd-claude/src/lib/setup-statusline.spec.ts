import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync, lstatSync, statSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOwnStatusLine, planStatusLineChange, shimSource, statusLineCommand } from "./setup.js";
import { applyRestore, applyStatusLine, listBackups, refreshStatuslineShim } from "./setup-fs.js";
import { readPluginState } from "./state.js";

const SAMPLE = '{\n  "model": "opus",\n  "permissions": { "defaultMode": "plan", "allow": ["Bash(ls)"] },\n  "env": { "A": "1" }\n}\n';
const FOREIGN = { type: "command", command: "~/bin/my-bar.sh", padding: 1 };

function box(content: string | null = SAMPLE) {
  const dir = mkdtempSync(join(tmpdir(), "odd-sl-set-"));
  const settings = join(dir, "settings.json");
  if (content !== null) writeFileSync(settings, content);
  const data = join(dir, "data");
  const root = join(dir, "plugin-root");
  return { dir, settings, data, root, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const cmd = (data: string): string => statusLineCommand(join(data, "statusline.mjs"));

test("command shape and ownership detection", () => {
  assert.equal(statusLineCommand("/d/statusline.mjs"), 'node "/d/statusline.mjs"');
  assert.equal(isOwnStatusLine({ type: "command", command: 'node "/d/statusline.mjs"' }), true);
  assert.equal(isOwnStatusLine({ type: "command", command: 'node "/old/root/dist/cli/statusline.js"' }), true);
  assert.equal(isOwnStatusLine(FOREIGN), false);
  assert.equal(isOwnStatusLine("x"), false);
  assert.equal(isOwnStatusLine(undefined), false);
});

test("shim imports the resolved plugin root and degrades to a fallback line", () => {
  const s = shimSource("/r/plugin root");
  assert.match(s, /"\/r\/plugin root"/);
  assert.match(s, /dist\/cli\/statusline\.js/);
  assert.match(s, /catch/);
});

test("plan on: adds statusLine only, preserves every other key and the indent", () => {
  const p = planStatusLineChange(SAMPLE, "on", { command: 'node "/d/statusline.mjs"' }, "s.json");
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.equal(p.changed, true);
  assert.equal(p.foreign, false);
  const before = JSON.parse(SAMPLE);
  const after = JSON.parse(p.after);
  assert.deepEqual(after.statusLine, { type: "command", command: 'node "/d/statusline.mjs"' });
  delete after.statusLine;
  assert.deepEqual(after, before);
  assert.match(p.diff, /^\+.*"statusLine"/m);
  assert.match(p.after, /^ {2}"model"/m);
});

test("plan on: missing file creates it; idempotent when already ours; stale own root is replaced without foreign flag", () => {
  const created = planStatusLineChange(null, "on", { command: 'node "/d/statusline.mjs"' });
  assert.ok(created.ok && created.changed && created.before === null);
  const again = planStatusLineChange(created.ok ? created.after : "", "on", { command: 'node "/d/statusline.mjs"' });
  assert.ok(again.ok);
  if (again.ok) assert.deepEqual([again.changed, again.diff], [false, "no changes"]);
  const stale = planStatusLineChange('{"statusLine":{"type":"command","command":"node \\"/old/dist/cli/statusline.js\\""}}', "on", { command: 'node "/d/statusline.mjs"' });
  assert.ok(stale.ok);
  if (stale.ok) assert.deepEqual([stale.changed, stale.foreign], [true, false]);
});

test("plan on over a foreign statusLine shows it in the diff and flags it as foreign", () => {
  const text = JSON.stringify({ model: "opus", statusLine: FOREIGN }, null, 2) + "\n";
  const p = planStatusLineChange(text, "on", { command: 'node "/d/statusline.mjs"' });
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.equal(p.foreign, true);
  assert.match(p.diff, /^-.*my-bar\.sh/m);
  assert.match(p.diff, /^\+.*statusline\.mjs/m);
});

test("plan refuses invalid JSON, non-object roots and a non-object-compatible file", () => {
  for (const bad of ["{", "[]", "null", '"x"']) {
    const p = planStatusLineChange(bad, "on", { command: "c" });
    assert.equal(p.ok, false, bad);
  }
  assert.equal(planStatusLineChange("{}", "sideways" as never, { command: "c" }).ok, false);
});

test("plan off: removes only our own value; restores a recorded previous value; leaves foreign/absent alone", () => {
  const own = JSON.stringify({ model: "opus", statusLine: { type: "command", command: 'node "/d/statusline.mjs"' } }, null, 2) + "\n";
  const removed = planStatusLineChange(own, "off", { command: "x" });
  assert.ok(removed.ok);
  if (removed.ok) assert.deepEqual(JSON.parse(removed.after), { model: "opus" });
  const restored = planStatusLineChange(own, "off", { command: "x", previous: FOREIGN });
  assert.ok(restored.ok);
  if (restored.ok) assert.deepEqual(JSON.parse(restored.after).statusLine, FOREIGN);
  const foreign = JSON.stringify({ statusLine: FOREIGN });
  const untouched = planStatusLineChange(foreign, "off", { command: "x" });
  assert.ok(untouched.ok);
  if (untouched.ok) assert.deepEqual([untouched.changed, untouched.after], [false, foreign]);
  const absent = planStatusLineChange(SAMPLE, "off", { command: "x" });
  assert.ok(absent.ok && !absent.changed);
  const none = planStatusLineChange(null, "off", { command: "x" });
  assert.ok(none.ok && !none.changed);
});

test("apply on: backup 0600 first, shim written, settings changed, other keys intact; second run unchanged", () => {
  const b = box();
  try {
    const before = sha(b.settings);
    const r = applyStatusLine({ settingsPath: b.settings, dataDir: b.data, action: "on", pluginRoot: b.root });
    assert.equal(r.status, "applied");
    assert.ok(r.backupPath && sha(r.backupPath) === before);
    assert.equal(statSync(r.backupPath!).mode & 0o777, 0o600);
    const after = JSON.parse(readFileSync(b.settings, "utf8"));
    assert.deepEqual(after.statusLine, { type: "command", command: cmd(b.data) });
    assert.equal(after.model, "opus");
    assert.deepEqual(after.permissions, { defaultMode: "plan", allow: ["Bash(ls)"] });
    assert.equal(readFileSync(join(b.data, "statusline.mjs"), "utf8"), shimSource(b.root));
    const again = applyStatusLine({ settingsPath: b.settings, dataDir: b.data, action: "on", pluginRoot: b.root });
    assert.equal(again.status, "unchanged");
    assert.equal(listBackups(b.data).length, 1);
  } finally {
    b.cleanup();
  }
});

test("apply on over a foreign statusLine requires replaceForeign; nothing is written without it", () => {
  const text = JSON.stringify({ model: "opus", statusLine: FOREIGN }, null, 2) + "\n";
  const b = box(text);
  try {
    const before = sha(b.settings);
    const refused = applyStatusLine({ settingsPath: b.settings, dataDir: b.data, action: "on", pluginRoot: b.root });
    assert.equal(refused.status, "error");
    assert.match(refused.error!, /replace/i);
    assert.equal(sha(b.settings), before);
    assert.equal(listBackups(b.data).length, 0);
    assert.equal(existsSync(join(b.data, "statusline.mjs")), false);
    const ok = applyStatusLine({ settingsPath: b.settings, dataDir: b.data, action: "on", pluginRoot: b.root, replaceForeign: true });
    assert.equal(ok.status, "applied");
    assert.equal(sha(ok.backupPath!), before);
    // off puts the user's previous statusLine back
    const off = applyStatusLine({ settingsPath: b.settings, dataDir: b.data, action: "off", pluginRoot: b.root });
    assert.equal(off.status, "applied");
    assert.deepEqual(JSON.parse(readFileSync(b.settings, "utf8")), JSON.parse(text));
  } finally {
    b.cleanup();
  }
});

test("apply off without a previous value removes only our key; second off is unchanged", () => {
  const b = box();
  try {
    applyStatusLine({ settingsPath: b.settings, dataDir: b.data, action: "on", pluginRoot: b.root });
    const off = applyStatusLine({ settingsPath: b.settings, dataDir: b.data, action: "off", pluginRoot: b.root });
    assert.equal(off.status, "applied");
    assert.deepEqual(JSON.parse(readFileSync(b.settings, "utf8")), JSON.parse(SAMPLE));
    assert.equal(applyStatusLine({ settingsPath: b.settings, dataDir: b.data, action: "off", pluginRoot: b.root }).status, "unchanged");
    assert.equal(readPluginState("setup", { dataDir: b.data }).statusLinePrevious, undefined);
  } finally {
    b.cleanup();
  }
});

test("restore returns the exact original bytes after an apply", () => {
  const b = box();
  try {
    const before = sha(b.settings);
    applyStatusLine({ settingsPath: b.settings, dataDir: b.data, action: "on", pluginRoot: b.root });
    assert.notEqual(sha(b.settings), before);
    assert.equal(applyRestore({ settingsPath: b.settings, dataDir: b.data }).status, "applied");
    assert.equal(sha(b.settings), before);
  } finally {
    b.cleanup();
  }
});

test("invalid JSON is refused: file, backups and shim untouched", () => {
  const b = box("{ not json");
  try {
    const before = sha(b.settings);
    const r = applyStatusLine({ settingsPath: b.settings, dataDir: b.data, action: "on", pluginRoot: b.root });
    assert.equal(r.status, "error");
    assert.match(r.error!, /not valid JSON/);
    assert.equal(sha(b.settings), before);
    assert.equal(existsSync(b.data), false);
  } finally {
    b.cleanup();
  }
});

test("a missing settings file is created (no backup); a symlinked file keeps the link and mode", () => {
  const b = box(null);
  try {
    const r = applyStatusLine({ settingsPath: b.settings, dataDir: b.data, action: "on", pluginRoot: b.root });
    assert.equal(r.status, "applied");
    assert.equal(r.backupPath, undefined);
    assert.deepEqual(JSON.parse(readFileSync(b.settings, "utf8")), { statusLine: { type: "command", command: cmd(b.data) } });
  } finally {
    b.cleanup();
  }
  const c = box();
  try {
    const real = join(c.dir, "real.json");
    writeFileSync(real, SAMPLE);
    chmodSync(real, 0o640);
    const link = join(c.dir, "link.json");
    symlinkSync(real, link);
    const r = applyStatusLine({ settingsPath: link, dataDir: c.data, action: "on", pluginRoot: c.root });
    assert.equal(r.status, "applied");
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(statSync(real).mode & 0o777, 0o640);
    assert.ok(JSON.parse(readFileSync(real, "utf8")).statusLine);
  } finally {
    c.cleanup();
  }
});

test("refreshStatuslineShim rewrites only an existing shim whose root changed", () => {
  const b = box();
  try {
    assert.equal(refreshStatuslineShim(b.data, b.root), false);
    assert.equal(existsSync(join(b.data, "statusline.mjs")), false);
    applyStatusLine({ settingsPath: b.settings, dataDir: b.data, action: "on", pluginRoot: b.root });
    assert.equal(refreshStatuslineShim(b.data, b.root), false);
    assert.equal(refreshStatuslineShim(b.data, join(b.dir, "new-root")), true);
    assert.equal(readFileSync(join(b.data, "statusline.mjs"), "utf8"), shimSource(join(b.dir, "new-root")));
  } finally {
    b.cleanup();
  }
});
