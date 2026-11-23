// Consent store for peer messaging (R07, P2). Closed by default: no grant file means nobody may message this session.
//
// Layout (under <dataDir>/peers/, resolved like peers.ts): peers/.grants/<recipient>.json = {"v":1,"allow":[<sender id>...]}
// ("session <recipient> accepts messages from each listed sender"). `.grants` is not a valid id, so it never shows up as a mailbox.
//
// WHO WRITES: only the UserPromptSubmit hook (hooks/user-prompt-submit.ts), from the human's own prompt text; the model
// cannot forge `input.prompt`. There is deliberately no CLI or skill that writes grants (cli/peers.ts is list-only).
//
// LIFETIME: a grant lives until it is revoked or the granting (recipient) session ends: SessionEnd calls `revokeAll`
// (any reason, including /clear), like upstream's "cleared on session change". A resumed session starts closed again.
//
// Safety: ids must match peers.ts' id rule; peers/ and peers/.grants must be real directories (symlinks refused);
// grant files are read via lstat + O_NOFOLLOW, size-capped, and any unreadable/corrupt file means "nobody allowed".
// Writes are atomic (temp + rename, 0600) under a per-recipient lock. Never logs ids beyond what the caller prints.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, releaseOwnedLock } from "./lock.js";
import { isValidSessionId, PeersError } from "./session-id.js";
import { atomicWriteFile, resolveDataDir } from "./state.js";
/** Most senders one session can allow at a time. */
export const MAX_GRANTS = 100;
const MAX_GRANT_FILE_BYTES = 64 * 1024;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
export function grantsDir(opts = {}) {
    return join(resolveDataDir(opts), "peers", ".grants");
}
function requireId(id, what) {
    if (!isValidSessionId(id))
        throw new PeersError("invalid_session_id", `invalid ${what} session id`);
    return id;
}
/** true = real dir, undefined = absent; throws unsafe_path for a symlink or non-directory. */
function realDir(path) {
    try {
        const st = lstatSync(path);
        if (st.isSymbolicLink() || !st.isDirectory())
            throw new PeersError("unsafe_path", "peers path is not a plain directory");
        return true;
    }
    catch (err) {
        if (err instanceof PeersError)
            throw err;
        if (err.code === "ENOENT")
            return undefined;
        throw new PeersError("unsafe_path", "peers path is not accessible");
    }
}
/** The confined grants dir; created (0700) when `create`; undefined when absent and not creating. */
function confinedDir(opts, create) {
    const root = join(resolveDataDir(opts), "peers");
    const dir = join(root, ".grants");
    if (create) {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        realDir(root);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        realDir(dir);
        return dir;
    }
    if (!realDir(root))
        return undefined;
    return realDir(dir) ? dir : undefined;
}
function readSafe(path) {
    let fd;
    try {
        const pre = lstatSync(path);
        if (!pre.isFile() || pre.size > MAX_GRANT_FILE_BYTES)
            return undefined;
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const st = fstatSync(fd);
        if (!st.isFile() || st.size > MAX_GRANT_FILE_BYTES)
            return undefined;
        return readFileSync(fd, "utf8");
    }
    catch {
        return undefined;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
function parse(raw) {
    if (raw === undefined)
        return [];
    try {
        const v = JSON.parse(raw);
        if (v.v !== 1 || !Array.isArray(v.allow))
            return [];
        return [...new Set(v.allow.filter(isValidSessionId))].slice(0, MAX_GRANTS);
    }
    catch {
        return [];
    }
}
function load(recipient, opts) {
    const dir = confinedDir(opts, false);
    return dir ? parse(readSafe(join(dir, `${recipient}.json`))) : [];
}
function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function locked(recipient, opts, fn) {
    const dir = confinedDir(opts, true);
    const lock = join(dir, `${recipient}.lock`);
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (!acquireLock(lock, process.pid, { staleMs: LOCK_STALE_MS })) {
        if (Date.now() > deadline)
            throw new PeersError("lock_timeout", "grants are busy");
        sleep(5);
    }
    try {
        return fn(dir);
    }
    finally {
        releaseOwnedLock(lock, process.pid);
    }
}
function store(dir, recipient, senders) {
    const file = join(dir, `${recipient}.json`);
    if (senders.length === 0)
        rmSync(file, { force: true });
    else
        atomicWriteFile(file, JSON.stringify({ v: 1, allow: [...senders].sort() }) + "\n", 0o600);
}
/** Records "session `recipient` accepts messages from `sender`". Throws PeersError on invalid ids / unsafe store / cap. */
export function allow(recipient, sender, opts = {}) {
    requireId(recipient, "recipient");
    requireId(sender, "sender");
    locked(recipient, opts, (dir) => {
        const current = parse(readSafe(join(dir, `${recipient}.json`)));
        if (current.includes(sender))
            return;
        if (current.length >= MAX_GRANTS)
            throw new PeersError("mailbox_full", `at most ${MAX_GRANTS} grants per session`);
        store(dir, recipient, [...current, sender]);
    });
}
/** Removes one grant. No-op when absent. */
export function revoke(recipient, sender, opts = {}) {
    requireId(recipient, "recipient");
    requireId(sender, "sender");
    if (!confinedDir(opts, false))
        return;
    locked(recipient, opts, (dir) => {
        store(dir, recipient, parse(readSafe(join(dir, `${recipient}.json`))).filter((s) => s !== sender));
    });
}
/** Removes every grant of `recipient` (file deleted). No-op when absent. */
export function revokeAll(recipient, opts = {}) {
    requireId(recipient, "recipient");
    if (!confinedDir(opts, false))
        return;
    locked(recipient, opts, (dir) => rmSync(join(dir, `${recipient}.json`), { force: true }));
}
/** Senders `recipient` currently accepts, sorted. [] when closed. Never throws on a corrupt store beyond unsafe_path. */
export function listGrants(recipient, opts = {}) {
    requireId(recipient, "recipient");
    return load(recipient, opts).sort();
}
/** Consent check for P3. Fails closed: invalid ids, an unsafe/corrupt store or any error give false. */
export function isAllowed(recipient, sender, opts = {}) {
    try {
        if (!isValidSessionId(recipient) || !isValidSessionId(sender))
            return false;
        return load(recipient, opts).includes(sender);
    }
    catch {
        return false;
    }
}
