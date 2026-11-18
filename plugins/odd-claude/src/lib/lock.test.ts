import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, lockPath, releaseLock, setLockPid } from "./lock.js";

function tmp(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "odd-lock-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("lock: keyed by kind and project path", () => {
  assert.notEqual(lockPath("/d", "warm", "/a"), lockPath("/d", "warm", "/b"));
  assert.notEqual(lockPath("/d", "warm", "/a"), lockPath("/d", "registry", "/a"));
  assert.equal(lockPath("/d", "warm", "/a"), lockPath("/d", "warm", "/a/"));
});

test("lock: second acquire while held by a live pid fails; release by owner frees it", () => {
  const t = tmp();
  try {
    const p = lockPath(t.dir, "warm", "/proj");
    const o = { staleMs: 60_000, isAlive: () => true };
    assert.equal(acquireLock(p, 111, o), true);
    assert.equal(acquireLock(p, 222, o), false);
    releaseLock(p, 999); // not the owner
    assert.equal(existsSync(p), true);
    setLockPid(p, 333);
    releaseLock(p, 333);
    assert.equal(existsSync(p), false);
    assert.equal(acquireLock(p, 222, o), true);
  } finally {
    t.done();
  }
});

test("lock: stale by age or dead pid is replaced; corrupt lock is replaced", () => {
  const t = tmp();
  try {
    const p = lockPath(t.dir, "warm", "/proj");
    let now = 1_000;
    assert.equal(acquireLock(p, 1, { staleMs: 100, now: () => now, isAlive: () => true }), true);
    now += 50;
    assert.equal(acquireLock(p, 2, { staleMs: 100, now: () => now, isAlive: () => true }), false);
    now += 100; // older than staleMs
    assert.equal(acquireLock(p, 3, { staleMs: 100, now: () => now, isAlive: () => true }), true);
    assert.equal(acquireLock(p, 4, { staleMs: 100, now: () => now, isAlive: () => false }), true); // dead pid
    writeFileSync(p, "not json");
    assert.equal(acquireLock(p, 5, { staleMs: 100, now: () => now, isAlive: () => true }), true);
  } finally {
    t.done();
  }
});

test("lock: stale takeover is exclusive under interleaving (S5 R4-warmup-no-dedupe)", () => {
  const t = tmp();
  try {
    const p = lockPath(t.dir, "warm", "/x/proj");
    acquireLock(p, 1, { staleMs: 1000 });
    writeFileSync(p, JSON.stringify({ pid: 999999, startedAt: Date.now() }));
    let b: boolean | undefined;
    const a = acquireLock(p, 111, { staleMs: 360000, isAlive: (pid) => {
      if (pid === 999999 && b === undefined) b = acquireLock(p, 222, { staleMs: 360000, isAlive: () => false });
      return pid !== 999999;
    } });
    assert.equal([a, b].filter(Boolean).length, 1);
  } finally { t.done(); }
});

test("lock: a child that exits before setLockPid leaves no lock (S5)", () => {
  const t = tmp();
  try {
    const p = lockPath(t.dir, "warm", "/x/proj");
    assert.equal(acquireLock(p, 111, { staleMs: 360000 }), true);
    releaseLock(p, 333);
    setLockPid(p, 333);
    assert.equal(existsSync(p), false);
  } finally { t.done(); }
});
