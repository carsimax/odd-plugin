import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSessionScratch, listScratch, removeSessionScratch, scratchDir, sweepStaleTombstones } from "./scratch.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-scratch-"));
}

test("creates <data>/scratch/<session> privately and is idempotent", () => {
  const dir = tmp();
  try {
    const p = createSessionScratch("sess-1", { dataDir: dir });
    assert.equal(p, join(dir, "scratch", "sess-1"));
    assert.equal(p, scratchDir("sess-1", { dataDir: dir }));
    assert.ok(lstatSync(p).isDirectory());
    assert.equal(lstatSync(p).mode & 0o077, 0);
    writeFileSync(join(p, "keep.txt"), "x");
    assert.equal(createSessionScratch("sess-1", { dataDir: dir }), p);
    assert.ok(existsSync(join(p, "keep.txt")), "re-creating (resume/compact) keeps the contents");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session ids are confined to one path segment", () => {
  const dir = tmp();
  try {
    for (const id of ["../evil", "a/b", "..", "."]) {
      const p = scratchDir(id, { dataDir: dir });
      assert.equal(join(dir, "scratch"), join(p, ".."));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removal deletes only that session's scratch", () => {
  const dir = tmp();
  try {
    const a = createSessionScratch("a", { dataDir: dir });
    const b = createSessionScratch("b", { dataDir: dir });
    mkdirSync(join(a, "sub"));
    writeFileSync(join(a, "sub", "f"), "x");
    assert.equal(removeSessionScratch("a", { dataDir: dir }), "removed");
    assert.equal(existsSync(a), false);
    assert.ok(existsSync(b));
    assert.equal(removeSessionScratch("a", { dataDir: dir }), "absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlinked session dir is refused and its target is left intact", () => {
  const dir = tmp();
  const outside = tmp();
  try {
    writeFileSync(join(outside, "precious"), "x");
    mkdirSync(join(dir, "scratch"));
    symlinkSync(outside, join(dir, "scratch", "evil"));
    assert.equal(removeSessionScratch("evil", { dataDir: dir }), "refused");
    assert.ok(existsSync(join(outside, "precious")));
    assert.throws(() => createSessionScratch("evil", { dataDir: dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlinked scratch root is refused for create and remove", () => {
  const dir = tmp();
  const outside = tmp();
  try {
    mkdirSync(join(outside, "s"));
    symlinkSync(outside, join(dir, "scratch"));
    assert.equal(removeSessionScratch("s", { dataDir: dir }), "refused");
    assert.ok(existsSync(join(outside, "s")));
    assert.throws(() => createSessionScratch("s", { dataDir: dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlink inside the scratch is unlinked, never followed", () => {
  const dir = tmp();
  const outside = tmp();
  try {
    writeFileSync(join(outside, "precious"), "x");
    const p = createSessionScratch("s", { dataDir: dir });
    symlinkSync(outside, join(p, "link"));
    assert.equal(removeSessionScratch("s", { dataDir: dir }), "removed");
    assert.ok(existsSync(join(outside, "precious")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("listScratch reports entries and tolerates a missing dir", () => {
  const dir = tmp();
  try {
    const p = createSessionScratch("s", { dataDir: dir });
    writeFileSync(join(p, "a.txt"), "12345");
    mkdirSync(join(p, "d"));
    assert.deepEqual(listScratch(p), { exists: true, entries: ["a.txt", "d/"], bytes: 5 });
    assert.deepEqual(listScratch(join(dir, "nope")), { exists: false, entries: [], bytes: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hostile session ids never leave <root>; a sibling victim of the data dir survives", () => {
  const base = tmp();
  try {
    const dir = join(base, "data");
    mkdirSync(dir);
    mkdirSync(join(base, "victim"));
    writeFileSync(join(base, "victim", "marker"), "x");
    writeFileSync(join(base, "marker"), "x");
    for (const id of ["..", "../..", "/", "a/../../x", "../victim"]) {
      const p = scratchDir(id, { dataDir: dir });
      assert.equal(dirname(p), join(dir, "scratch"));
      createSessionScratch(id, { dataDir: dir });
      removeSessionScratch(id, { dataDir: dir });
      assert.ok(existsSync(join(base, "victim", "marker")), `victim survives ${id}`);
      assert.ok(existsSync(join(base, "marker")));
      assert.ok(existsSync(join(dir, "scratch")), "root is never removed");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a relative data dir is refused by create and remove and deletes nothing", () => {
  const base = tmp();
  const cwd = process.cwd();
  try {
    mkdirSync(join(base, "scratch", "sess-2"), { recursive: true });
    process.chdir(base);
    assert.throws(() => removeSessionScratch("sess-2", { dataDir: "." }), /absolute/);
    assert.throws(() => removeSessionScratch("sess-2", { env: { CLAUDE_PLUGIN_DATA: "." } }), /absolute/);
    assert.throws(() => createSessionScratch("sess-2", { dataDir: "." }), /absolute/);
    assert.ok(existsSync(join(base, "scratch", "sess-2")));
  } finally {
    process.chdir(cwd);
    rmSync(base, { recursive: true, force: true });
  }
});

for (const kind of ["file", "symlink"] as const) {
  test(`a ${kind} planted at the predicted tombstone name aborts the removal`, (t) => {
    const dir = tmp();
    const outside = tmp();
    try {
      const p = createSessionScratch("sess-1", { dataDir: dir });
      writeFileSync(join(p, "keep"), "x");
      mkdirSync(join(outside, "victim"));
      writeFileSync(join(outside, "victim", "MARK"), "x");
      t.mock.method(Date, "now", () => 1_700_000_000_000);
      const tomb = join(realpathSync(join(dir, "scratch")), `.rm-${process.pid}-1700000000000-sess-1`);
      if (kind === "file") writeFileSync(tomb, "planted");
      else symlinkSync(join(outside, "victim"), tomb);
      assert.equal(removeSessionScratch("sess-1", { dataDir: dir }), "refused");
      assert.ok(existsSync(join(p, "keep")), "session dir kept");
      assert.ok(existsSync(join(outside, "victim", "MARK")), "victim intact");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
}

test("a read-only scratch root refuses the removal and keeps the dir", { skip: process.getuid?.() === 0 }, () => {
  const dir = tmp();
  const root = join(dir, "scratch");
  try {
    const p = createSessionScratch("sess-1", { dataDir: dir });
    chmodSync(root, 0o500);
    assert.equal(removeSessionScratch("sess-1", { dataDir: dir }), "refused");
    assert.ok(existsSync(p));
  } finally {
    chmodSync(root, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a leftover tombstone of a crashed removal is never touched by another session's removal", () => {
  const dir = tmp();
  try {
    createSessionScratch("a", { dataDir: dir });
    const left = join(dir, "scratch", ".rm-1-1700000000000-crashed");
    mkdirSync(left);
    writeFileSync(join(left, "f"), "x");
    assert.equal(removeSessionScratch("a", { dataDir: dir }), "removed");
    assert.ok(existsSync(join(left, "f")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweep removes only stale real-directory tombstones inside the root and never follows symlinks", () => {
  const dir = tmp();
  const outside = tmp();
  try {
    const now = 1_700_000_000_000;
    const root = join(dir, "scratch");
    createSessionScratch("live", { dataDir: dir });
    const stale = join(root, `.rm-1-${now - 2 * 3600_000}-old`);
    const fresh = join(root, `.rm-1-${now - 60_000}-new`);
    const link = join(root, `.rm-1-${now - 2 * 3600_000}-link`);
    const file = join(root, `.rm-1-${now - 2 * 3600_000}-file`);
    const odd = join(root, ".rm-garbage");
    for (const d of [stale, fresh, odd]) {
      mkdirSync(d);
      writeFileSync(join(d, "f"), "x");
    }
    writeFileSync(file, "x");
    mkdirSync(join(outside, "victim"));
    writeFileSync(join(outside, "victim", "MARK"), "x");
    symlinkSync(join(outside, "victim"), link);
    assert.equal(sweepStaleTombstones({ dataDir: dir }, now), 1);
    assert.equal(existsSync(stale), false);
    assert.ok(existsSync(fresh), "fresh kept");
    assert.ok(existsSync(odd), "unparseable name kept");
    assert.ok(existsSync(file), "non-directory kept");
    assert.ok(lstatSync(link).isSymbolicLink(), "symlink ignored");
    assert.ok(existsSync(join(outside, "victim", "MARK")), "victim survives");
    assert.ok(existsSync(join(root, "live")), "live session dir kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("sweep is a no-op for a missing or symlinked root", () => {
  const dir = tmp();
  const outside = tmp();
  try {
    assert.equal(sweepStaleTombstones({ dataDir: dir }, 1e15), 0);
    mkdirSync(join(outside, ".rm-1-1-old"));
    symlinkSync(outside, join(dir, "scratch"));
    assert.equal(sweepStaleTombstones({ dataDir: dir }, 1e15), 0);
    assert.ok(existsSync(join(outside, ".rm-1-1-old")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a tombstone leftover does not break removal and the dir ends up gone", () => {
  const dir = tmp();
  try {
    const p = createSessionScratch("s", { dataDir: dir });
    writeFileSync(join(p, "f"), "x");
    assert.equal(removeSessionScratch("s", { dataDir: dir }), "removed");
    assert.deepEqual(listScratch(join(dir, "scratch")).entries, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweep unlinks symlinks inside a stale tombstone without following them", () => {
  const dir = tmp();
  const outside = tmp();
  try {
    const now = 1_700_000_000_000;
    const root = join(dir, "scratch");
    mkdirSync(root, { recursive: true });
    const tomb = join(root, `.rm-1-${now - 2 * 3600_000}-x`);
    mkdirSync(tomb);
    mkdirSync(join(outside, "victim"));
    writeFileSync(join(outside, "victim", "MARKER"), "x");
    symlinkSync(join(outside, "victim"), join(tomb, "link"));
    assert.equal(sweepStaleTombstones({ dataDir: dir }, now), 1);
    assert.equal(existsSync(tomb), false);
    assert.ok(existsSync(join(outside, "victim", "MARKER")), "victim MARKER survives");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("sweep ignores malformed and future-dated names", () => {
  const dir = tmp();
  try {
    const now = 1_700_000_000_000;
    const root = join(dir, "scratch");
    mkdirSync(root, { recursive: true });
    const names = [".rm-x-y-z", ".rm--1000-x", ".rm-1-1000", ".rm-1-1e3-x", ".rm-1-99999999999999999-a"];
    for (const n of names) mkdirSync(join(root, n));
    assert.equal(sweepStaleTombstones({ dataDir: dir }, now), 0);
    for (const n of names) assert.ok(existsSync(join(root, n)), n);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweep honours the 200 cap and counts only tombstone entries", () => {
  const dir = tmp();
  try {
    const now = 1_700_000_000_000;
    const root = join(dir, "scratch");
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < 250; i++) mkdirSync(join(root, `.rm-1-${now - 2 * 3600_000}-t${i}`));
    assert.equal(sweepStaleTombstones({ dataDir: dir }, now), 200);
    assert.equal(sweepStaleTombstones({ dataDir: dir }, now), 50);
    assert.equal(sweepStaleTombstones({ dataDir: dir }, now), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-tombstone entries do not starve the sweep", () => {
  const dir = tmp();
  try {
    const now = 1_700_000_000_000;
    const root = join(dir, "scratch");
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < 250; i++) mkdirSync(join(root, `a-session-${i}`));
    const tomb = join(root, `.rm-1-${now - 2 * 3600_000}-z`);
    mkdirSync(tomb);
    assert.equal(sweepStaleTombstones({ dataDir: dir }, now), 1);
    assert.equal(existsSync(tomb), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent sweeps ignore ENOENT silently (no hooks.log flood)", async () => {
  const dir = tmp();
  try {
    const now = Date.now();
    const root = join(dir, "scratch");
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < 200; i++) {
      const t = join(root, `.rm-1-${now - 2 * 3600_000}-c${i}`);
      mkdirSync(join(t, "a", "b"), { recursive: true });
      writeFileSync(join(t, "a", "b", "f"), "x");
    }
    const mod = new URL("./scratch.js", import.meta.url).href;
    const code = `import(${JSON.stringify(mod)}).then((m) => { m.sweepStaleTombstones({ dataDir: ${JSON.stringify(dir)} }); });`;
    await Promise.all(
      Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
        const c = spawn(process.execPath, ["-e", code], { stdio: "ignore" });
        c.on("error", reject);
        c.on("close", () => resolve());
      })),
    );
    const log = join(dir, "logs", "hooks.log");
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    assert.ok(!/ENOENT/.test(text), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
