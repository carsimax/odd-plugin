// Exclusive store lock for the review authority store (`<git-common-dir>/odd-plugin/review-transactions/v2/`).
// Equivalent of the Go `v2/LOCK` flock(LOCK_EX|LOCK_NB) + bounded start wait (2 s, 25 ms polling). Node has no
// flock, so the lock is a DIRECTORY `<root>/LOCK` that always contains `owner.json`:
//   * publish: build `LOCK.tmp-<ownerId>/owner.json` (fsynced), then rename it to `LOCK`. rename(2) of a directory onto
//     an existing non-empty directory fails (ENOTEMPTY/EEXIST), so exactly one contender wins and no reader ever
//     sees a lock without its owner record.
//   * release: only by the owner token; the lock is renamed to a unique name (so it vanishes atomically) and removed.
//   * stale takeover needs PROOF: same host AND kill(pid,0) -> ESRCH. Never by pid across hosts, never by age for a
//     readable record. An unreadable/empty record (or a lock that is not a directory) is stale only when older than
//     `staleUnreadableMs` (a fresh one may be a writer in progress or foreign).
//   * takeover exclusivity WITHOUT a shared mutable guard name: every contender that sees a stale LOCK publishes its
//     own claim `LOCK.claim-<ownerId>` (unique name, so a claim can never be replaced by another process: no ABA) and
//     proceeds only when it is ALONE among live claims (each publishes before it lists, so two contenders can never
//     both see themselves alone; losers back off with jitter). Dead claims (same host, ESRCH) are removed by
//     rename-then-rm, which is safe precisely because the name is unique and its owner is dead. Only the sole live
//     claimant re-observes LOCK (same identity, still stale) and moves it away. A stale owner cannot release, and a
//     normal acquire cannot publish while LOCK exists, so nothing can replace the stale instance meanwhile.
//     `moveAway` re-lists the claims right before the move (a second line of defence if one listing missed a claim).
//     There is NO move->check->restore path anywhere: a restore could resurrect a dead entry or displace a live one.
//     A moved lock that is the same directory inode as the one judged stale is that dead owner (even if a concurrent
//     sweep already removed its owner.json): it is removed. If it is anything else (only possible under foreign
//     tampering) it is put back at LOCK when LOCK is free (check-then-rename, like publish), else kept aside as
//     `LOCK.stale-*` with a StoreLockError. RESIDUAL: between the move and the put-back LOCK is briefly absent, so a
//     third process may publish in that window; the displaced owner then still fails closed (its release / withStoreLock
//     check finds `absent` or `not-owner`, never `released`), but code it ran inside that window is not excluded.
//     The mismatch path (and exclusivity itself) also depends on readdir semantics: it assumes a listing never omits a
//     live claim that was published before the listing started (POSIX guarantees it; APFS has been seen to skip entries
//     while a directory changes). The pre-move re-list narrows that window but cannot close it: a complete guarantee needs
//     a no-replace rename (renamex_np RENAME_EXCL / renameat2 RENAME_NOREPLACE), which Node does not expose.
//   * fail closed: unexpected FS errors throw `StoreLockError`; ownership is never assumed.
//   * leftovers of a kill -9 (`LOCK.tmp-*`, `LOCK.stale-*`, `LOCK.release-*`, dead `LOCK.claim-*`) are inert and are
//     swept best-effort at acquire time, bounded, only when their owner is provably dead (or unreadable and old).
// Machine identity: the owner record carries `host` (`os.hostname()`, for humans and old readers), `machine` (a stable
// random id persisted on disk, machine-id.ts) and `boot` (boot + pid-namespace identity, boot-id.ts). `os.hostname()`
// can change (macOS returns the DHCP address), but `kill(pid, 0)` is only proof inside the pid namespace that owns the
// pid, and the machine id file can be SHARED (a container mounting ~/.local/state, an NFS home). So the owner is local
// by id only when BOTH sides have a valid machine id AND a boot identity and both are equal; in EVERY other case
// (a missing field on either side, different ids, different boot/namespace) the hostname rule applies exactly as
// before: same hostname = local, different hostname = never taken over (fail closed: remove `LOCK` by hand after
// checking the owner). Never network-derived. Residual: two machines with the same hostname sharing a store over a
// network filesystem were already a limit of the hostname rule.
// Not implemented on purpose: the Go shared/exclusive maintenance lock (REVIEW-MAINTENANCE.lock). Its only
// exclusive users are recover/reclaim/quarantine/legacy maintenance, which are out of scope for the faithful core
// (v2-rdd S3); writers (U3, U5-U7) need only this exclusive store lock.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pidState } from "../lib/pid.js";
import { bootId as processBoot, isBootId } from "./boot-id.js";
import { isMachineId, machineId as processMachineId } from "./machine-id.js";

