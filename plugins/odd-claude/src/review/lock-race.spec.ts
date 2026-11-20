import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { acquireStoreLock, StoreLockContended, StoreLockError, storeLockPath, withStoreLock } from "./lock.js";
import type { RenameRule, WorkerData } from "./lock-race.testkit.js";

const KIT = fileURLToPath(new URL("./lock-race.testkit.js", import.meta.url));
const H = hostname();

function tmp(): { dir: string; root: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "odd-store-race-"));
  const root = join(dir, "v2");
  mkdirSync(root, { recursive: true });
  return { dir, root, done: () => rmSync(dir, { recursive: true, force: true }) };
}
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
function seed(path: string, ownerId: string, pid = deadPid(), host = H): string {
  mkdirSync(path);
  writeFileSync(join(path, "owner.json"), JSON.stringify({ pid, host, ownerId, startedAt: 1 }));
  return path;
}
function age(p: string, ms: number): void {
  const t = new Date(Date.now() - ms);
  try {
    utimesSync(join(p, "owner.json"), t, t);
  } catch {
    // plain file or no owner file
  }
  utimesSync(p, t, t);
}
function safeRead(q: string): string {
  try {
    return readFileSync(q, "latin1");
  } catch {
    return "<unreadable>";
  }
}
function treeHash(p: string): string {
  const h = createHash("sha256");
  const walk = (q: string): void => {
    const st = lstatSync(q);
    h.update(`${q.slice(p.length)}:${st.mode}:${st.isDirectory() ? "" : st.isSymbolicLink() ? readlinkSync(q) : safeRead(q)}`);
    if (st.isDirectory()) for (const n of readdirSync(q).sort()) walk(join(q, n));
  };
  walk(p);
  return h.digest("hex");
}
const rec = (root: string, name = "LOCK"): { ownerId: string } => JSON.parse(readFileSync(join(root, name, "owner.json"), "utf8"));

// --- worker scenarios (ported from the verifier's race.mjs `double` and `resurrect`) ---------------------------------

interface Msg { name: string; acquired?: string; released?: string; error?: string; message?: string; blocker?: { kind: string; owner?: { pid: number } } }

