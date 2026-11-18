// In-flight lock for detached background jobs (codegraph warm-up, registry refresh).
// A lock is a file `<dataDir>/locks/<kind>-<sha1(project)>.lock` holding {pid, startedAt}.
// Created with `wx` (atomic). A held lock is stale when older than `staleMs` or its pid is dead.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
function readLock(path) {
    try {
        const v = JSON.parse(readFileSync(path, "utf8"));
        if (typeof v.pid === "number" && typeof v.startedAt === "number")
            return { pid: v.pid, startedAt: v.startedAt };
    }
    catch {
        // missing or corrupt: treated as stale by the caller when the file exists
    }
    return undefined;
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
            const held = readLock(path);
            if (held && now() - held.startedAt <= opts.staleMs && alive(held.pid))
                return false;
            rmSync(path, { force: true }); // stale or corrupt
        }
    }
    catch {
        // fail safe: no lock means no spawn
    }
    return false;
}
/** Rewrites the lock with the real worker pid (the launcher took it with its own pid first). */
export function setLockPid(path, pid, now = Date.now) {
    try {
        writeFileSync(path, JSON.stringify({ pid, startedAt: now() }));
    }
    catch {
        // best effort
    }
}
/** Removes the lock only when `pid` still owns it. Never throws. */
export function releaseLock(path, pid) {
    try {
        if (readLock(path)?.pid === pid)
            rmSync(path, { force: true });
    }
    catch {
        // best effort
    }
}
