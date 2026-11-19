import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
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
    const old = new Date(Date.now() - 10_000);
    utimesSync(p, old, old); // unreadable content is stale only when its mtime is older than staleMs
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

test("lock: an empty or corrupt FRESH lock is held (not stale); older than staleMs it is taken over", () => {
  const t = tmp();
  try {
    const p = join(t.dir, "locks", "x.lock");
    mkdirSync(join(t.dir, "locks"));
    writeFileSync(p, "");
    assert.equal(acquireLock(p, 1, { staleMs: 2000 }), false);
    assert.equal(readFileSync(p, "utf8"), "");
    const old = new Date(Date.now() - 5_000);
    utimesSync(p, old, old);
    assert.equal(acquireLock(p, 2, { staleMs: 2000 }), true);
    assert.equal(JSON.parse(readFileSync(p, "utf8")).pid, 2);
  } finally { t.done(); }
});

test("lock: acquire is atomic with content and leaves no temp or marker files; owner release leaves none", () => {
  const t = tmp();
  try {
    const p = join(t.dir, "locks", "y.lock");
    assert.equal(acquireLock(p, 7, { staleMs: 2000 }), true);
    assert.equal(JSON.parse(readFileSync(p, "utf8")).pid, 7); // content present as soon as the lock exists
    assert.equal(acquireLock(p, 8, { staleMs: 2000, isAlive: () => true }), false);
    assert.deepEqual(readdirSync(join(t.dir, "locks")), ["y.lock"]);
    releaseLock(p, 7);
    assert.deepEqual(readdirSync(join(t.dir, "locks")), []);
  } finally { t.done(); }
});

test("lock: proofOfDeathOnly never takes over a live holder by age; a dead holder is taken over", () => {
  const t = tmp();
  try {
    const p = join(t.dir, "locks", "d.lock");
    let now = 1_000;
    assert.equal(acquireLock(p, 1, { staleMs: 100, now: () => now, isAlive: () => true, proofOfDeathOnly: true }), true);
    now += 10_000; // far older than staleMs, but the pid is alive
    assert.equal(acquireLock(p, 2, { staleMs: 100, now: () => now, isAlive: () => true, proofOfDeathOnly: true }), false);
    assert.equal(JSON.parse(readFileSync(p, "utf8")).pid, 1);
    assert.equal(acquireLock(p, 3, { staleMs: 100, now: () => now, isAlive: () => false, proofOfDeathOnly: true }), true);
    assert.equal(JSON.parse(readFileSync(p, "utf8")).pid, 3);
    assert.deepEqual(readdirSync(join(t.dir, "locks")), ["d.lock"]);
  } finally {
    t.done();
  }
});

test("lock: a live takeover claimant blocks another takeover; a dead claim is swept; no claim is left behind", () => {
  const t = tmp();
  try {
    const dir = join(t.dir, "locks");
    const p = join(dir, "c.lock");
    mkdirSync(dir);
    writeFileSync(p, JSON.stringify({ pid: 999999, startedAt: 1 })); // stale: its pid is dead
    const claim = join(dir, "c.lock.claim-live");
    writeFileSync(claim, JSON.stringify({ pid: 4242 }));
    const dead = (pid: number): boolean => pid !== 4242 && pid !== 777;
    assert.equal(acquireLock(p, 777, { staleMs: 60_000, isAlive: (pid) => !dead(pid) }), false); // 4242 is alive and claiming
    assert.equal(JSON.parse(readFileSync(p, "utf8")).pid, 999999); // untouched
    assert.deepEqual(readdirSync(dir).sort(), ["c.lock", "c.lock.claim-live"]);
    writeFileSync(claim, JSON.stringify({ pid: 31337 })); // now the claimant is dead
    assert.equal(acquireLock(p, 777, { staleMs: 60_000, isAlive: (pid) => !dead(pid) }), true);
    assert.equal(JSON.parse(readFileSync(p, "utf8")).pid, 777);
    assert.deepEqual(readdirSync(dir), ["c.lock"]);
  } finally {
    t.done();
  }
});

test("lock: processes that die holding the lock never let two live holders overlap (takeover stress)", async () => {
  const t = tmp();
  try {
    const p = join(t.dir, "locks", "s.lock");
    const inside = join(t.dir, "inside");
    const overlaps = join(t.dir, "overlaps");
    const lockUrl = new URL("./lock.js", import.meta.url).href;
    const code = `
      import { acquireLock, releaseOwnedLock } from ${JSON.stringify(lockUrl)};
      import { writeFileSync, appendFileSync, rmSync } from "node:fs";
      const [p, inside, overlaps, die] = process.argv.slice(1);
      const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      const deadline = Date.now() + 30000;
      while (!acquireLock(p, process.pid, { staleMs: 2000, proofOfDeathOnly: true })) {
        if (Date.now() > deadline) process.exit(3);
        sleep(1 + Math.random() * 4);
      }
      try { writeFileSync(inside, String(process.pid), { flag: "wx" }); } catch { appendFileSync(overlaps, "x"); }
      sleep(3);
      try { rmSync(inside, { force: true }); } catch {}
      if (die !== "1") releaseOwnedLock(p, process.pid);
    `;
    const runOne = (die: boolean) =>
      new Promise<number | null>((resolve, reject) => {
        const c = spawn(process.execPath, ["--input-type=module", "-e", code, p, inside, overlaps, die ? "1" : "0"]);
        c.on("error", reject);
        c.on("close", resolve);
      });
    for (let wave = 0; wave < 12; wave++) {
      const codes = await Promise.all(Array.from({ length: 8 }, (_, i) => runOne(i % 2 === 0)));
      assert.deepEqual(codes, Array(8).fill(0), `wave ${wave}`);
    }
    assert.equal(existsSync(overlaps), false, "two processes were inside the critical section at once");
    const left = readdirSync(join(t.dir, "locks")).filter((f) => f !== "s.lock");
    assert.deepEqual(left, []);
  } finally {
    t.done();
  }
});