function startWorker(sab: SharedArrayBuffer, root: string, name: string, rules: RenameRule[], extra: Partial<WorkerData> = {}, out: Msg[] = []): Promise<void> {
  const w = new Worker(KIT, { workerData: { sab, rules, root, name, ...extra } as WorkerData });
  return new Promise((res) => {
    w.on("message", (m: Msg) => out.push(m));
    w.on("error", (e) => {
      out.push({ name, error: `workerError ${e}` });
      res();
    });
    w.on("exit", () => res());
  });
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitEv(ev: Int32Array, i: number, label: string): Promise<void> {
  for (let k = 0; k < 500; k++) {
    if (Atomics.load(ev, i)) return;
    await sleep(10);
  }
  throw new Error(`timeout waiting ${label}`);
}
// The worker posts its message and then raises the flag, but the 'message' event can be dispatched late under load:
// wait for the message itself before reading `out`.
async function waitMsg(out: Msg[], pred: (m: Msg) => boolean, label: string): Promise<void> {
  for (let k = 0; k < 500; k++) {
    if (out.some(pred)) return;
    await sleep(10);
  }
  throw new Error(`timeout waiting message ${label}`);
}
const raise = (ev: Int32Array, i: number): void => {
  Atomics.store(ev, i, 1);
  Atomics.notify(ev, i);
};

async function pausedReclaimer(): Promise<{
  t: ReturnType<typeof tmp>; ev: Int32Array; sab: SharedArrayBuffer; out: Msg[]; c1: Promise<void>;
}> {
  const t = tmp();
  seed(storeLockPath(t.root), "X-dead-holder");
  const sab = new SharedArrayBuffer(4 * 32);
  const ev = new Int32Array(sab);
  const out: Msg[] = [];
  // C1 becomes the sole claimant and pauses right before moving the stale LOCK away.
  const c1 = startWorker(sab, t.root, "C1", [{ src: "^LOCK$", dst: "^LOCK\\.stale-", signal: 2, wait: 3 }], { acquiredEv: 8, holdEv: 12 }, out);
  await waitEv(ev, 2, "C1 holds the claim at the LOCK move");
  return { t, ev, sab, out, c1 };
}

test("F1 double: a second contender can never take over (or move) while the sole claimant is mid-takeover", { timeout: 60_000 }, async () => {
  const { t, ev, sab, out, c1 } = await pausedReclaimer();
  try {
    const before = rec(t.root).ownerId;
    assert.equal(before, "X-dead-holder");
    // C4 sees the stale LOCK and C1's live claim: it must back off, touching neither.
    await startWorker(sab, t.root, "C4", [], { timeoutMs: 400 }, out);
    const c4 = out.find((m) => m.name === "C4")!;
    assert.equal(c4.error, "StoreLockContended");
    assert.equal(c4.blocker?.kind, "reclaim", "F4: the actual blocker is the live reclaimer");
    assert.equal(c4.blocker?.owner?.pid, process.pid);
    assert.match(c4.message!, /being reclaimed by pid \d+/);
    assert.equal(rec(t.root).ownerId, "X-dead-holder", "LOCK untouched by the loser");
    assert.ok(readdirSync(t.root).some((n) => /^LOCK\.claim-[0-9a-f]{32}$/.test(n)), "C1's live claim untouched");
    raise(ev, 3);
    await waitEv(ev, 8, "C1 acquired");
    await waitMsg(out, (m) => m.name === "C1" && !!m.acquired, "C1 acquired message");
    // exactly one holder: C5 cannot get in while C1 holds.
    await startWorker(sab, t.root, "C5", [], { timeoutMs: 150 }, out);
    assert.equal(out.find((m) => m.name === "C5")!.error, "StoreLockContended");
    assert.equal(out.find((m) => m.name === "C5")!.blocker?.kind, "lock");
    assert.equal(rec(t.root).ownerId, out.find((m) => m.name === "C1" && m.acquired)!.acquired);
    assert.equal(out.filter((m) => m.acquired).length, 1);
    raise(ev, 12);
    await c1;
    await waitMsg(out, (m) => !!m.released, "C1 released message");
    assert.equal(out.find((m) => m.released)!.released, "released");
    assert.deepEqual(readdirSync(t.root), []);
  } finally {
    raise(ev, 3);
    raise(ev, 12);
    await c1;
    t.done();
  }
});

test("F2 resurrect: after a contended takeover finishes, a later dead LOCK is reclaimed within budget", { timeout: 60_000 }, async () => {
  const { t, ev, sab, out, c1 } = await pausedReclaimer();
  try {
    await startWorker(sab, t.root, "C4", [], { timeoutMs: 200 }, out);
    raise(ev, 3);
    await waitEv(ev, 8, "C1 acquired");
    await waitMsg(out, (m) => m.name === "C1" && !!m.acquired, "C1 acquired message");
    raise(ev, 12);
    await c1;
    assert.deepEqual(readdirSync(t.root), [], "nothing revived by anyone");
    seed(storeLockPath(t.root), "X2-later-crashed-holder");
    const t0 = Date.now();
    const h = await acquireStoreLock(t.root); // default 2 s budget
    assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
    assert.equal(rec(t.root).ownerId, h.ownerId);
    h.release();
    assert.deepEqual(readdirSync(t.root), []);
  } finally {
    raise(ev, 3);
    raise(ev, 12);
    await c1;
    t.done();
  }
});

// --- moveAway: sweep / mismatch between the LOCK->LOCK.stale-* rename and the re-observation -----------------------

async function pausedAfterMove(timeoutMs?: number): Promise<{
  t: ReturnType<typeof tmp>; ev: Int32Array; out: Msg[]; c1: Promise<void>; reserved: string;
}> {
  const t = tmp();
  seed(storeLockPath(t.root), "X-dead-holder");
  const sab = new SharedArrayBuffer(4 * 32);
  const ev = new Int32Array(sab);
  const out: Msg[] = [];
  // C1 (sole claimant) pauses right AFTER it renamed LOCK to LOCK.stale-*, before it observes it.
  const c1 = startWorker(sab, t.root, "C1", [{ src: "^LOCK$", dst: "^LOCK\\.stale-", after: true, signal: 2, wait: 3 }], { acquiredEv: 8, holdEv: 12, timeoutMs }, out);
  await waitEv(ev, 2, "C1 paused after the move");
  const names = readdirSync(t.root).filter((n) => /^LOCK\.stale-/.test(n));
  assert.equal(names.length, 1, `expected one reserved entry, got ${names}`);
  return { t, ev, out, c1, reserved: join(t.root, names[0]) };
}

test("moveAway: a concurrent sweep deleting owner.json of the moved dead LOCK is the same dead owner, never StoreLockError", { timeout: 60_000 }, async () => {
  const { t, ev, out, c1, reserved } = await pausedAfterMove();
  try {
    rmSync(join(reserved, "owner.json")); // what sweep() does first (owner.json before the directory)
    raise(ev, 3);
    await waitEv(ev, 8, "C1 acquired");
    await waitMsg(out, (m) => m.name === "C1" && (!!m.acquired || !!m.error), "C1 outcome message");
    const c1err = out.find((m) => m.name === "C1" && m.error);
    assert.equal(c1err, undefined, `C1 failed: ${c1err?.error} ${c1err?.message}`);
    assert.equal(out.filter((m) => m.acquired).length, 1);
    assert.equal(rec(t.root).ownerId, out.find((m) => m.acquired)!.acquired);
    raise(ev, 12);
    await c1;
    await waitMsg(out, (m) => !!m.released, "C1 released message");
    assert.equal(out.find((m) => m.released)?.released, "released");
    assert.deepEqual(readdirSync(t.root), [], "reserved entry removed");
  } finally {
    raise(ev, 3);
    raise(ev, 12);
    await c1;
    t.done();
  }
});

test("moveAway: a genuine identity mismatch is put back at LOCK (free): not lost, never two holders", { timeout: 60_000 }, async () => {
  const { t, ev, out, c1, reserved } = await pausedAfterMove(400);
  try {
    rmSync(reserved, { recursive: true });
    seed(reserved, "foreign-live", process.pid); // a different, live instance (different inode)
    raise(ev, 3);
    await c1;
    assert.equal(out.filter((m) => m.acquired).length, 0, "nobody may acquire over a live foreign record");
    assert.equal(out.find((m) => m.error)?.error, "StoreLockContended", JSON.stringify(out));
    assert.equal(rec(t.root).ownerId, "foreign-live", "foreign record restored at LOCK");
    assert.deepEqual(readdirSync(t.root), ["LOCK"], "no stranded copy");
  } finally {
    raise(ev, 3);
    raise(ev, 12);
    await c1;
    t.done();
  }
});

test("moveAway: a mismatch while LOCK is taken keeps the foreign record aside and fails closed", { timeout: 60_000 }, async () => {
  const { t, ev, out, c1, reserved } = await pausedAfterMove(400);
  try {
    rmSync(reserved, { recursive: true });
    seed(reserved, "foreign-live", process.pid);
    seed(storeLockPath(t.root), "third-live", process.pid); // someone published meanwhile
    raise(ev, 3);
    await c1;
    assert.equal(out.filter((m) => m.acquired).length, 0);
    assert.equal(out.find((m) => m.error)?.error, "StoreLockError", JSON.stringify(out));
    assert.equal(rec(t.root).ownerId, "third-live", "current LOCK untouched");
    assert.equal(rec(t.root, reserved.slice(t.root.length + 1)).ownerId, "foreign-live", "foreign record kept aside, not lost");
    // the displaced owner's next ownership check fails closed
    const lock = await import("./lock.js");
    await assert.rejects(
      lock.withStoreLock(t.root, async () => 1, { timeoutMs: 50 }),
      StoreLockContended,
    );
  } finally {
    raise(ev, 3);
    raise(ev, 12);
    await c1;
    t.done();
  }
});

// --- A1: claim exclusivity broken (a readdir that omits a live claim) must not make moveAway displace a live lock ----

// B is started while A is paused at the move (A's claim is live). Release A only once B has SETTLED: either it
// finished (backed off) or it is paused at its own move (ev 2). Never release A while B is still mid-takeover: if A
// completes (moves, drops its claim, publishes) between B's first check and its pre-move recheck, the recheck sees no
// claim and B moves A's live LOCK, which is the documented-limit scenario, not what this test pins. A timeout here is a
// test failure (starved worker), never a reason to continue.
async function waitBSettled(ev: Int32Array, B: Promise<void>, limitMs: number): Promise<void> {
  let finished = false;
  void B.then(() => {
    finished = true;
  });
  for (const t0 = Date.now(); Date.now() - t0 < limitMs; ) {
    if (finished || Atomics.load(ev, 2)) return;
    await sleep(10);
  }
  throw new Error(`B neither finished nor reached its move within ${limitMs} ms (starved worker?): refusing to release A while B is mid-takeover`);
}

async function brokenExclusivity(hideClaims: number): Promise<{ out: Msg[]; leftovers: string[] }> {
  const t = tmp();
  seed(storeLockPath(t.root), "D-dead-holder");
  const sab = new SharedArrayBuffer(4 * 32);
  const ev = new Int32Array(sab);
  const out: Msg[] = [];
  const pause = { src: "^LOCK$", dst: "^LOCK\\.stale-" };
  const A = startWorker(sab, t.root, "A", [{ ...pause, signal: 6, wait: 7 }], { acquiredEv: 8, holdEv: 12 }, out);
  let B: Promise<void> = Promise.resolve();
  let C: Promise<void> = Promise.resolve();
  try {
    await waitEv(ev, 6, "A (sole claimant) at the move");
    // B cannot see A's claim on its claim listing, so it believes it is alone.
    B = startWorker(sab, t.root, "B", [{ ...pause, signal: 2, wait: 3 }, { ...pause, after: true, signal: 4, wait: 5 }], { hideClaims, timeoutMs: 300 }, out);
    await waitBSettled(ev, B, 20_000);
    raise(ev, 7); // A moves the dead lock, publishes and holds
    await waitEv(ev, 8, "A acquired");
    await waitMsg(out, (m) => m.name === "A" && (!!m.acquired || !!m.error), "A outcome message");
    raise(ev, 3);
    if (Atomics.load(ev, 2)) await waitEv(ev, 4, "B moved A's live LOCK aside");
    C = startWorker(sab, t.root, "C", [], { timeoutMs: 300 }, out);
    await C;
    return { out: [...out], leftovers: readdirSync(t.root) };
  } finally {
    for (const i of [3, 5, 7, 12]) raise(ev, i);
    await Promise.all([A, B, C]);
    t.done();
  }
}

test("A1: with a live claim hidden from the first claim listing, the pre-move recheck makes B back off: one holder", { timeout: 60_000 }, async () => {
  const { out } = await brokenExclusivity(1);
  assert.deepEqual(out.filter((m) => m.acquired).map((m) => m.name), ["A"], `holders: ${JSON.stringify(out)}`);
  assert.equal(out.find((m) => m.name === "B")?.error, "StoreLockContended", JSON.stringify(out));
  assert.equal(out.find((m) => m.name === "C")?.error, "StoreLockContended", JSON.stringify(out));
});

test("A1 (documented limit): claims hidden on EVERY listing cannot be closed without a no-replace rename", { timeout: 30_000, todo: "needs renamex_np RENAME_EXCL / renameat2, which Node does not expose" }, async () => {
  const { out } = await brokenExclusivity(1e9);
  assert.deepEqual(out.filter((m) => m.acquired).map((m) => m.name), ["A"], `holders: ${JSON.stringify(out)}`);
});

// --- edge-case table (ported from edge.mjs) -------------------------------------------------------------------------

type Want = "ACQUIRED" | "Contended" | "StoreLockError";
async function outcome(root: string, fn: () => Promise<{ release(): unknown }>): Promise<{ got: Want | string; ms: number; same: boolean }> {
  const before = treeHash(root);
  const t0 = performance.now();
  let got: string;
  try {
    (await fn()).release();
    got = "ACQUIRED";
  } catch (e) {
    got = e instanceof StoreLockContended ? "Contended" : e instanceof StoreLockError ? "StoreLockError" : `OTHER:${(e as Error).name}`;
  }
  return { got, ms: performance.now() - t0, same: treeHash(root) === before };
}
const mkLock = (root: string, rec?: unknown, raw?: string): string => {
  const l = storeLockPath(root);
  mkdirSync(l);
  if (rec !== undefined || raw !== undefined) writeFileSync(join(l, "owner.json"), raw ?? JSON.stringify(rec));
  return l;
};
const claimName = (root: string) => join(root, `LOCK.claim-${"ab".repeat(16)}`);

interface Edge { label: string; want: Want; unchanged: boolean; setup: (root: string) => void; opts?: { timeoutMs?: number; staleUnreadableMs?: number }; skipRoot?: boolean }
const EDGES: Edge[] = [
  { label: "3a live pid aged 1 day", want: "Contended", unchanged: true, setup: (r) => age(mkLock(r, { pid: process.pid, host: H, ownerId: "live", startedAt: 1 }), 864e5) },
  { label: "3b pid 1 (EPERM => alive)", want: "Contended", unchanged: true, setup: (r) => age(mkLock(r, { pid: 1, host: H, ownerId: "eperm", startedAt: 1 }), 864e5) },
  { label: "3c other host, dead pid, aged", want: "Contended", unchanged: true, setup: (r) => age(mkLock(r, { pid: deadPid(), host: "other.invalid", ownerId: "remote", startedAt: 1 }), 864e5) },
  ...[["empty", ""], ["{}", "{}"], ["garbage", "\u0000\u0001zz"]].map(([n, raw]): Edge => ({
    label: `3d fresh unreadable (${n})`, want: "Contended", unchanged: true, setup: (r) => void mkLock(r, undefined, raw),
  })),
  ...[["pid string", (p: number) => ({ pid: String(p), host: H, ownerId: "x", startedAt: 1 })], ["pid 0", () => ({ pid: 0, host: H, ownerId: "x", startedAt: 1 })], ["ownerId empty", (p: number) => ({ pid: p, host: H, ownerId: "", startedAt: 1 })]].map(([n, f]): Edge => ({
    label: `3d fresh unreadable (${n as string})`, want: "Contended", unchanged: true, setup: (r) => void mkLock(r, (f as (p: number) => unknown)(deadPid())),
  })),
  { label: "3d fresh dir without owner.json", want: "Contended", unchanged: true, setup: (r) => void mkLock(r) },
  { label: "3e LOCK plain file, fresh", want: "Contended", unchanged: true, setup: (r) => writeFileSync(storeLockPath(r), "junk") },
  { label: "3e plain file aged 59 min, staleUnreadableMs 1 h", want: "Contended", unchanged: true, opts: { staleUnreadableMs: 3600e3 }, setup: (r) => { writeFileSync(storeLockPath(r), "junk"); age(storeLockPath(r), 59 * 60e3); } },
  { label: "3e plain file older than 30 s -> taken over", want: "ACQUIRED", unchanged: true, setup: (r) => { writeFileSync(storeLockPath(r), "junk"); age(storeLockPath(r), 60e3); } },
  { label: "3f LOCK symlink -> live foreign dir", want: "Contended", unchanged: true, setup: (r) => {
    const tgt = join(r, "..", "foreign");
    seed(tgt, "sym", process.pid);
    symlinkSync(tgt, storeLockPath(r));
  } },
  { label: "3h dead LOCK but LIVE claim", want: "Contended", unchanged: true, setup: (r) => { seed(storeLockPath(r), "X"); seed(claimName(r), "liveclaim", process.pid); } },
  { label: "3h dead LOCK, fresh plain-file claim", want: "Contended", unchanged: true, setup: (r) => { seed(storeLockPath(r), "X"); writeFileSync(claimName(r), ""); } },
  { label: "3h dead LOCK, old plain-file claim -> recovered", want: "ACQUIRED", unchanged: true, setup: (r) => { seed(storeLockPath(r), "X"); writeFileSync(claimName(r), ""); age(claimName(r), 60e3); } },
  { label: "3h dead LOCK, dead claim -> recovered", want: "ACQUIRED", unchanged: true, setup: (r) => { seed(storeLockPath(r), "X"); seed(claimName(r), "deadclaim"); } },
  { label: "5b EACCES root (0500)", want: "StoreLockError", unchanged: true, skipRoot: true, setup: (r) => chmodSync(r, 0o500) },
  { label: "5c EACCES on owner.json (no takeover)", want: "StoreLockError", unchanged: true, skipRoot: true, setup: (r) => { const l = seed(storeLockPath(r), "X"); chmodSync(join(l, "owner.json"), 0); } },
];

for (const e of EDGES) {
  test(`edge ${e.label}`, { skip: e.skipRoot && process.getuid?.() === 0 }, async () => {
    const t = tmp();
    try {
      e.setup(t.root);
      // tree hash must be taken after setup; "unchanged" compares around acquire+release only
      const base = e.want === "ACQUIRED" ? undefined : treeHash(t.root);
      const o = await outcome(t.root, () => acquireStoreLock(t.root, { timeoutMs: 200, ...e.opts }));
      assert.equal(o.got, e.want);
      if (e.want === "ACQUIRED") assert.deepEqual(readdirSync(t.root).filter((n) => n === "LOCK" || n.startsWith("LOCK.claim-")), [], "nothing held afterwards");
      else assert.equal(treeHash(t.root), base, "tree unchanged on refusal");
      assert.ok(o.ms < 2500);
    } finally {
      try { chmodSync(t.root, 0o700); } catch { /* gone */ }
      t.done();
    }
  });
}

test("edge 5b EACCES on the parent of a missing root", { skip: process.getuid?.() === 0 }, async () => {
  const t = tmp();
  try {
    chmodSync(t.root, 0o500);
    await assert.rejects(acquireStoreLock(join(t.root, "sub", "v2"), { timeoutMs: 200 }), StoreLockError);
    assert.deepEqual(readdirSync(t.root), []);
  } finally {
    chmodSync(t.root, 0o700);
    t.done();
  }
});

test("edge 4a release by a non-owner leaves the tree unchanged", async () => {
  const t = tmp();
  try {
    const a = await acquireStoreLock(t.root);
    rmSync(storeLockPath(t.root), { recursive: true });
    mkLock(t.root, { pid: process.pid, host: H, ownerId: "B", startedAt: 1 });
    const before = treeHash(t.root);
    assert.deepEqual(a.release(), { status: "not-owner" });
    assert.equal(treeHash(t.root), before);
  } finally {
    t.done();
  }
});

test("edge 4b/4c/4d withStoreLock: lock replaced / removed mid-fn fails closed; the fn error wins", async () => {
  const t = tmp();
  try {
    await assert.rejects(
      withStoreLock(t.root, () => {
        rmSync(storeLockPath(t.root), { recursive: true });
        mkLock(t.root, { pid: process.pid, host: H, ownerId: "B", startedAt: 1 });
        return 1;
      }),
      StoreLockError,
    );
    assert.equal(rec(t.root).ownerId, "B", "B intact");
    rmSync(storeLockPath(t.root), { recursive: true });
    await assert.rejects(withStoreLock(t.root, () => { rmSync(storeLockPath(t.root), { recursive: true }); return 1; }), StoreLockError);
    await assert.rejects(withStoreLock(t.root, () => { rmSync(storeLockPath(t.root), { recursive: true }); throw new Error("fn-boom"); }), /fn-boom/);
  } finally {
    t.done();
  }
});

test("edge 5a default budget (2 s) contended, bounded", async () => {
  const t = tmp();
  try {
    const h = await acquireStoreLock(t.root);
    const t0 = Date.now();
    await assert.rejects(acquireStoreLock(t.root), StoreLockContended);
    const ms = Date.now() - t0;
    assert.ok(ms >= 1900 && ms < 3500, `ms ${ms}`);
    h.release();
  } finally {
    t.done();
  }
});

// --- F3 sweep ---------------------------------------------------------------------------------------------------------

test("F3 sweep: dead-owner leftovers are removed at acquire; live/fresh/other-host entries and LOCK are not touched", async () => {
  const t = tmp();
  try {
    const dead = deadPid();
    seed(join(t.root, "LOCK.tmp-aa"), "a", dead);
    seed(join(t.root, "LOCK.stale-bb"), "b", dead);
    seed(join(t.root, "LOCK.release-cc"), "c", dead);
    seed(claimName(t.root), "d", dead);
    seed(join(t.root, "LOCK.reclaim"), "e", dead); // legacy guard name
    seed(join(t.root, "LOCK.tmp-live"), "f", process.pid);
    seed(join(t.root, "LOCK.stale-remote"), "g", dead, "other.invalid");
    mkdirSync(join(t.root, "LOCK.tmp-fresh-empty"));
    mkdirSync(join(t.root, "LOCK.tmp-old-empty"));
    age(join(t.root, "LOCK.tmp-old-empty"), 3600e3);
    writeFileSync(join(t.root, "unrelated"), "x");
    const h = await acquireStoreLock(t.root);
    assert.deepEqual(readdirSync(t.root).sort(), ["LOCK", "LOCK.stale-remote", "LOCK.tmp-fresh-empty", "LOCK.tmp-live", "unrelated"]);
    h.release();
  } finally {
    t.done();
  }
});

test("F3 sweep is bounded per acquire (64 entries)", async () => {
  const t = tmp();
  try {
    const dead = deadPid();
    for (let i = 0; i < 100; i++) seed(join(t.root, `LOCK.stale-${String(i).padStart(3, "0")}`), `o${i}`, dead);
    (await acquireStoreLock(t.root)).release();
    assert.equal(readdirSync(t.root).length, 36);
    (await acquireStoreLock(t.root)).release();
    assert.deepEqual(readdirSync(t.root), []);
  } finally {
    t.done();
  }
});

// --- kill -9 at each step (ported from kills.sh/killat.mjs) ----------------------------------------------------------

const STEPS: Array<[label: string, stale: boolean, op: string, re: string, when: "before" | "after"]> = [];
const protocol: Array<[string, boolean, string, string]> = [
  ["publish: mkdir tmp", false, "mkdirSync", "^LOCK\\.tmp-[0-9a-f]+$"],
  ["publish: owner.json opened", false, "openSync", "^LOCK\\.tmp-[0-9a-f]+/owner\\.json$"],
  ["publish: rename tmp -> LOCK", false, "renameSync", ">LOCK$"],
  ["release: LOCK -> release-", false, "renameSync", "^LOCK>LOCK\\.release-"],
  ["release: rm release-", false, "rmSync", "^LOCK\\.release-"],
  ["claim: mkdir tmp", true, "mkdirSync", "^LOCK\\.claim-[0-9a-f]+\\.tmp-"],
  ["claim: rename tmp -> claim", true, "renameSync", "^LOCK\\.claim-[0-9a-f]+\\.tmp-[0-9a-f]+>LOCK\\.claim-[0-9a-f]+$"],
  ["takeover: LOCK -> stale-", true, "renameSync", "^LOCK>LOCK\\.stale-"],
  ["takeover: rm stale-", true, "rmSync", "^LOCK\\.stale-"],
  ["claim release: claim -> release-", true, "renameSync", "^LOCK\\.claim-[0-9a-f]{32}>LOCK\\.claim-[0-9a-f]{32}\\.release-"],
  ["claim release: rm", true, "rmSync", "^LOCK\\.claim-[0-9a-f]{32}\\.release-"],
];
for (const [l, stale, op, re] of protocol) for (const when of ["before", "after"] as const) STEPS.push([`${l} (${when})`, stale, op, re, when]);

test("kill -9 at every protocol step: the next default acquire owns within 500 ms", { timeout: 120_000 }, async () => {
  const run = async ([label, stale, op, re, when]: (typeof STEPS)[number]): Promise<string[]> => {
    const t = tmp();
    const problems: string[] = [];
    try {
      if (stale) seed(storeLockPath(t.root), "X", deadPid());
      const sig = await new Promise<string | null>((resolve) => {
        const c = spawn(process.execPath, [KIT, "killat", t.root, op, re, when], { stdio: "ignore" });
        c.on("exit", (_code, signal) => resolve(signal));
      });
      if (sig !== "SIGKILL") problems.push(`${label}: child was not killed (${sig}); step never matched`);
      const t0 = Date.now();
      let h;
      try {
        h = await acquireStoreLock(t.root);
      } catch (e) {
        problems.push(`${label}: next acquire failed: ${(e as Error).message}`);
        return problems;
      }
      const ms = Date.now() - t0;
      if (ms >= 500) problems.push(`${label}: next acquire took ${ms} ms`);
      if (rec(t.root).ownerId !== h.ownerId) problems.push(`${label}: not the owner`);
      if (h.release().status !== "released") problems.push(`${label}: release not released`);
      const left = readdirSync(t.root);
      if (left.some((n) => n === "LOCK" || /^LOCK\.claim-[0-9a-f]{32}$/.test(n))) problems.push(`${label}: lock/claim left: ${left}`);
      if (left.some((n) => !/^LOCK\.(tmp|stale|release|claim)-/.test(n))) problems.push(`${label}: unexpected entries ${left}`);
      // and nothing is stuck for the one after (leftovers are inert)
      (await acquireStoreLock(t.root, { timeoutMs: 300 })).release();
    } finally {
      t.done();
    }
    return problems;
  };
  const all = (await Promise.all(STEPS.map(run))).flat();
  assert.deepEqual(all, []);
});

test("kill -9 of a reclaimer holding its claim: LOCK stays reclaimable (nothing is resurrected)", { timeout: 60_000 }, async () => {
  const t = tmp();
  try {
    seed(storeLockPath(t.root), "X", deadPid());
    await new Promise<void>((resolve) => {
      const c = spawn(process.execPath, [KIT, "killat", t.root, "renameSync", "^LOCK>LOCK\\.stale-", "before"], { stdio: "ignore" });
      c.on("exit", () => resolve());
    });
    assert.ok(readdirSync(t.root).some((n) => /^LOCK\.claim-/.test(n)), "dead claimant's claim is left behind");
    const t0 = Date.now();
    (await acquireStoreLock(t.root)).release();
    assert.ok(Date.now() - t0 < 500);
    seed(storeLockPath(t.root), "X3", deadPid());
    const t1 = Date.now();
    (await acquireStoreLock(t.root)).release();
    assert.ok(Date.now() - t1 < 500);
    assert.deepEqual(readdirSync(t.root), []);
  } finally {
    t.done();
  }
});

// --- review follow-ups (M1-M3) ----------------------------------------------------------------------------------------

test("M1: a sweep that deletes the fresh LOCK.stale-* of a concurrent taker never surfaces a StoreLockError", { timeout: 60_000 }, async () => {
  const t = tmp();
  try {
    seed(storeLockPath(t.root), "X-dead-holder");
    const sab = new SharedArrayBuffer(4 * 32);
    const ev = new Int32Array(sab);
    const out: Msg[] = [];
    // A pauses AFTER renaming LOCK -> LOCK.stale-*.
    const a = startWorker(sab, t.root, "A", [{ src: "^LOCK$", dst: "^LOCK\\.stale-", signal: 2, wait: 3, after: true }], { timeoutMs: 400 }, out);
    await waitEv(ev, 2, "A renamed LOCK away");
    const b = await acquireStoreLock(t.root, { timeoutMs: 1000 }); // its sweep sees A's moved-away dead lock
    raise(ev, 3);
    await a;
    const msg = out.find((m) => m.name === "A")!;
    assert.ok(msg.acquired !== undefined || msg.error === "StoreLockContended", `A: ${JSON.stringify(msg)}`);
    assert.notEqual(msg.error, "StoreLockError");
    assert.equal(rec(t.root).ownerId, b.ownerId, "B holds LOCK");
    assert.equal(b.release().status, "released");
  } finally {
    t.done();
  }
});

// The elapsed time is measured INSIDE the child around the acquire call, so Node startup under load
// (which can exceed 1 s) does not count; the spawnSync timeout is only a hang backstop.
function childAcquire(root: string, timeoutMs: number): { status: number | null; signal: NodeJS.Signals | null; ms: number; outcome: string } {
  const url = pathToFileURL(fileURLToPath(new URL("./lock.js", import.meta.url))).href;
  const code = `import(${JSON.stringify(url)}).then(async (m) => { const t0 = performance.now(); let outcome; try { const l = await m.acquireStoreLock(${JSON.stringify(root)}, { timeoutMs: ${timeoutMs} }); const ms = performance.now() - t0; l.release(); console.log(JSON.stringify({ outcome: "acquired", ms })); return; } catch (e) { outcome = e.name; } console.log(JSON.stringify({ outcome, ms: performance.now() - t0 })); });`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 10000 });
  const parsed = r.stdout.trim() ? (JSON.parse(r.stdout.trim()) as { outcome: string; ms: number }) : { outcome: "", ms: Number.POSITIVE_INFINITY };
  return { status: r.status, signal: r.signal, ms: parsed.ms, outcome: parsed.outcome };
}

