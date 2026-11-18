// In-flight lock for detached background jobs (codegraph warm-up, registry refresh).
// A lock is a file `<dataDir>/locks/<kind>-<sha1(project)>.lock` holding {pid, startedAt}.
// Created with `wx` (atomic). A held lock is stale when older than `staleMs` or its pid is dead.
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
export function lockPath(dataDir, kind, project) {
    const key = createHash("sha1").update(resolve(project)).digest("hex").slice(0, 16);
    return join(dataDir, "locks", `${kind}-${key}.lock`);
}
export function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
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
 * Atomically removes the stale lock `staleRaw`: rename it to a unique name, and only when the renamed content is
 * still the stale one proceed. If a concurrent caller already replaced it with a fresh lock, put that lock back
 * (link fails with EEXIST if yet another one exists) and report failure.
 */
function takeOver(path, staleRaw) {
    const tmpName = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.stale`;
    try {
        renameSync(path, tmpName);
    }
    catch {
        return true; // already gone: the next create attempt decides
    }
    try {
        if (readFileSync(tmpName, "utf8") === staleRaw)
            return true;
        try {
            linkSync(tmpName, path); // restore the fresh lock we grabbed by mistake
        }
        catch {
            // someone else holds a lock now
        }
        return false;
    }
    catch {
        return false;
    }
    finally {
        rmSync(tmpName, { force: true });
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
                writeFileSync(path, JSON.stringify({ pid, startedAt: now() }), { flag: "wx" });
                return true;
            }
            catch (err) {
                if (err.code !== "EEXIST")
                    return false;
            }
            let raw;
            try {
                raw = readFileSync(path, "utf8");
            }
            catch {
                continue; // vanished between wx and read: retry the create
            }
            const held = parseLock(raw);
            if (held && now() - held.startedAt <= opts.staleMs && alive(held.pid))
                return false;
            if (!takeOver(path, raw))
                return false;
        }
    }
    catch {
        // fail safe: no lock means no spawn
    }
    return false;
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
        writeFileSync(path, JSON.stringify({ pid, startedAt: now() }));
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