const lockUrl = new URL("./lock.js", import.meta.url).href;
const pausedChild = `
  import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
  const [p, ev, pause, hold, proof] = process.argv.slice(1);
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const rn = fs.renameSync; let once = false;
  fs.renameSync = function (a, b) { if (+pause && !once && a === p) { once = true; sleep(+pause); } return rn.apply(this, arguments); };
  syncBuiltinESMExports();
  const { acquireLock, releaseOwnedLock } = await import(${JSON.stringify(lockUrl)});
  const end = Date.now() + 300;
  while (!acquireLock(p, process.pid, { staleMs: 2000, proofOfDeathOnly: proof === "1" })) { if (Date.now() > end) process.exit(0); sleep(5); }
  fs.appendFileSync(ev, "+\\n"); sleep(+hold); fs.appendFileSync(ev, "-\\n"); releaseOwnedLock(p, process.pid);`;
const runPaused = (args: string[]) => new Promise<void>((r) => spawn(process.execPath, ["--input-type=module", "-e", pausedChild, ...args]).on("close", () => r()));
const maxHolders = (ev: string): number => { let n = 0, m = 0; for (const l of readFileSync(ev, "utf8").split("\n")) { if (l === "+") m = Math.max(m, ++n); if (l === "-") n--; } return m; };

test("lock: an age-based takeover never removes a fresh lock created after the old live holder released", async () => {
  const t = tmp(); const h = spawn("/bin/sleep", ["10"]);
  try {
    mkdirSync(join(t.dir, "locks")); const p = join(t.dir, "locks", "w.lock"); const ev = join(t.dir, "ev");
    writeFileSync(p, JSON.stringify({ pid: h.pid, startedAt: Date.now() - 10_000 }));
    const p1 = runPaused([p, ev, "900", "1000", "0"]);
    await new Promise((r) => setTimeout(r, 400));
    rmSync(p);
    const p3 = runPaused([p, ev, "0", "1500", "0"]);
    await Promise.all([p1, p3]);
    assert.equal(maxHolders(ev), 1, "a fresh lock was moved aside: two holders");
  } finally { h.kill(); t.done(); }
});
test("lock: a dead-pid takeover paused between re-read and move never yields two holders", async () => {
  const t = tmp();
  try {
    mkdirSync(join(t.dir, "locks")); const p = join(t.dir, "locks", "s.lock"); const ev = join(t.dir, "ev");
    writeFileSync(p, JSON.stringify({ pid: 999999, startedAt: 1 }));
    const p1 = runPaused([p, ev, "1500", "300", "1"]);
    await new Promise((r) => setTimeout(r, 200));
    await Promise.all([p1, ...Array.from({ length: 8 }, () => runPaused([p, ev, "0", "20", "1"]))]);
    assert.equal(maxHolders(ev), 1);
  } finally { t.done(); }
});
test("lock: an empty claim older than staleMs does not block a dead-pid takeover forever", () => {
  const t = tmp();
  try {
    mkdirSync(join(t.dir, "locks")); const p = join(t.dir, "locks", "e.lock");
    writeFileSync(p, JSON.stringify({ pid: 999999, startedAt: 1 }));
    writeFileSync(`${p}.claim-12345-crashed`, ""); utimesSync(`${p}.claim-12345-crashed`, new Date(0), new Date(0));
    assert.equal(acquireLock(p, process.pid, { staleMs: 2000, proofOfDeathOnly: true }), true);
    assert.deepEqual(readdirSync(join(t.dir, "locks")), ["e.lock"]);
  } finally { t.done(); }
});

test("lock: dead-pid and old unreadable .stale leftovers are swept on the next contended acquire; a live one is kept", () => {
  const t = tmp();
  try {
    const dir = join(t.dir, "locks");
    mkdirSync(dir);
    const p = join(dir, "k.lock");
    const alive = (pid: number): boolean => pid === 50 || pid === 60;
    assert.equal(acquireLock(p, 50, { staleMs: 2000, isAlive: alive }), true); // a live holder: later acquires are contended
    writeFileSync(`${p}.1.dead.stale`, JSON.stringify({ pid: 999999, startedAt: 1 }));
    writeFileSync(`${p}.1.old.stale`, "");
    utimesSync(`${p}.1.old.stale`, new Date(0), new Date(0));
    writeFileSync(`${p}.1.fresh.stale`, ""); // possibly mid-write: kept
    writeFileSync(`${p}.1.live.stale`, JSON.stringify({ pid: 60, startedAt: Date.now() }));
    assert.equal(acquireLock(p, 60, { staleMs: 2000, isAlive: alive }), false);
    assert.deepEqual(readdirSync(dir).sort(), ["k.lock", "k.lock.1.fresh.stale", "k.lock.1.live.stale"]);
    assert.equal(JSON.parse(readFileSync(p, "utf8")).pid, 50); // the lock itself is untouched
  } finally {
    t.done();
  }
});
