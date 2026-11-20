import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireStoreLock, StoreLockContended, StoreLockError, storeLockPath, withStoreLock } from "./lock.js";

const CHILD = fileURLToPath(new URL("./lock-child.testkit.js", import.meta.url));

function tmp(): { dir: string; root: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "odd-store-lock-"));
  return { dir, root: join(dir, "odd-plugin", "review-transactions", "v2"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A pid that is certainly dead: a child that already exited and was reaped (validated, retried). */
function deadPid(): number {
  // A pid that exited and was reaped. Validated: spawnSync can fail under load (stdout "" -> 0) and a pid can be reused.
  for (let i = 0; i < 20; i++) {
    const pid = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not obtain a dead pid");
}

function seedLock(root: string, owner: unknown, raw?: string): string {
  const lock = storeLockPath(root);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), raw ?? JSON.stringify(owner));
  return lock;
}

function age(path: string, ms: number): void {
  const t = new Date(Date.now() - ms);
  utimesSync(join(path, "owner.json"), t, t);
  utimesSync(path, t, t);
}

const dead = (pid: number) => ({ pid, host: hostname(), ownerId: "deadbeef", startedAt: 1 });

test("acquire writes the owner record; release removes everything", async () => {
  const t = tmp();
  try {
    const before = Date.now();
    const h = await acquireStoreLock(t.root);
    const rec = JSON.parse(readFileSync(join(storeLockPath(t.root), "owner.json"), "utf8"));
    assert.equal(rec.pid, process.pid);
    assert.equal(rec.host, hostname());
    assert.match(rec.ownerId, /^[0-9a-f]{32}$/);
    assert.ok(rec.startedAt >= before && rec.startedAt <= Date.now());
    assert.equal(rec.ownerId, h.ownerId);
    assert.deepEqual(readdirSync(t.root), ["LOCK"]);
    assert.deepEqual(h.release(), { status: "released" });
    assert.deepEqual(readdirSync(t.root), []);
    // reusable
    const h2 = await acquireStoreLock(t.root);
    assert.notEqual(h2.ownerId, h.ownerId);
    h2.release();
  } finally {
    t.done();
  }
});

test("contention: bounded wait then StoreLockContended; holder untouched", async () => {
  const t = tmp();
  try {
    const h = await acquireStoreLock(t.root);
    const t0 = Date.now();
    await assert.rejects(
      acquireStoreLock(t.root, { timeoutMs: 300, pollMs: 25 }),
      (e: unknown) => {
        assert.ok(e instanceof StoreLockContended);
        assert.ok(!(e instanceof StoreLockError));
        assert.equal((e as StoreLockContended).owner?.ownerId, h.ownerId);
        return true;
      },
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 280 && elapsed < 1500, `elapsed ${elapsed}`);
    assert.deepEqual(readdirSync(t.root), ["LOCK"]);
    assert.equal(JSON.parse(readFileSync(join(storeLockPath(t.root), "owner.json"), "utf8")).ownerId, h.ownerId);
    h.release();
  } finally {
    t.done();
  }
});

test("default start budget is 2 s (timeoutMs=0 tries exactly once)", async () => {
  const t = tmp();
  try {
    const h = await acquireStoreLock(t.root);
    const t0 = Date.now();
    await assert.rejects(acquireStoreLock(t.root, { timeoutMs: 0 }), StoreLockContended);
    assert.ok(Date.now() - t0 < 200);
    h.release();
  } finally {
    t.done();
  }
});

test("release by a non-owner is a no-op with a typed result", async () => {
  const t = tmp();
  try {
    const a = await acquireStoreLock(t.root);
    assert.deepEqual(a.release(), { status: "released" });
    const b = await acquireStoreLock(t.root);
    assert.deepEqual(a.release(), { status: "not-owner" }); // stale handle, someone else owns
    assert.equal(JSON.parse(readFileSync(join(storeLockPath(t.root), "owner.json"), "utf8")).ownerId, b.ownerId);
    assert.deepEqual(b.release(), { status: "released" });
    assert.deepEqual(b.release(), { status: "absent" });
    assert.deepEqual(readdirSync(t.root), []);
  } finally {
    t.done();
  }
});

test("stale takeover: dead pid on the same host", async () => {
  const t = tmp();
  try {
    seedLock(t.root, dead(deadPid()));
    const h = await acquireStoreLock(t.root, { timeoutMs: 500 });
    const rec = JSON.parse(readFileSync(join(storeLockPath(t.root), "owner.json"), "utf8"));
    assert.equal(rec.ownerId, h.ownerId);
    assert.equal(rec.pid, process.pid);
    assert.deepEqual(readdirSync(t.root), ["LOCK"]);
    h.release();
    assert.deepEqual(readdirSync(t.root), []);
  } finally {
    t.done();
  }
});

test("no takeover: live pid, other host with a dead pid", async () => {
  const t = tmp();
  try {
    seedLock(t.root, { pid: process.pid, host: hostname(), ownerId: "live", startedAt: 1 });
    age(storeLockPath(t.root), 3_600_000); // age alone never matters for a readable record
    await assert.rejects(acquireStoreLock(t.root, { timeoutMs: 100 }), StoreLockContended);
    rmSync(storeLockPath(t.root), { recursive: true });
    seedLock(t.root, { pid: deadPid(), host: "some-other-host.invalid", ownerId: "remote", startedAt: 1 });
    age(storeLockPath(t.root), 3_600_000);
    await assert.rejects(acquireStoreLock(t.root, { timeoutMs: 100 }), StoreLockContended);
    assert.equal(JSON.parse(readFileSync(join(storeLockPath(t.root), "owner.json"), "utf8")).ownerId, "remote");
    assert.deepEqual(readdirSync(t.root), ["LOCK"]);
  } finally {
    t.done();
  }
});

test("unreadable owner record: not stale while fresh, stale once old", async () => {
  const t = tmp();
  try {
    for (const raw of ["", "{not json", JSON.stringify({ pid: "x" }), JSON.stringify({ pid: deadPid(), host: hostname() })]) {
      const lock = seedLock(t.root, undefined, raw);
      await assert.rejects(acquireStoreLock(t.root, { timeoutMs: 100 }), StoreLockContended, `fresh ${JSON.stringify(raw)}`);
      assert.ok(existsSync(lock));
      age(lock, 3_600_000);
      const h = await acquireStoreLock(t.root, { timeoutMs: 500 });
      assert.deepEqual(readdirSync(t.root), ["LOCK"]);
      h.release();
    }
    // directory without any owner file
    const lock = storeLockPath(t.root);
    mkdirSync(lock, { recursive: true });
    await assert.rejects(acquireStoreLock(t.root, { timeoutMs: 100 }), StoreLockContended);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lock, old, old);
    (await acquireStoreLock(t.root, { timeoutMs: 500 })).release();
    assert.deepEqual(readdirSync(t.root), []);
  } finally {
    t.done();
  }
});

