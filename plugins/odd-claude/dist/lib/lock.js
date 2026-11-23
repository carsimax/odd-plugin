// In-flight lock for detached background jobs (codegraph warm-up, registry refresh).
// A lock is a file `<dataDir>/locks/<kind>-<sha1(project)>.lock` holding {pid, startedAt}.
// Created atomically WITH content (unique temp file, then link: EEXIST means contended), so no reader ever sees an
// empty lock. An unreadable/empty lock is stale only when its mtime is older than `staleMs`. A held lock is stale when its pid is dead, or
// (unless `proofOfDeathOnly`) older than `staleMs`. Takeover is claim-based (see takeOver).
// Limitation (proofOfDeathOnly): a crashed holder whose pid is later reused by an unrelated live process keeps the lock
// forever; contenders wait their bounded time and fail open (e.g. each PostToolUse waits ~1 s and logs a timeout) until
// the lock file is removed by hand.
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isPidAlive } from "./pid.js";
export function lockPath(dataDir, kind, project) {
    const key = createHash("sha1").update(resolve(project)).digest("hex").slice(0, 16);
    return join(dataDir, "locks", `${kind}-${key}.lock`);
}
export function pidAlive(pid) {
    return isPidAlive(pid);
}
function parseLock(raw) {
    try {
        const v = JSON.parse(raw);
        if (typeof v.pid === "number" && typeof v.startedAt === "number")
            return { pid: v.pid, startedAt: v.startedAt };
    }
    catch {
        // missing or corrupt: treated as stale by the caller when the file exists
    }
    return undefined;
}
function readLock(path) {
    try {
        return parseLock(readFileSync(path, "utf8"));
    }
    catch {
        return undefined;
    }
}
/**
 * Removes the stale lock `staleRaw` WITHOUT any move->check->restore step (a restore leaves a window with no lock file
 * in which a third process can create one, so two holders overlap). Exclusivity comes from claims instead: every
 * contender that judged the lock stale publishes its own uniquely named claim `<lock>.claim-<id>` (holding its pid)
 * and only proceeds when it is the ONLY live claimant (each publishes before it lists, so two contenders can never
 * both see themselves alone; losers back off and retry). Claims of dead pids, and unreadable claims older than
 * `staleMs`, are swept. The sole claimant re-reads the lock: only when it is still exactly `staleRaw` is it moved
 * away. For a DEAD holder nothing can replace the instance between the re-read and the move (it cannot release, and
 * nobody can create while it exists). A live holder judged stale by age CAN release and a fresh lock appear in that
 * gap, so after the move the moved content is verified: if it is not exactly `staleRaw` it is a fresh lock, which is
 * never deleted: it is linked back (no clobber) or, when the path is occupied again, kept aside; either way we
 * return false (contended) and never acquire. Returns true when the caller may retry the create; false to back off.
 */
function takeOver(path, staleRaw, alive, staleMs) {
    const dir = dirname(path);
    const prefix = `${basename(path)}.claim-`;
    const mine = `${path}.claim-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
        writeFileSync(mine, JSON.stringify({ pid: process.pid }));
        for (const name of readdirSync(dir)) {
            const other = join(dir, name);
            if (!name.startsWith(prefix) || other === mine)
                continue;
            let claimant;
            try {
                claimant = JSON.parse(readFileSync(other, "utf8")).pid;
            }
            catch {
                // empty/partial claim: its owner may be mid-write (fresh) or was killed between create and write (old)
                try {
                    if (Date.now() - statSync(other).mtimeMs > staleMs) {
                        rmSync(other, { force: true }); // unique name, unreadable and older than staleMs: abandoned
                        continue;
                    }
                }
                catch {
                    continue; // vanished
                }
            }
            if (claimant !== undefined && !alive(claimant)) {
                rmSync(other, { force: true }); // unique name + dead owner: nobody can be using it
                continue;
            }
            return false; // another live claimant is taking this lock over
        }
        let current;
        try {
            current = readFileSync(path, "utf8");
        }
        catch {
            return true; // already gone: the next create attempt decides
        }
        if (current !== staleRaw)
            return false; // replaced by a fresh lock: not ours to remove
        const stale = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.stale`;
        try {
            renameSync(path, stale);
        }
        catch {
            return true;
        }
        let moved;
        try {
            moved = readFileSync(stale, "utf8");
        }
        catch {
            // unreadable: not provably the judged record; kept aside below
        }
        if (moved === staleRaw) {
            rmSync(stale, { force: true });
            return true;
        }
        // The holder released and somebody created a fresh lock after our re-read: never delete or acquire over it.
        // Give it back without clobbering (link fails with EEXIST if the path is occupied again; then it stays aside).
        try {
            linkSync(stale, path);
            rmSync(stale, { force: true });
        }
        catch {
            // path occupied or link failed: keep the moved record aside, inert, and report contention
        }
        return false;
    }
    catch {
        return false;
    }
    finally {
        rmSync(mine, { force: true });
    }
}
const MAX_STALE_SWEEP = 32;
/**
 * Best-effort, bounded sweep of `<lock>.*.stale` leftovers (a fresh lock moved aside that could not be linked back).
 * Removed only when its record's pid is dead, or it is unreadable/empty and older than `staleMs`; a live record and
 * the lock path itself are never touched.
 */
