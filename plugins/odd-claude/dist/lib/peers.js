// Mailbox store for peer messages (R07, P1). Pure storage: no consent, no MCP, no hooks (those are P2-P4).
//
// Layout (under <dataDir>/peers/, dataDir resolved exactly like state.ts):
//   peers/<recipient>/<seq:10>.json      one queued message (written atomically: temp file + rename)
//   peers/<recipient>/.seq               last reserved seq (a hint; recovered from the files when missing/corrupt)
//   peers/<recipient>/rate-<sender>.json send timestamps (ms) of the last minute for sender -> recipient
//   peers/.locks/<recipient>.lock        per-mailbox lock (lib/lock.ts), held only for short critical sections
//
// Decisions:
// - take() DELETES delivered messages (no delivered/ log): the spike kept delivered/ only for analysis, and keeping
//   message bodies on disk after delivery has no consumer. Expired messages are deleted too, never delivered.
// - Limits: message 1..8192 bytes, reason 8..512 bytes (UTF-8, after trim), TTL 24 h, 50 queued per mailbox,
//   10 sends per 60 s per sender -> recipient (a rejected send does not consume the budget).
// - Safety: ids must be UUID-like; the peers dir and every mailbox dir must be real directories (symlinks are
//   refused); message files must be regular files (never followed through symlinks) and are read size-capped.
// - Never logs message contents; nothing here writes to hooks.log.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, releaseOwnedLock } from "./lock.js";
import { atomicWriteFile, resolveDataDir } from "./state.js";
import { isValidSessionId, PeersError } from "./session-id.js";
export { isValidSessionId, PeersError };
export const MAX_MESSAGE_BYTES = 8192;
export const MIN_REASON_BYTES = 8;
export const MAX_REASON_BYTES = 512;
export const TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_QUEUED = 50;
export const RATE_LIMIT = 10;
export const RATE_WINDOW_MS = 60_000;
/** Hard cap for reading any file in a mailbox (a valid message JSON is far below this). */
export const MAX_FILE_BYTES = 128 * 1024;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const MESSAGE_FILE_RE = /^(\d{10})\.json$/;
function requireId(id, what) {
    if (!isValidSessionId(id))
        throw new PeersError("invalid_session_id", `invalid ${what} session id`);
    return id;
}
function peersRoot(opts) {
    return join(resolveDataDir(opts), "peers");
}
function isRealDir(path) {
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
/** Returns the confined mailbox dir (a real directory), creating it (0700) when `create`; undefined when absent. */
function ensureMailbox(id, opts, create) {
    const root = peersRoot(opts);
    if (create) {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        isRealDir(root);
        mkdirSync(join(root, ".locks"), { recursive: true, mode: 0o700 });
        isRealDir(join(root, ".locks"));
        try {
            mkdirSync(join(root, id), { mode: 0o700 });
        }
        catch (err) {
            if (err.code !== "EEXIST")
                throw err;
        }
    }
    else if (!isRealDir(root)) {
        return undefined;
    }
    const dir = join(root, id);
    return isRealDir(dir) ? dir : undefined;
}
function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function withLock(id, opts, fn) {
    const locks = join(peersRoot(opts), ".locks");
    mkdirSync(locks, { recursive: true, mode: 0o700 });
    isRealDir(locks);
    const lock = join(locks, `${id}.lock`);
    const deadline = Date.now() + (opts.lockWaitMs ?? LOCK_WAIT_MS);
    while (!acquireLock(lock, process.pid, { staleMs: LOCK_STALE_MS })) {
        if (Date.now() > deadline)
            throw new PeersError("lock_timeout", "mailbox is busy");
        sleep(5);
    }
    try {
        return fn();
    }
    finally {
        releaseOwnedLock(lock, process.pid);
    }
}
/** Size-capped read of a regular file; symlinks are never followed. undefined when not a safe regular file. */
function readSafe(path) {
    let fd;
    try {
        const pre = lstatSync(path);
        if (!pre.isFile() || pre.size > MAX_FILE_BYTES)
            return undefined;
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const st = fstatSync(fd);
        if (!st.isFile() || st.size > MAX_FILE_BYTES)
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
function parseStored(raw, seqFromName) {
    try {
        const v = JSON.parse(raw);
        if (v.v !== 1 ||
            v.seq !== seqFromName ||
            !isValidSessionId(v.from) ||
            typeof v.reason !== "string" ||
            typeof v.message !== "string" ||
            typeof v.accepted_ms !== "number" ||
            !Number.isFinite(v.accepted_ms)) {
            return undefined;
        }
        return v;
    }
    catch {
        return undefined;
    }
}
function scan(dir) {
    const out = [];
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return out;
    }
    for (const name of names) {
        const m = MESSAGE_FILE_RE.exec(name);
        if (!m)
            continue;
        const seq = Number(m[1]);
        let mtimeMs = 0;
        try {
            mtimeMs = lstatSync(join(dir, name)).mtimeMs;
        }
        catch {
            continue;
        }
        const raw = readSafe(join(dir, name));
        out.push({ name, seq, stored: raw === undefined ? undefined : parseStored(raw, seq), mtimeMs });
    }
    return out.sort((a, b) => a.seq - b.seq);
}
function expired(m, now) {
    return now >= m.accepted_ms + TTL_MS || m.accepted_ms > now + TTL_MS; // far-future stamps are not trusted
}
/** Removes expired messages, old corrupt files, abandoned temp files and stale rate logs. Returns the live entries. */
function sweepDir(dir, now) {
    const live = [];
    for (const e of scan(dir)) {
        const dead = e.stored ? expired(e.stored, now) : now - e.mtimeMs > TTL_MS;
        if (dead)
            rmSync(join(dir, e.name), { force: true });
        else if (e.stored)
            live.push(e);
    }
    try {
        for (const name of readdirSync(dir)) {
            if (!name.endsWith(".tmp") && !/^rate-.*\.json$/.test(name))
                continue;
            try {
                const st = lstatSync(join(dir, name));
                const old = now - st.mtimeMs > (name.endsWith(".tmp") ? 60_000 : TTL_MS);
                if (old || !st.isFile())
                    rmSync(join(dir, name), { force: true });
            }
            catch {
                // vanished
            }
        }
    }
    catch {
        // best effort
    }
    return live;
}
function toMessage(m) {
    return {
        seq: m.seq,
        from: m.from,
        reason: m.reason,
        message: m.message,
        accepted_at: new Date(m.accepted_ms).toISOString(),
        expires_at: new Date(m.accepted_ms + TTL_MS).toISOString(),
    };
}
function readSeqHint(dir) {
    const raw = readSafe(join(dir, ".seq"));
    const n = raw === undefined ? NaN : Number(raw.trim());
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
function readRate(dir, sender, now) {
    const raw = readSafe(join(dir, `rate-${sender}.json`));
    if (raw === undefined)
        return [];
    try {
        const v = JSON.parse(raw);
        if (!Array.isArray(v))
            return [];
        return v.filter((t) => typeof t === "number" && t > now - RATE_WINDOW_MS && t <= now);
    }
    catch {
        return [];
    }
}
function utf8Len(s) {
    return Buffer.byteLength(s, "utf8");
}
/** Queues a message for `recipient`. Throws PeersError (typed) on any limit or unsafe input; nothing is stored then. */
export function send(recipient, input, opts = {}) {
    requireId(recipient, "recipient");
    const from = requireId(input?.from, "sender");
    if (typeof input.reason !== "string")
        throw new PeersError("invalid_reason", "reason must be a string");
    if (typeof input.message !== "string")
        throw new PeersError("invalid_message", "message must be a string");
    const reason = input.reason.trim();
    const message = input.message.trim();
    const rl = utf8Len(reason);
    if (rl < MIN_REASON_BYTES || rl > MAX_REASON_BYTES) {
        throw new PeersError("invalid_reason", `reason must be ${MIN_REASON_BYTES}-${MAX_REASON_BYTES} bytes`);
    }
    const ml = utf8Len(message);
    if (ml < 1 || ml > MAX_MESSAGE_BYTES) {
        throw new PeersError("invalid_message", `message must be 1-${MAX_MESSAGE_BYTES} bytes`);
    }
    const now = (opts.now ?? Date.now)();
    const dir = ensureMailbox(recipient, opts, true);
    return withLock(recipient, opts, () => {
        const live = sweepDir(dir, now);
        if (live.length >= MAX_QUEUED)
            throw new PeersError("mailbox_full", `mailbox holds ${MAX_QUEUED} messages`);
        const recent = readRate(dir, from, now);
        if (recent.length >= RATE_LIMIT) {
            throw new PeersError("rate_limited", `at most ${RATE_LIMIT} messages per minute per sender and recipient`);
        }
        const all = scan(dir);
        const seq = Math.max(readSeqHint(dir), all.length ? all[all.length - 1].seq : 0) + 1;
        const stored = { v: 1, seq, from, reason, message, accepted_ms: now };
        // Counter first: a crash after this only skips a seq number; seqs never repeat.
        atomicWriteFile(join(dir, ".seq"), `${seq}\n`, 0o600);
        atomicWriteFile(join(dir, `${String(seq).padStart(10, "0")}.json`), JSON.stringify(stored) + "\n", 0o600);
        atomicWriteFile(join(dir, `rate-${from}.json`), JSON.stringify([...recent, now]), 0o600);
        return { seq, accepted_at: new Date(now).toISOString() };
    });
}
/** Delivers and removes every live message of `recipient`, in seq order. Each message is returned at most once. */
export function take(recipient, opts = {}) {
    requireId(recipient, "recipient");
    const now = (opts.now ?? Date.now)();
    const dir = ensureMailbox(recipient, opts, false);
    if (!dir)
        return [];
    return withLock(recipient, opts, () => {
        const live = sweepDir(dir, now);
        for (const e of live)
            rmSync(join(dir, e.name), { force: true });
        return live.map((e) => toMessage(e.stored));
    });
}
/**
 * Selective take (P4 delivery): under the mailbox lock, walks the live messages in seq order and asks `select` about each one:
 * "take" removes and returns it, "drop" removes it without returning it, "skip" leaves it queued and continues with the next one, "stop" ends the walk leaving it and every later message
 * queued. Expired messages are removed (never offered to `select`). If `select` throws nothing is removed and the error propagates.
 */
export function takeSelect(recipient, select, opts = {}) {
    requireId(recipient, "recipient");
    const now = (opts.now ?? Date.now)();
    const dir = ensureMailbox(recipient, opts, false);
    if (!dir)
        return [];
    return withLock(recipient, opts, () => {
        const live = sweepDir(dir, now);
        const decided = [];
        for (const e of live) {
            const m = toMessage(e.stored);
            const d = select(m);
            if (d === "stop")
                break;
            if (d === "skip")
                continue;
            decided.push({ e, take: d === "take" });
        }
        for (const { e } of decided)
            rmSync(join(dir, e.name), { force: true });
        return decided.filter((x) => x.take).map((x) => toMessage(x.e.stored));
    });
}
/** Read-only view of the live (unexpired) messages, for diagnostics. Removes nothing. */
export function peek(recipient, opts = {}) {
    requireId(recipient, "recipient");
    const now = (opts.now ?? Date.now)();
    const dir = ensureMailbox(recipient, opts, false);
    if (!dir)
        return [];
    return scan(dir)
        .filter((e) => e.stored && !expired(e.stored, now))
        .map((e) => toMessage(e.stored));
}
/** Number of live queued messages (diagnostics). */
export function count(recipient, opts = {}) {
    return peek(recipient, opts).length;
}
/** Ids of the mailboxes that exist (plain directories with a valid id name), sorted. [] when none. */
export function sessionIds(opts = {}) {
    try {
        const root = peersRoot(opts);
        if (!isRealDir(root))
            return [];
        return readdirSync(root)
            .filter((n) => isValidSessionId(n))
            .filter((n) => {
            try {
                const st = lstatSync(join(root, n));
                return st.isDirectory() && !st.isSymbolicLink();
            }
            catch {
                return false;
            }
        })
            .sort();
    }
    catch {
        return [];
    }
}
/**
 * Removes `recipient`'s mailbox directory when it holds no message files, only the `.seq` / `rate-*.json` bookkeeping
 * (what an ended session leaves behind). Under the mailbox lock; a symlinked or non-directory path is never touched;
 * never recursive: only those known bookkeeping files are unlinked, then a plain rmdir (a foreign file, a subdirectory
 * or a race with a new message leaves the directory). Pending messages keep it (they expire by TTL).
 * Returns true only when the directory was removed.
 */
export function removeMailboxIfEmpty(recipient, opts = {}) {
    if (!isValidSessionId(recipient))
        return false;
    let dir;
    try {
        dir = ensureMailbox(recipient, opts, false);
    }
    catch {
        return false; // unsafe path: leave it alone
    }
    if (!dir)
        return false;
    const mailbox = dir;
    try {
        return withLock(recipient, opts, () => {
            const bookkeeping = [];
            for (const name of readdirSync(mailbox)) {
                if (name === ".seq" || /^rate-[A-Za-z0-9-]+\.json$/.test(name))
                    bookkeeping.push(name);
                else
                    return false; // a message file or anything foreign keeps the directory
            }
            for (const name of bookkeeping) {
                const p = join(mailbox, name);
                try {
                    if (lstatSync(p).isFile())
                        unlinkSync(p);
                }
                catch {
                    // vanished
                }
            }
            try {
                rmdirSync(mailbox);
                return true;
            }
            catch {
                return false; // ENOTEMPTY or anything else: leave it
            }
        });
    }
    catch {
        return false;
    }
}
