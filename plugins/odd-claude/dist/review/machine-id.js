// Stable machine identity for the review store lock. `os.hostname()` can change (macOS returns the DHCP address and it
// moves with the network), so a lock left by a crashed process was never taken over after a network change.
// The id is a random UUID persisted at `${XDG_STATE_HOME:-~/.local/state}/odd-plugin/machine-id` (mode 0600, created
// with write-temp + link(2): exactly one concurrent creator wins, the file is never replaced). It is NEVER derived from
// network values. Every failure (unreadable, corrupt, oversized, symlink, no home) yields `undefined`: callers fall back
// to hostname-only behavior. Nothing here throws.
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
export const MACHINE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 128;
export function isMachineId(v) {
    return typeof v === "string" && MACHINE_ID_RE.test(v);
}
/** The state home: absolute XDG_STATE_HOME, else ~/.local/state. undefined when neither is usable. */
export function stateHome(env = process.env) {
    const x = env.XDG_STATE_HOME;
    if (x && isAbsolute(x))
        return x;
    try {
        const h = homedir();
        return h ? join(h, ".local", "state") : undefined;
    }
    catch {
        return undefined;
    }
}
const LINK_RETRIES = 20;
const LINK_RETRY_MS = 5;
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** readId that waits (bounded: 20 x 5 ms) while the only defect is the creator's transient second link. */
function readIdSettled(file) {
    let r = readId(file);
    for (let i = 0; i < LINK_RETRIES && r.kind === "linked"; i++) {
        sleepSync(LINK_RETRY_MS);
        r = readId(file);
    }
    return r;
}
function readId(file) {
    let fd;
    try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    catch (e) {
        return e.code === "ENOENT" ? { kind: "absent" } : { kind: "bad" };
    }
    try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.size > MAX_BYTES)
            return { kind: "bad" };
        if (st.nlink > 1)
            return { kind: "linked" };
        const buf = Buffer.alloc(MAX_BYTES + 1);
        let n = 0;
        for (;;) {
            const r = readSync(fd, buf, n, buf.length - n, null);
            if (r === 0)
                break;
            n += r;
            if (n > MAX_BYTES)
                return { kind: "bad" };
        }
        const text = buf.subarray(0, n).toString("utf8").replace(/\n$/, "");
        return isMachineId(text) ? { kind: "ok", id: text } : { kind: "bad" };
    }
    catch {
        return { kind: "bad" };
    }
    finally {
        closeSync(fd);
    }
}
/** Reads (creating it atomically on first use) the machine id under `stateDir`. undefined = unavailable. */
export function loadMachineId(stateDir) {
    try {
        const dir = join(stateDir, "odd-plugin");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (!lstatSync(dir).isDirectory())
            return undefined; // a symlinked dir is never followed
        const file = join(dir, "machine-id");
        const first = readIdSettled(file);
        if (first.kind === "ok")
            return first.id;
        if (first.kind === "bad" || first.kind === "linked")
            return undefined;
        const tmp = `${file}.tmp-${randomUUID()}`;
        try {
            const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try {
                writeSync(fd, `${randomUUID()}\n`);
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
            try {
                linkSync(tmp, file); // atomic, fails with EEXIST when another process won
            }
            catch (e) {
                if (e.code !== "EEXIST")
                    return undefined;
            }
        }
        finally {
            rmSync(tmp, { force: true });
        }
        const again = readIdSettled(file);
        return again.kind === "ok" ? again.id : undefined;
    }
    catch {
        return undefined;
    }
}
let cached;
/**
 * The machine id for this process, resolved once. Only a SUCCESS is cached: a failure (transient race, unreadable home)
 * is retried by the next acquire, which is cheap (one open/read), so a transient error never pins hostname-only for
 * the whole process; a persistent failure just stays hostname-only.
 */
export function machineId() {
    if (cached)
        return cached.value;
    const home = stateHome();
    const value = home ? loadMachineId(home) : undefined;
    if (value !== undefined)
        cached = { value };
    return value;
}