function sweepStaleLeftovers(path, alive, staleMs) {
    try {
        const prefix = `${basename(path)}.`;
        let seen = 0;
        for (const name of readdirSync(dirname(path))) {
            if (!name.startsWith(prefix) || !name.endsWith(".stale"))
                continue;
            if (++seen > MAX_STALE_SWEEP)
                return;
            const file = join(dirname(path), name);
            try {
                const held = parseLock(readFileSync(file, "utf8"));
                if (held) {
                    if (!alive(held.pid))
                        rmSync(file, { force: true });
                }
                else if (Date.now() - statSync(file).mtimeMs > staleMs) {
                    rmSync(file, { force: true });
                }
            }
            catch {
                // vanished or unreadable: leave it
            }
        }
    }
    catch {
        // best effort
    }
}
/** Creates `path` atomically with its content: write a unique temp file, then link it (EEXIST = held). */
function createExclusive(path, content) {
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        writeFileSync(tmp, content);
        linkSync(tmp, path);
        return true;
    }
    catch (err) {
        if (err.code === "EEXIST")
            return false;
        throw err;
    }
    finally {
        rmSync(tmp, { force: true });
    }
}
/** True when this caller now owns the lock; false when a live, fresh lock is held. Never throws. */
export function acquireLock(path, pid, opts) {
    const now = opts.now ?? Date.now;
    const alive = opts.isAlive ?? pidAlive;
    try {
        mkdirSync(join(path, ".."), { recursive: true });
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                if (createExclusive(path, JSON.stringify({ pid, startedAt: now() })))
                    return true;
            }
            catch {
                return false;
            }
            if (attempt === 0)
                sweepStaleLeftovers(path, alive, opts.staleMs);
            let raw;
            try {
                raw = readFileSync(path, "utf8");
            }
            catch {
                continue; // vanished between link and read: retry the create
            }
            const held = parseLock(raw);
            if (held) {
                // Proof of death only (opts.proofOfDeathOnly): a live pid is never taken over by age alone.
                if (alive(held.pid) && (opts.proofOfDeathOnly === true || now() - held.startedAt <= opts.staleMs))
                    return false;
            }
            else {
                // Unreadable or empty: stale only by file mtime (real clock), never immediately.
                let mtime;
                try {
                    mtime = statSync(path).mtimeMs;
                }
                catch {
                    continue;
                }
                if (Date.now() - mtime <= opts.staleMs)
                    return false;
            }
            if (!takeOver(path, raw, alive, opts.staleMs))
                return false;
        }
    }
    catch {
        // fail safe: no lock means no spawn
    }
    return false;
}
/** Removes the lock only when `pid` owns it; never leaves a marker. For callers with no handoff. Never throws. */
export function releaseOwnedLock(path, pid) {
    try {
        if (readLock(path)?.pid === pid)
            rmSync(path, { force: true });
    }
    catch {
        // best effort
    }
}
function doneMarker(path, pid) {
    return `${path}.done-${pid}`;
}
/**
 * Hands the lock over to the real worker pid (the launcher took it with its own pid first). When the worker already
 * finished (it left a done marker because it could not release a lock it did not own yet), the lock is removed instead.
 */
export function setLockPid(path, pid, now = Date.now) {
    try {
        const marker = doneMarker(path, pid);
        const finished = () => {
            try {
                readFileSync(marker);
                rmSync(marker, { force: true });
                rmSync(path, { force: true });
                return true;
            }
            catch {
                return false;
            }
        };
        if (finished())
            return;
        const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        writeFileSync(tmp, JSON.stringify({ pid, startedAt: now() }));
        renameSync(tmp, path); // atomic replace: readers never see a partial lock
        finished(); // the worker may have finished while we wrote
    }
    catch {
        // best effort
    }
}
/**
 * Removes the lock when `pid` owns it. When the lock still holds the launcher's pid (handoff not done yet), leaves a
 * done marker so setLockPid removes the lock instead of handing it to a finished process. Never throws.
 */
export function releaseLock(path, pid) {
    try {
        const held = readLock(path);
        if (!held)
            return;
        if (held.pid === pid) {
            rmSync(path, { force: true });
            return;
        }
        writeFileSync(doneMarker(path, pid), "");
        if (readLock(path)?.pid === pid) {
            rmSync(path, { force: true });
            rmSync(doneMarker(path, pid), { force: true });
        }
    }
    catch {
        // best effort
    }
}