test("M2: a FIFO or a symlink to /dev/zero as owner.json is unreadable, never read to the end", { skip: process.platform === "win32" }, () => {
  const fifo = tmp();
  try {
    mkdirSync(storeLockPath(fifo.root));
    assert.equal(spawnSync("mkfifo", [join(storeLockPath(fifo.root), "owner.json")]).status, 0);
    const r = childAcquire(fifo.root, 300);
    assert.equal(r.status, 0, "child exited normally");
    assert.equal(r.signal, null, "child was not killed by the backstop timeout");
    assert.equal(r.outcome, "StoreLockContended");
    assert.ok(r.ms < 1000, `acquire took ${r.ms} ms`);
  } finally {
    fifo.done();
  }
  const zero = tmp();
  try {
    mkdirSync(storeLockPath(zero.root));
    symlinkSync("/dev/zero", join(storeLockPath(zero.root), "owner.json"));
    const r = childAcquire(zero.root, 300);
    assert.equal(r.status, 0, "child exited normally");
    assert.equal(r.signal, null, "child was not killed by the backstop timeout");
    assert.equal(r.outcome, "StoreLockContended");
    assert.ok(r.ms < 1000, `acquire took ${r.ms} ms`);
  } finally {
    zero.done();
  }
});

test("M3: a fresh unreadable claim blocking the reclaim does not blame the dead holder's pid", async () => {
  const t = tmp();
  try {
    const dead = deadPid();
    seed(storeLockPath(t.root), "X-dead", dead);
    mkdirSync(join(t.root, `LOCK.claim-${"a".repeat(32)}`)); // fresh, no owner record
    await assert.rejects(acquireStoreLock(t.root, { timeoutMs: 200, pollMs: 20 }), (e: unknown) => {
      assert.ok(e instanceof StoreLockContended);
      assert.equal(e.blocker?.kind, "reclaim");
      assert.equal(e.blocker?.owner, undefined);
      assert.equal(e.owner, undefined);
      assert.ok(!e.message.includes(`pid ${dead}`), e.message);
      return true;
    });
    assert.equal(rec(t.root).ownerId, "X-dead", "LOCK untouched");
  } finally {
    t.done();
  }
});