const OWNER_FILE = "owner.json";
export const START_LOCK_TIMEOUT_MS = 2_000; // Go compactStartLockTimeout
export const START_LOCK_POLL_MS = 25; // Go compactStartLockPoll
export const UNREADABLE_STALE_MS = 30_000;

export interface StoreLockOwner {
  pid: number;
  host: string;
  /** Stable machine id (absent in records written by older versions or when no id could be loaded). */
  machine?: string;
  /** Boot + pid-namespace identity (absent when unavailable or in older records). */
  boot?: string;
  ownerId: string;
  startedAt: number;
}

export interface StoreLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** An unreadable owner record older than this (mtime) is stale. */
  staleUnreadableMs?: number;
  /** Test seams. */
  host?: string;
  /** Machine id seam: a UUID, or `null` for hostname-only. Without it, `host` given means hostname-only, else the persisted id. */
  machineId?: string | null;
  /** Boot identity seam, same semantics as `machineId`. */
  bootId?: string | null;
  now?: () => number;
  isProcessDead?: (pid: number) => boolean;
}

export type StoreLockReleaseResult = { status: "released" | "not-owner" | "absent" };

export interface StoreLockHandle {
  readonly path: string;
  readonly ownerId: string;
  readonly owner: StoreLockOwner;
  /** Releases only when this handle's token still owns the lock; otherwise a no-op with a typed result. */
  release(): StoreLockReleaseResult;
}

export interface StoreLockBlocker {
  /** `lock`: LOCK itself is held. `reclaim`: LOCK is stale but another live contender is taking it over. */
  kind: "lock" | "reclaim";
  owner?: StoreLockOwner;
}

/** Another holder keeps the store lock past the bounded wait. Not a CAS failure and not an FS error. */
export class StoreLockContended extends Error {
  readonly code = "STORE_LOCK_CONTENDED";
  /** The record of whoever actually blocks us (lock holder or live reclaimer), when readable. */
  readonly owner?: StoreLockOwner;
  constructor(
    readonly path: string,
    readonly waitedMs: number,
    readonly blocker?: StoreLockBlocker,
  ) {
    const o = blocker?.owner;
    const who = o ? ` by pid ${o.pid} on ${o.host}${o.machine ? ` (machine ${o.machine.slice(0, 8)}${o.boot ? `, boot ${o.boot.slice(0, 8)}` : ""})` : ""}` : "";
    const what = blocker?.kind === "reclaim" ? "a stale review store lock is being reclaimed" : "review store lock is held";
    super(`${what}${who} (waited ${Math.round(waitedMs)} ms): ${path}`);
    this.name = "StoreLockContended";
    this.owner = blocker?.owner;
  }
}

/** Unexpected filesystem failure: ownership is unknown, never assumed. */
export class StoreLockError extends Error {
  readonly code = "STORE_LOCK_ERROR";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreLockError";
  }
}

export function storeLockPath(storeRoot: string): string {
  return join(storeRoot, "LOCK");
}

interface Config {
  host: string;
  machine?: string;
  boot?: string;
  now: () => number;
  isDead: (pid: number) => boolean;
  staleUnreadableMs: number;
}

type Observed =
  | { kind: "absent" }
  | { kind: "record"; record: StoreLockOwner; identity: string; ino: string }
  | { kind: "unreadable"; mtimeMs: number; identity: string; ino: string };

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

