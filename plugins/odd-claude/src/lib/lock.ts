// In-flight lock for detached background jobs (codegraph warm-up, registry refresh).
// A lock is a file `<dataDir>/locks/<kind>-<sha1(project)>.lock` holding {pid, startedAt}.
// Created atomically WITH content (unique temp file, then link: EEXIST means contended), so no reader ever sees an
// empty lock. An unreadable/empty lock is stale only when its mtime is older than `staleMs`. A held lock is stale when its pid is dead, or
// (unless `proofOfDeathOnly`) older than `staleMs`. Takeover is claim-based (see takeOver): no move->check->restore.
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface LockOptions {
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  staleMs: number;
  /** When true a lock whose pid is alive is never stale by age (only a dead pid, or an unreadable old file, is). */
  proofOfDeathOnly?: boolean;
}

export function lockPath(dataDir: string, kind: string, project: string): string {
  const key = createHash("sha1").update(resolve(project)).digest("hex").slice(0, 16);
  return join(dataDir, "locks", `${kind}-${key}.lock`);
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLock(raw: string): { pid: number; startedAt: number } | undefined {
  try {
    const v = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
    if (typeof v.pid === "number" && typeof v.startedAt === "number") return { pid: v.pid, startedAt: v.startedAt };
  } catch {
    // missing or corrupt: treated as stale by the caller when the file exists
  }
  return undefined;
}

function readLock(path: string): { pid: number; startedAt: number } | undefined {
  try {
    return parseLock(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Removes the stale lock `staleRaw` WITHOUT any move->check->restore step (a restore leaves a window with no lock file
 * in which a third process can create one, so two holders overlap). Exclusivity comes from claims instead: every
 * contender that judged the lock stale publishes its own uniquely named claim `<lock>.claim-<id>` (holding its pid)
 * and only proceeds when it is the ONLY live claimant (each publishes before it lists, so two contenders can never
 * both see themselves alone; losers back off and retry). Claims of dead pids are swept. The sole claimant re-reads the
 * lock: only when it is still exactly `staleRaw` is it moved away. While the stale instance exists nobody else can
 * create the lock, and a dead holder cannot release it, so nothing can replace it between the re-read and the move.
 * Returns true when the caller may retry the create; false to back off.
 */
function takeOver(path: string, staleRaw: string, alive: (pid: number) => boolean): boolean {
  const dir = dirname(path);
  const prefix = `${basename(path)}.claim-`;
  const mine = `${path}.claim-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(mine, JSON.stringify({ pid: process.pid }));
    for (const name of readdirSync(dir)) {
      const other = join(dir, name);
      if (!name.startsWith(prefix) || other === mine) continue;
      let claimant: number | undefined;
      try {
        claimant = (JSON.parse(readFileSync(other, "utf8")) as { pid?: unknown }).pid as number;
      } catch {
        // empty/partial claim: its owner is mid-write; treat as live (back off)
      }
      if (claimant !== undefined && !alive(claimant)) {
        rmSync(other, { force: true }); // unique name + dead owner: nobody can be using it
        continue;
      }
      return false; // another live claimant is taking this lock over
    }
    let current: string;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      return true; // already gone: the next create attempt decides
    }
    if (current !== staleRaw) return false; // replaced by a fresh lock: not ours to remove
    const stale = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.stale`;
    try {
      renameSync(path, stale);
    } catch {
      return true;
    }
    rmSync(stale, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(mine, { force: true });
  }
}

/** Creates `path` atomically with its content: write a unique temp file, then link it (EEXIST = held). */
function createExclusive(path: string, content: string): boolean {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, content);
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** True when this caller now owns the lock; false when a live, fresh lock is held. Never throws. */
export function acquireLock(path: string, pid: number, opts: LockOptions): boolean {
  const now = opts.now ?? Date.now;
  const alive = opts.isAlive ?? pidAlive;
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (createExclusive(path, JSON.stringify({ pid, startedAt: now() }))) return true;
      } catch {
        return false;
      }
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        continue; // vanished between link and read: retry the create
      }
      const held = parseLock(raw);
      if (held) {
        // Proof of death only (opts.proofOfDeathOnly): a live pid is never taken over by age alone.
        if (alive(held.pid) && (opts.proofOfDeathOnly === true || now() - held.startedAt <= opts.staleMs)) return false;
      } else {
        // Unreadable or empty: stale only by file mtime (real clock), never immediately.
        let mtime: number;
        try {
          mtime = statSync(path).mtimeMs;
        } catch {
          continue;
        }
        if (Date.now() - mtime <= opts.staleMs) return false;
      }
      if (!takeOver(path, raw, alive)) return false;
    }
  } catch {
    // fail safe: no lock means no spawn
  }
  return false;
}

/** Removes the lock only when `pid` owns it; never leaves a marker. For callers with no handoff. Never throws. */
export function releaseOwnedLock(path: string, pid: number): void {
  try {
    if (readLock(path)?.pid === pid) rmSync(path, { force: true });
  } catch {
    // best effort
  }
}

function doneMarker(path: string, pid: number): string {
  return `${path}.done-${pid}`;
}

/**
 * Hands the lock over to the real worker pid (the launcher took it with its own pid first). When the worker already
 * finished (it left a done marker because it could not release a lock it did not own yet), the lock is removed instead.
 */
export function setLockPid(path: string, pid: number, now: () => number = Date.now): void {
  try {
    const marker = doneMarker(path, pid);
    const finished = (): boolean => {
      try {
        readFileSync(marker);
        rmSync(marker, { force: true });
        rmSync(path, { force: true });
        return true;
      } catch {
        return false;
      }
    };
    if (finished()) return;
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pid, startedAt: now() }));
    renameSync(tmp, path); // atomic replace: readers never see a partial lock
    finished(); // the worker may have finished while we wrote
  } catch {
    // best effort
  }
}

/**
 * Removes the lock when `pid` owns it. When the lock still holds the launcher's pid (handoff not done yet), leaves a
 * done marker so setLockPid removes the lock instead of handing it to a finished process. Never throws.
 */
export function releaseLock(path: string, pid: number): void {
  try {
    const held = readLock(path);
    if (!held) return;
    if (held.pid === pid) {
      rmSync(path, { force: true });
      return;
    }
    writeFileSync(doneMarker(path, pid), "");
    if (readLock(path)?.pid === pid) {
      rmSync(path, { force: true });
      rmSync(doneMarker(path, pid), { force: true });
    }
  } catch {
    // best effort
  }
}
