import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSessionScratch, listScratch, removeSessionScratch, scratchDir } from "./scratch.js";

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