function wrap(e: unknown, what: string): Error {
  if (e instanceof StoreLockError || e instanceof StoreLockContended) return e;
  return new StoreLockError(`${what}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
}

function processDead(pid: number): boolean {
  return pidState(pid) === "dead"; // EPERM = alive; invalid or any other error = no proof
}

function newRecord(cfg: Config): StoreLockOwner {
  return { pid: process.pid, host: cfg.host, ...(cfg.machine ? { machine: cfg.machine } : {}), ...(cfg.boot ? { boot: cfg.boot } : {}), ownerId: randomBytes(16).toString("hex"), startedAt: cfg.now() };
}

function parseOwner(raw: string): StoreLockOwner | undefined {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof v === "object" && v !== null &&
      typeof v.pid === "number" && Number.isInteger(v.pid) && v.pid > 0 &&
      typeof v.host === "string" && v.host !== "" &&
      typeof v.ownerId === "string" && v.ownerId !== "" &&
      typeof v.startedAt === "number"
    ) {
      // An invalid `machine` is ignored: the record then follows the hostname rule.
      return { pid: v.pid, host: v.host, ...(isMachineId(v.machine) ? { machine: v.machine } : {}), ...(isBootId(v.boot) ? { boot: v.boot } : {}), ownerId: v.ownerId, startedAt: v.startedAt };
    }
  } catch {
    // unreadable
  }
  return undefined;
}

/** Atomically creates directory `path` WITH its owner record. false = already held (contended). */
function publish(path: string, record: StoreLockOwner): boolean {
  const tmp = `${path}.tmp-${record.ownerId}`;
  try {
    mkdirSync(tmp, { mode: 0o700 });
    const fd = openSync(join(tmp, OWNER_FILE), "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(record));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // rename(2) would silently replace an EMPTY directory (foreign/corrupt): never treat that as acquired.
    // Real contenders always leave a non-empty LOCK, which the rename itself rejects atomically.
    if (lstatSync(path, { throwIfNoEntry: false })) return false;
    try {
      renameSync(tmp, path);
      return true;
    } catch (e) {
      if (errCode(e) === "EEXIST" || errCode(e) === "ENOTEMPTY") return false;
      throw e;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const MAX_OWNER_BYTES = 4096;

/**
 * Reads owner.json without ever blocking or following a link: O_NOFOLLOW|O_NONBLOCK, then fstat must say regular file,
 * and at most MAX_OWNER_BYTES are read. Anything else (FIFO, device, symlink, oversized) is "unreadable" (text undefined).
 * undefined = no such file.
 */
function readOwnerFile(file: string): { text?: string; mtimeMs: number } | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const c = errCode(e);
    if (c === "ENOENT") return undefined;
    if (c === "ELOOP" || c === "EMLINK" || c === "ENXIO") return { mtimeMs: 0 };
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_OWNER_BYTES) return { mtimeMs: st.mtimeMs };
    const buf = Buffer.alloc(MAX_OWNER_BYTES + 1);
    let n = 0;
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
      if (n > MAX_OWNER_BYTES) return { mtimeMs: st.mtimeMs };
    }
    return { text: buf.subarray(0, n).toString("utf8"), mtimeMs: st.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

function observe(path: string): Observed {
  let st;
  try {
    st = lstatSync(path); // a symlink is never followed: it is "unreadable"
  } catch (e) {
    if (errCode(e) === "ENOENT") return { kind: "absent" };
    throw e;
  }
  const dirIdentity = `ino:${st.dev}:${st.ino}`;
  if (!st.isDirectory()) return { kind: "unreadable", mtimeMs: st.mtimeMs, identity: dirIdentity, ino: dirIdentity };
  const read = readOwnerFile(join(path, OWNER_FILE));
  const mtimeMs = read ? Math.max(st.mtimeMs, read.mtimeMs) : st.mtimeMs;
  if (!read || read.text === undefined) return { kind: "unreadable", mtimeMs, identity: dirIdentity, ino: dirIdentity };
  const record = parseOwner(read.text);
  if (!record) return { kind: "unreadable", mtimeMs, identity: dirIdentity, ino: dirIdentity };
  return { kind: "record", record, identity: record.ownerId, ino: dirIdentity };
}

/** Local by id needs machine AND boot identity on both sides, all equal; anything else is the hostname rule. */
function isLocal(record: StoreLockOwner, cfg: Config): boolean {
  if (
    record.machine !== undefined && cfg.machine !== undefined && record.machine === cfg.machine &&
    record.boot !== undefined && cfg.boot !== undefined && record.boot === cfg.boot
  ) return true;
  return record.host === cfg.host;
}

/** Stale only with proof: dead owner on this machine, or an unreadable record that is old. */
function isStale(o: Observed, cfg: Config): boolean {
  if (o.kind === "record") return isLocal(o.record, cfg) && cfg.isDead(o.record.pid);
  if (o.kind === "unreadable") return cfg.now() - o.mtimeMs > cfg.staleUnreadableMs;
  return false;
}

/** Moves the stale instance `expected` away and removes it. Only called by the sole live claimant. No restore. */
function moveAway(storeRoot: string, path: string, expected: Observed, mineName: string, cfg: Config): { moved: boolean; blocker?: StoreLockOwner } {
  if (expected.kind === "absent") return { moved: true };
  // Re-list the claims immediately before the move: if claim exclusivity was ever broken (a listing that omitted a
  // live claim), another claimant may already have taken over, so the entry at LOCK could be a LIVE lock. Back off.
  const others = liveClaims(storeRoot, mineName, cfg);
  if (others === "unknown") return { moved: false };
  if (others.length > 0) return { moved: false, blocker: others[0] };
  const reserved = `${path}.stale-${randomBytes(8).toString("hex")}`;
  try {
    renameSync(path, reserved);
  } catch (e) {
    if (errCode(e) === "ENOENT") return { moved: true };
    throw e;
  }
  const moved = observe(reserved);
  // A concurrent sweep may have removed the stale instance we just moved: it is gone either way, retry the acquire.
  if (moved.kind === "absent") return { moved: true };
  // Same directory inode = the very instance judged stale (rename preserves it). sweep() removes owner.json BEFORE the
  // directory, so a record that turned unreadable in place is that same dead owner being swept, not a foreign entry.
  const sameInstance =
    moved.ino === expected.ino && (moved.identity === expected.identity || (expected.kind === "record" && moved.kind === "unreadable"));
  if (sameInstance) {
    rmSync(reserved, { recursive: true, force: true });
    return { moved: true };
  }
  // Genuine mismatch (only under foreign tampering): never strand a possibly live record. Put it back with a
  // check-then-rename (rename(2) cannot refuse an EMPTY directory target; same window as publish) when LOCK is free.
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    try {
      renameSync(reserved, path);
      return { moved: false }; // restored: the caller backs off and re-judges what is at LOCK now
    } catch (e) {
      if (errCode(e) !== "EEXIST" && errCode(e) !== "ENOTEMPTY") throw e;
    }
  }
  throw new StoreLockError(`review store lock changed during an exclusive takeover and LOCK is taken (kept at ${reserved})`);
}

function releaseDir(path: string, ownerId: string): StoreLockReleaseResult {
  const o = observe(path);
  if (o.kind === "absent") return { status: "absent" };
  if (o.kind !== "record" || o.record.ownerId !== ownerId) return { status: "not-owner" };
  const reserved = `${path}.release-${ownerId}`;
  try {
    renameSync(path, reserved);
  } catch (e) {
    if (errCode(e) === "ENOENT") return { status: "absent" };
    throw e;
  }
  const moved = observe(reserved);
  if (moved.kind !== "record" || moved.record.ownerId !== ownerId) {
    throw new StoreLockError(`review store lock changed during release (kept at ${reserved})`);
  }
  try {
    rmSync(reserved, { recursive: true, force: true }); // the rename already released the lock; this is cleanup
  } catch {
    // inert leftover
  }
  return { status: "released" };
}

const CLAIM_RE = /^LOCK\.claim-[0-9a-f]{32}$/;

/** Live claims other than `mine`. Dead claims (unique names, dead owner: no ABA) are removed on the way. */
function liveClaims(storeRoot: string, mine: string, cfg: Config): StoreLockOwner[] | "unknown" {
  const live: StoreLockOwner[] = [];
  let unknown = false;
  for (const name of readdirSync(storeRoot)) {
    if (!CLAIM_RE.test(name) || name === mine) continue;
    const path = join(storeRoot, name);
    const o = observe(path);
    if (o.kind === "absent") continue;
    if (isStale(o, cfg)) {
      const gone = `${path}.stale-${randomBytes(8).toString("hex")}`;
      try {
        renameSync(path, gone);
      } catch (e) {
        if (errCode(e) === "ENOENT") continue;
        throw e;
      }
      try {
        rmSync(gone, { recursive: true, force: true });
      } catch {
        // swept later
      }
      continue;
    }
    if (o.kind === "record") live.push(o.record);
    else unknown = true;
  }
  return live.length > 0 ? live : unknown ? "unknown" : [];
}

/** Takeover of a stale lock by the sole live claimant. removed=true: retry the publish. */
function reclaim(storeRoot: string, lock: string, seen: Observed, cfg: Config): { removed: boolean; blocker?: StoreLockOwner } {
  const me = newRecord(cfg);
  const mineName = `LOCK.claim-${me.ownerId}`;
  const mine = join(storeRoot, mineName);
  if (!publish(mine, me)) throw new StoreLockError(`review store lock claim already exists: ${mine}`);
  try {
    const others = liveClaims(storeRoot, mineName, cfg); // we published first: two contenders can't both be alone
    if (others === "unknown") return { removed: false };
    if (others.length > 0) return { removed: false, blocker: others[0] };
    const now = observe(lock);
    if (now.kind === "absent") return { removed: true };
    if (seen.kind === "absent" || now.identity !== seen.identity || !isStale(now, cfg)) return { removed: false };
    const m = moveAway(storeRoot, lock, now, mineName, cfg);
    return m.blocker ? { removed: m.moved, blocker: m.blocker } : { removed: m.moved };
  } finally {
    releaseDir(mine, me.ownerId);
  }
}

const SWEEP_LIMIT = 64;

/** Bounded best-effort removal of crash leftovers whose owner is provably dead (or unreadable and old). Never LOCK. */
function sweep(storeRoot: string, cfg: Config): void {
  try {
    const names = readdirSync(storeRoot).filter((n) => n.startsWith("LOCK.")).slice(0, SWEEP_LIMIT);
    for (const name of names) {
      try {
        const path = join(storeRoot, name);
        const o = observe(path);
        if (o.kind === "absent" || !lstatSync(path).isDirectory()) continue;
        if (isStale(o, cfg)) rmSync(path, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  } catch {
    // best effort
  }
}

function resolveMachine(options: StoreLockOptions): string | undefined {
  if (options.machineId !== undefined) return isMachineId(options.machineId) ? options.machineId : undefined;
  if (options.host !== undefined) return undefined; // a faked hostname is a faked machine: never the real id
  return processMachineId();
}

function resolveBoot(options: StoreLockOptions): string | undefined {
  if (options.bootId !== undefined) return isBootId(options.bootId) ? options.bootId : undefined;
  if (options.host !== undefined) return undefined;
  return processBoot();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Acquires the exclusive store lock, waiting up to `timeoutMs`. Throws StoreLockContended or StoreLockError. */
export async function acquireStoreLock(storeRoot: string, options: StoreLockOptions = {}): Promise<StoreLockHandle> {
  const cfg: Config = {
    host: options.host ?? hostname(),
    machine: resolveMachine(options),
    boot: resolveBoot(options),
    now: options.now ?? Date.now,
    isDead: options.isProcessDead ?? processDead,
    staleUnreadableMs: options.staleUnreadableMs ?? UNREADABLE_STALE_MS,
  };
  const timeoutMs = options.timeoutMs ?? START_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? START_LOCK_POLL_MS;
  const lock = storeLockPath(storeRoot);
  const record = newRecord(cfg);
  const t0 = performance.now();
  try {
    mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw wrap(e, `cannot create review store root ${storeRoot}`);
  }
  sweep(storeRoot, cfg);
  for (;;) {
    let blocker: StoreLockBlocker | undefined;
    try {
      if (publish(lock, record)) {
        return {
          path: lock,
          ownerId: record.ownerId,
          owner: record,
          release(): StoreLockReleaseResult {
            try {
              return releaseDir(lock, record.ownerId);
            } catch (e) {
              throw wrap(e, "review store lock release failed");
            }
          },
        };
      }
      const seen = observe(lock);
      if (seen.kind === "absent") continue; // released between publish and observe
      if (seen.kind === "record") blocker = { kind: "lock", owner: seen.record };
      if (isStale(seen, cfg)) {
        const r = reclaim(storeRoot, lock, seen, cfg);
        if (r.removed) continue;
        // The dead holder is not what blocks us: a live (or unreadable) claim or a changed identity does.
        blocker = r.blocker ? { kind: "reclaim", owner: r.blocker } : { kind: "reclaim" };
      }
    } catch (e) {
      throw wrap(e, "review store lock acquire failed");
    }
    const waited = performance.now() - t0;
    if (waited >= timeoutMs) throw new StoreLockContended(lock, waited, blocker);
    await sleep(Math.max(1, Math.min(pollMs * (0.5 + Math.random()), timeoutMs - waited)));
  }
}

/** Runs `fn` under the store lock. Fails closed if the lock was lost while `fn` ran. */
export async function withStoreLock<T>(storeRoot: string, fn: () => Promise<T> | T, options?: StoreLockOptions): Promise<T> {
  const handle = await acquireStoreLock(storeRoot, options);
  let ok = false;
  try {
    const value = await fn();
    ok = true;
    return value;
  } finally {
    const r = handle.release();
    if (ok && r.status !== "released") throw new StoreLockError(`review store lock ownership was lost while held (${r.status})`);
  }
}
