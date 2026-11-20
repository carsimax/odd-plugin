// Fault-injection harness for lock-race.spec.ts (ported from the independent verifier's race.mjs/rw.mjs/killat.mjs).
//  * main thread (spawned as a child process): `node lock-race.testkit.js killat <root> <op> <regex> <before|after>`
//    patches fs.<op> so the process SIGKILLs itself at that step, then acquires and releases the store lock.
//  * worker thread (started by the spec): patches fs.renameSync with pause points, then acquires the store lock.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isMainThread, parentPort, workerData } from "node:worker_threads";

type Patchable = Record<string, (...a: unknown[]) => unknown>;
const fsx = fs as unknown as Patchable;

export interface RenameRule {
  src: string; // regex on the root-relative source
  dst: string; // regex on the root-relative destination
  signal?: number; // event to raise when the rename is about to run
  wait?: number; // event to wait for before running it
  after?: boolean; // signal/wait AFTER the rename ran instead of before it
}
export interface WorkerData {
  sab: SharedArrayBuffer;
  rules: RenameRule[];
  root: string;
  name: string;
  holdEv?: number;
  acquiredEv?: number;
  timeoutMs?: number;
  /** Simulates a readdirSync that omits live claims: hide `LOCK.claim-*` from this many listings of the root that
   *  contain one, after skipping `hideSkip` such listings (default 1: the acquire-time sweep). Use 1e9 for "always". */
  hideClaims?: number;
  hideSkip?: number;
}

async function worker(): Promise<void> {
  const { sab, rules, root, name, holdEv, acquiredEv, timeoutMs, hideClaims, hideSkip } = workerData as WorkerData;
  const ev = new Int32Array(sab);
  const wait = (i: number): void => {
    const t0 = Date.now();
    while (Atomics.load(ev, i) === 0) {
      Atomics.wait(ev, i, 0, 50);
      if (Date.now() - t0 > 20_000) throw new Error(`${name}: wait ${i} timed out`);
    }
  };
  const set = (i: number): void => {
    Atomics.store(ev, i, 1);
    Atomics.notify(ev, i);
  };
  const orig = fsx.renameSync;
  const used = new Set<string>();
  const rel = (p: unknown): string => String(p).slice(root.length + 1);
  fsx.renameSync = (src: unknown, dst: unknown): unknown => {
    const s = rel(src);
    const d = rel(dst);
    const fire = (after: boolean): void =>
      rules.forEach((r, k) => {
        if (!!r.after === after && !used.has(`${k}`) && new RegExp(r.src).test(s) && new RegExp(r.dst).test(d)) {
          used.add(`${k}`);
          if (r.signal != null) set(r.signal);
          if (r.wait != null) wait(r.wait);
        }
      });
    fire(false);
    const result = orig.call(fs, src, dst);
    fire(true);
    return result;
  };
  if (hideClaims) {
    const origReaddir = fsx.readdirSync;
    let skip = hideSkip ?? 1;
    let hide = hideClaims;
    fsx.readdirSync = (...a: unknown[]): unknown => {
      const r = origReaddir.apply(fs, a);
      if (String(a[0]) !== root || !Array.isArray(r) || !r.some((n) => /^LOCK\.claim-/.test(String(n)))) return r;
      if (skip > 0) {
        skip--;
        return r;
      }
      if (hide <= 0) return r;
      hide--;
      return r.filter((n) => !/^LOCK\.claim-/.test(String(n)));
    };
  }
  syncBuiltinESMExports();
  const { acquireStoreLock } = await import("./lock.js");
  try {
    const h = await acquireStoreLock(root, { timeoutMs: timeoutMs ?? 8000, pollMs: 5 });
    parentPort!.postMessage({ name, acquired: h.ownerId });
    if (acquiredEv != null) set(acquiredEv);
    if (holdEv != null) wait(holdEv);
    parentPort!.postMessage({ name, released: h.release().status });
  } catch (e) {
    const err = e as Error & { blocker?: unknown };
    parentPort!.postMessage({ name, error: err.name, message: err.message, blocker: err.blocker });
  }
}

async function killat(): Promise<void> {
  const [, root, op, re, when] = process.argv.slice(2);
  const orig = fsx[op];
  fsx[op] = (...a: unknown[]): unknown => {
    const rel = (p: unknown): string => String(p).slice(root.length + 1);
    const key = op === "renameSync" ? `${rel(a[0])}>${rel(a[1])}` : rel(a[0]);
    const m = typeof a[0] === "string" && new RegExp(re).test(key);
    if (m && when === "before") process.kill(process.pid, "SIGKILL");
    const r = orig.apply(fs, a);
    if (m && when === "after") process.kill(process.pid, "SIGKILL");
    return r;
  };
  syncBuiltinESMExports();
  const { acquireStoreLock } = await import("./lock.js");
  const h = await acquireStoreLock(root, { timeoutMs: 3000 });
  h.release();
  console.log("NOT KILLED");
}

if (!isMainThread) {
  worker().catch((e) => parentPort!.postMessage({ name: "worker", error: String(e) }));
} else if (process.argv[2] === "killat") {
  killat().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