test("a leftover claim from a dead contender does not block takeover", async () => {
  const t = tmp();
  try {
    seedLock(t.root, dead(deadPid()));
    const guard = `${storeLockPath(t.root)}.claim-${"ab".repeat(16)}`;
    mkdirSync(guard);
    writeFileSync(join(guard, "owner.json"), JSON.stringify({ pid: deadPid(), host: hostname(), ownerId: "g", startedAt: 1 }));
    const h = await acquireStoreLock(t.root, { timeoutMs: 1000 });
    assert.deepEqual(readdirSync(t.root), ["LOCK"]);
    h.release();
    assert.deepEqual(readdirSync(t.root), []);
  } finally {
    t.done();
  }
});

function runChild(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CHILD, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ code, stderr })); // 'close' = stdio drained, stderr complete
  });
}

async function hammer(root: string, withStale: boolean): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "odd-store-lock-ctr-"));
  try {
    const counter = join(dir, "counter");
    const marker = join(dir, "inside");
    const log = join(dir, "overlap.log");
    writeFileSync(counter, "0");
    writeFileSync(log, "");
    if (withStale) seedLock(root, dead(deadPid()));
    const N = 6;
    const ITER = 15;
    const results = await Promise.all(Array.from({ length: N }, () => runChild(["loop", root, counter, String(ITER), marker, log])));
    results.forEach((r, i) => {
      assert.equal(r.code, 0, `child ${i} exit code ${r.code}; stderr: ${r.stderr}`);
      assert.equal(r.stderr, "", `child ${i} wrote to stderr`);
    });
    assert.equal(readFileSync(log, "utf8"), "", "overlap or foreign release detected");
    assert.equal(Number(readFileSync(counter, "utf8")), N * ITER, "counter lost updates");
    assert.equal(existsSync(marker), false, "marker left behind");
    assert.deepEqual(readdirSync(root), [], "store root not clean");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("exclusivity under real process concurrency (counter exact, no overlap, no leftovers)", { timeout: 120_000 }, async () => {
  const t = tmp();
  try {
    mkdirSync(t.root, { recursive: true });
    await hammer(t.root, false);
  } finally {
    t.done();
  }
});

test("concurrent contenders racing one stale takeover: exactly one wins at a time", { timeout: 120_000 }, async () => {
  const t = tmp();
  try {
    mkdirSync(t.root, { recursive: true });
    await hammer(t.root, true);
  } finally {
    t.done();
  }
});

test("crash simulation: kill -9 of the holder, next acquirer takes over", { timeout: 60_000 }, async () => {
  const t = tmp();
  try {
    mkdirSync(t.root, { recursive: true });
    const ready = join(t.dir, "ready");
    const child = spawn(process.execPath, [CHILD, "hold", t.root, ready], { stdio: "ignore" });
    const exited = new Promise<void>((r) => child.on("exit", () => r()));
    for (let i = 0; i < 400 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(existsSync(ready), "child never acquired");
    const held = JSON.parse(readFileSync(join(storeLockPath(t.root), "owner.json"), "utf8"));
    assert.equal(held.pid, child.pid);
    await assert.rejects(acquireStoreLock(t.root, { timeoutMs: 100 }), StoreLockContended); // alive: no takeover
    child.kill("SIGKILL");
    await exited;
    const h = await acquireStoreLock(t.root, { timeoutMs: 1000 });
    const rec = JSON.parse(readFileSync(join(storeLockPath(t.root), "owner.json"), "utf8"));
    assert.equal(rec.pid, process.pid);
    assert.notEqual(rec.ownerId, held.ownerId);
    assert.deepEqual(readdirSync(t.root), ["LOCK"]);
    h.release();
    assert.deepEqual(readdirSync(t.root), []);
  } finally {
    t.done();
  }
});

test("fail closed: unexpected FS error throws StoreLockError, never ownership", async () => {
  const t = tmp();
  try {
    mkdirSync(t.dir, { recursive: true });
    const blocker = join(t.dir, "blocker");
    writeFileSync(blocker, "x");
    await assert.rejects(
      acquireStoreLock(join(blocker, "v2")),
      (e: unknown) => e instanceof StoreLockError && !(e instanceof StoreLockContended),
    );
    // LOCK that is a plain file: unreadable and fresh -> contended, never acquired
    mkdirSync(t.root, { recursive: true });
    writeFileSync(storeLockPath(t.root), "junk");
    await assert.rejects(acquireStoreLock(t.root, { timeoutMs: 50 }), StoreLockContended);
    assert.equal(readFileSync(storeLockPath(t.root), "utf8"), "junk");
  } finally {
    t.done();
  }
});

test("withStoreLock releases on success and on throw", async () => {
  const t = tmp();
  try {
    assert.equal(await withStoreLock(t.root, async () => 42), 42);
    assert.deepEqual(readdirSync(t.root), []);
    await assert.rejects(withStoreLock(t.root, async () => { throw new Error("boom"); }), /boom/);
    assert.deepEqual(readdirSync(t.root), []);
  } finally {
    t.done();
  }
});
