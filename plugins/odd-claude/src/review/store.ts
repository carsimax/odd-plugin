// Review authority store (U3): `<git-common-dir>/odd-plugin/review-transactions/v2/<lineage>/review-state.json`
// (+ `review-receipt.json`, written once at burn). Equivalent of Go `compact_store.go` (review-state.json, revision CAS,
// ErrConcurrentUpdate) and `store.go:927 writeAtomic`; the layout lives in OUR namespace (v2-rdd S3/S4), never in the
// upstream authority tree nor in the external `odd-claude` CLI tree.
//   * every mutation (create, update, receipt) runs under the exclusive store lock (`<root>/LOCK`, see lock.ts).
//   * updateState is compare-and-swap on the state revision (never mtime): read current, refuse unless
//     `current.revision === expectedRevision`, apply the pure transition from state.ts, re-validate, write atomically.
//   * writeAtomic: unique temp in the same directory (`.atomic-<pid>-<rand>`, O_EXCL|O_NOFOLLOW, 0600) -> write ->
//     fsync -> rename -> fsync directory. A failure before the rename removes the temp; a kill -9 leaves only an inert
//     `.atomic-*` file that is never read as state and is swept by the next mutation (we hold the lock, so any temp is
//     from a dead writer).
//   * reads are secure: O_NOFOLLOW|O_NONBLOCK open (a FIFO can never block us), regular-file check on the OPEN fd,
//     size cap, JSON parse, validateStateRecord (which recomputes the revision). Corrupt/unreadable input raises a typed
//     StoreCorruptError and is NEVER repaired or rewritten. Lineage ids are `review-<16 hex>` only (no traversal).
//   * unexpected filesystem failures surface as StoreIoError (never a bare errno error); a regular file with more than one
//     link is refused (a hardlink could alias a file outside the store).
//   * the namespace and lineage directories are fsynced into their parent after creation (Go mkdirAllSync).
//   * root and lineage directories are created 0700, files 0600; the three namespace directories and the lineage
//     directory must be real directories (a symlink there is refused).
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readdirSync, readSync, renameSync, rmSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "./canonical.js";
import { withStoreLock, type StoreLockOptions } from "./lock.js";
import { stateRevision, validateStateRecord, type Outcome, type Refusal, type StateRecord } from "./state.js";

export const MAX_STATE_BYTES = 1 << 20;
export const MAX_LINEAGES = 10_000;
/** An abandoned lineage directory (crash mid-START) is only swept once it, and everything in it, is older than this. */
export const ABANDONED_MIN_AGE_MS = 3_600_000;
/** Most abandoned directories one sweep removes, and most lineage directories it examines. */
export const ABANDONED_SWEEP_MAX = 16;
const ABANDONED_SWEEP_EXAMINE_MAX = 512;
const STATE_FILE = "review-state.json";
const RECEIPT_FILE = "review-receipt.json";
const LINEAGE_RE = /^review-[0-9a-f]{16}$/;
const TEMP_RE = /^\.atomic-\d+-[0-9a-f]{16}$/;

export type CorruptKind = "unreadable" | "not-regular" | "oversized" | "invalid-json" | "invalid-record" | "revision-mismatch" | "lineage-mismatch";

export class StoreInvalidLineageError extends Error {
  readonly code = "STORE_INVALID_LINEAGE";
  constructor(readonly lineage: unknown) {
    super(`invalid review lineage id (want review-<16 hex>): ${JSON.stringify(lineage)}`);
    this.name = "StoreInvalidLineageError";
  }
}
export class StoreNotFoundError extends Error {
  readonly code = "STORE_NOT_FOUND";
  constructor(readonly path: string) {
    super(`review store entry not found: ${path}`);
    this.name = "StoreNotFoundError";
  }
}
export class StoreAlreadyExistsError extends Error {
  readonly code = "STORE_ALREADY_EXISTS";
  constructor(readonly path: string) {
    super(`review store entry already exists: ${path}`);
    this.name = "StoreAlreadyExistsError";
  }
}
/** The file on disk is unreadable, unsafe or invalid. Never repaired. */
export class StoreCorruptError extends Error {
  readonly code = "STORE_CORRUPT";
  constructor(readonly kind: CorruptKind, readonly path: string, detail: string, readonly errors: string[] = []) {
    super(`review store entry is corrupt (${kind}): ${path}: ${detail}`);
    this.name = "StoreCorruptError";
  }
}
/** CAS failure: the stored revision is not the one the caller read. */
export class StoreConcurrentUpdateError extends Error {
  readonly code = "STORE_CONCURRENT_UPDATE";
  constructor(readonly expectedRevision: string, readonly currentRevision: string) {
    super(`concurrent update: expected revision ${expectedRevision}, current ${currentRevision}`);
    this.name = "StoreConcurrentUpdateError";
  }
}
export class StoreTransitionRefusedError extends Error {
  readonly code = "STORE_TRANSITION_REFUSED";
  constructor(readonly refusal: Refusal) {
    super(`transition refused (${refusal.code}): ${refusal.message}`);
    this.name = "StoreTransitionRefusedError";
  }
}
/** The caller supplied a record (or a transition result) that is not a valid state record / receipt. Nothing written. */
export class StoreInvalidRecordError extends Error {
  readonly code = "STORE_INVALID_RECORD";
  constructor(readonly errors: string[]) {
    super(`invalid review record: ${errors.join("; ")}`);
    this.name = "StoreInvalidRecordError";
  }
}

/** Unexpected filesystem failure (ENOENT on the common dir, EACCES, ENOSPC...). Fail closed; nothing is assumed written. */
export class StoreIoError extends Error {
  readonly code = "STORE_IO";
  constructor(readonly path: string, readonly errno: string | undefined, detail: string, options?: { cause?: unknown }) {
    super(`review store I/O failure${errno ? ` (${errno})` : ""}: ${path}: ${detail}`, options);
    this.name = "StoreIoError";
  }
}

export interface SweepOptions {
  /** Clock (ms since epoch) used for the age check. Test seam. */
  now?: () => number;
  /** Minimum age of the directory and of every entry in it before it may be removed. */
  minAgeMs?: number;
  /** Most abandoned directories removed by one call. */
  max?: number;
}

export interface StoreOptions {
  lock?: StoreLockOptions;
  /** Abandoned-lineage sweep of createState (see `sweepAbandonedLineages`). */
  sweep?: SweepOptions;
}

export function storeRootFor(commonDir: string): string {
  return join(commonDir, "odd-plugin", "review-transactions", "v2");
}

function assertLineage(lineage: unknown): asserts lineage is string {
  if (typeof lineage !== "string" || !LINEAGE_RE.test(lineage)) throw new StoreInvalidLineageError(lineage);
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

const isStoreError = (e: unknown): boolean => typeof (e as { code?: unknown } | null)?.code === "string" && (e as { code: string }).code.startsWith("STORE_");

/** Maps a bare errno error to StoreIoError; store/lock errors and non-fs errors (caller code) pass through. */
function typed(e: unknown): unknown {
  const code = errCode(e);
  if (isStoreError(e) || typeof code !== "string" || !/^E[A-Z0-9]+$/.test(code)) return e;
  return new StoreIoError(String((e as { path?: unknown }).path ?? ""), code, (e as Error).message, { cause: e });
}
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw typed(e);
  }
}
async function guardAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw typed(e);
  }
}

/** lstat that maps ENOENT to undefined. */
function lstatOrNull(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (e) {
    if (errCode(e) === "ENOENT") return undefined;
    throw typed(e);
  }
}

/** Requires `path` to be a real directory (not a symlink). Returns false when absent. */
function realDirExists(path: string): boolean {
  const st = lstatOrNull(path);
  if (!st) return false;
  if (!st.isDirectory()) throw new StoreCorruptError("not-regular", path, "expected a real directory");
  return true;
}

/** The three namespace directories, each a real directory. With `create` they are made 0700. */
function checkRoot(commonDir: string, create: boolean): boolean {
  let path = commonDir;
  for (const part of ["odd-plugin", "review-transactions", "v2"]) {
    path = join(path, part);
    if (realDirExists(path)) continue;
    if (!create) return false;
    try {
      mkdirSync(path, { mode: 0o700 });
      syncDir(dirname(path));
    } catch (e) {
      if (errCode(e) !== "EEXIST") throw typed(e);
    }
    realDirExists(path);
  }
  return true;
}

function lineageDirOrThrow(commonDir: string, lineage: string): string {
  if (!checkRoot(commonDir, false)) throw new StoreNotFoundError(storeRootFor(commonDir));
  const dir = join(storeRootFor(commonDir), lineage);
  if (!realDirExists(dir)) throw new StoreNotFoundError(dir);
  return dir;
}

/** Secure read of a store file: undefined when absent. */
function readSecure(path: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP" || code === "EMLINK") throw new StoreCorruptError("not-regular", path, "refusing to follow a symlink");
    throw new StoreCorruptError("unreadable", path, (e as Error).message);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new StoreCorruptError("not-regular", path, "not a regular file");
    if (st.nlink > 1) throw new StoreCorruptError("not-regular", path, `hardlinked (nlink ${st.nlink})`);
    if (st.size > MAX_STATE_BYTES) throw new StoreCorruptError("oversized", path, `${st.size} bytes exceeds ${MAX_STATE_BYTES}`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.allocUnsafe(Math.min(65_536, MAX_STATE_BYTES + 1 - total));
      let n: number;
      try {
        n = readSync(fd, buf, 0, buf.length, null);
      } catch (e) {
        throw new StoreCorruptError("unreadable", path, (e as Error).message);
      }
      if (n === 0) break;
      total += n;
      if (total > MAX_STATE_BYTES) throw new StoreCorruptError("oversized", path, `exceeds ${MAX_STATE_BYTES} bytes`);
      chunks.push(buf.subarray(0, n));
    }
    return Buffer.concat(chunks);
  } finally {
    closeSync(fd);
  }
}

function parseJson(raw: Buffer, path: string): unknown {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch (e) {
    throw new StoreCorruptError("invalid-json", path, (e as Error).message);
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function decodeState(raw: Buffer, path: string, lineage: string): StateRecord {
  const parsed = parseJson(raw, path);
  const v = validateStateRecord(parsed);
  if (!v.ok) {
    const onlyRevision = v.errors.length > 0 && v.errors.every((m) => m.startsWith("revision "));
    throw new StoreCorruptError(onlyRevision ? "revision-mismatch" : "invalid-record", path, v.errors.join("; "), v.errors);
  }
  if (v.record.lineage_id !== lineage) throw new StoreCorruptError("lineage-mismatch", path, `record belongs to ${v.record.lineage_id}`);
  return v.record;
}

function syncDir(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** temp (same dir, unique, 0600) -> write -> fsync -> rename -> fsync dir. Removes the temp on any failure before the rename. */
export function writeAtomic(path: string, payload: Buffer | string): void {
  const dir = join(path, "..");
  const temp = join(dir, `.atomic-${process.pid}-${randomBytes(8).toString("hex")}`);
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    try {
      fchmodSync(fd, 0o600);
      let off = 0;
      while (off < data.length) off += writeSync(fd, data, off, data.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    renamed = true;
  } finally {
    if (!renamed) rmSync(temp, { force: true });
  }
  syncDir(dir);
}

/** Held under the store lock: every `.atomic-*` temp in the lineage dir belongs to a dead writer. Best effort. */
function sweepTemps(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      if (!TEMP_RE.test(name)) continue;
      const st = lstatSync(join(dir, name));
      if (st.isFile()) rmSync(join(dir, name), { force: true });
    }
  } catch {
    // best effort
  }
}

/**
 * Removes the directories a crash in the middle of START leaves behind. Runs ONLY from createState, under the store root lock
 * (every writer holds it, so nothing here can be mid-creation), before the new lineage is made. Never from a read-only call.
 * A lineage directory goes only when ALL hold: the name is a lineage id; it is a real directory (lstat, never a symlink); it
 * holds nothing but `.atomic-*` temps (so no state, no receipt, no LOCK, no other file, no subdirectory); every temp is a
 * regular file with a single link; the directory and every temp are older than `minAgeMs`. Files go with `unlinkSync`, then
 * `rmdirSync` (never recursive: a surprise entry makes it fail with ENOTEMPTY and the directory stays). Nothing is followed.
 * At most `max` directories are removed and `ABANDONED_SWEEP_EXAMINE_MAX` examined per call. A failure on one directory is
 * swallowed and that directory skipped; a sweep never fails START. Upstream has no automatic sweep (only a human-authorized
 * `review abandon`); this one is deliberately narrower: it can only ever remove a directory that has never held authority.
 */
function sweepAbandonedLineages(root: string, options: SweepOptions = {}): void {
  const now = (options.now ?? Date.now)();
  const minAge = options.minAgeMs ?? ABANDONED_MIN_AGE_MS;
  const max = options.max ?? ABANDONED_SWEEP_MAX;
  const old = (mtimeMs: number): boolean => now - mtimeMs > minAge;
  let removed = 0;
  let examined = 0;
  let dir: ReturnType<typeof opendirSync> | undefined;
  try {
    dir = opendirSync(root);
    for (let scanned = 0; removed < max && examined < ABANDONED_SWEEP_EXAMINE_MAX && scanned < MAX_LINEAGES; scanned++) {
      const ent = dir.readSync();
      if (!ent) break;
      if (!LINEAGE_RE.test(ent.name)) continue;
      try {
        const path = join(root, ent.name);
        const st = lstatSync(path);
        if (!st.isDirectory() || !old(st.mtimeMs)) continue;
        examined++;
        const names = readdirSync(path);
        if (!names.every((n) => TEMP_RE.test(n))) continue;
        const temps = names.map((n) => join(path, n));
        const ok = temps.every((f) => {
          const ts = lstatSync(f);
          return ts.isFile() && ts.nlink === 1 && old(ts.mtimeMs);
        });
        if (!ok) continue;
        for (const f of temps) unlinkSync(f);
        rmdirSync(path);
        removed++;
      } catch {
        // skipped: raced, unreadable, not empty... never fatal
      }
    }
  } catch {
    // best effort
  } finally {
    try {
      dir?.closeSync();
    } catch {
      // ignore
    }
  }
}

function readStateImpl(commonDir: string, lineage: string): StateRecord {
  assertLineage(lineage);
  const dir = lineageDirOrThrow(commonDir, lineage);
  const path = join(dir, STATE_FILE);
  const raw = readSecure(path);
  if (!raw) throw new StoreNotFoundError(path);
  return decodeState(raw, path, lineage);
}

async function createStateImpl(commonDir: string, record: StateRecord, options: StoreOptions = {}): Promise<StateRecord> {
  const lineage: unknown = (record as { lineage_id?: unknown } | null)?.lineage_id;
  assertLineage(lineage);
  const v = validateStateRecord(record);
  if (!v.ok) throw new StoreInvalidRecordError(v.errors);
  checkRoot(commonDir, true);
  const root = storeRootFor(commonDir);
  return withStoreLock(
    root,
    () => {
      sweepAbandonedLineages(root, options.sweep);
      const dir = join(root, lineage);
      const st = lstatOrNull(dir);
      if (st && !st.isDirectory()) throw new StoreAlreadyExistsError(dir);
      const file = join(dir, STATE_FILE);
      if (st) {
        if (lstatOrNull(file)) throw new StoreAlreadyExistsError(file);
      } else {
        mkdirSync(dir, { mode: 0o700 });
        syncDir(root);
      }
      sweepTemps(dir);
      writeAtomic(file, `${canonicalJson(v.record)}\n`);
      return v.record;
    },
    options.lock,
  );
}

async function updateStateImpl<T extends object = object>(
  commonDir: string,
  lineage: string,
  expectedRevision: string,
  transition: (record: StateRecord) => Outcome<T> | Promise<Outcome<T>>,
  options: StoreOptions = {},
): Promise<Extract<Outcome<T>, { ok: true }>> {
  assertLineage(lineage);
  lineageDirOrThrow(commonDir, lineage);
  return withStoreLock(
    storeRootFor(commonDir),
    async () => {
      const dir = lineageDirOrThrow(commonDir, lineage);
      const file = join(dir, STATE_FILE);
      const raw = readSecure(file);
      if (!raw) throw new StoreNotFoundError(file);
      const current = decodeState(raw, file, lineage);
      if (current.revision !== expectedRevision) throw new StoreConcurrentUpdateError(expectedRevision, current.revision);
      const outcome = await transition(current);
      if (!outcome.ok) throw new StoreTransitionRefusedError(outcome.refusal);
      const v = validateStateRecord(outcome.record);
      if (!v.ok) throw new StoreInvalidRecordError(v.errors);
      if (v.record.lineage_id !== lineage) throw new StoreInvalidRecordError([`transition changed lineage_id to ${v.record.lineage_id}`]);
      sweepTemps(dir);
      writeAtomic(file, `${canonicalJson(v.record)}\n`);
      return { ...outcome, record: v.record } as Extract<Outcome<T>, { ok: true }>;
    },
    options.lock,
  );
}

/** Create-only atomic receipt write (`review-receipt.json`). */
async function writeReceiptImpl(commonDir: string, lineage: string, receipt: object, options: StoreOptions = {}): Promise<void> {
  assertLineage(lineage);
  if (!isPlainObject(receipt)) throw new StoreInvalidRecordError(["receipt must be a JSON object"]);
  const payload = `${canonicalJson(receipt)}\n`;
  if (Buffer.byteLength(payload) > MAX_STATE_BYTES) throw new StoreInvalidRecordError([`receipt exceeds ${MAX_STATE_BYTES} bytes`]);
  lineageDirOrThrow(commonDir, lineage);
  await withStoreLock(
    storeRootFor(commonDir),
    () => {
      const dir = lineageDirOrThrow(commonDir, lineage);
      readState(commonDir, lineage); // a receipt only ever belongs to a valid state
      const file = join(dir, RECEIPT_FILE);
      if (lstatOrNull(file)) throw new StoreAlreadyExistsError(file);
      sweepTemps(dir);
      writeAtomic(file, payload);
    },
    options.lock,
  );
}

function readReceiptImpl(commonDir: string, lineage: string): Record<string, unknown> {
  assertLineage(lineage);
  const dir = lineageDirOrThrow(commonDir, lineage);
  const path = join(dir, RECEIPT_FILE);
  const raw = readSecure(path);
  if (!raw) throw new StoreNotFoundError(path);
  const parsed = parseJson(raw, path);
  if (!isPlainObject(parsed)) throw new StoreCorruptError("invalid-record", path, "receipt must be a JSON object");
  return parsed;
}

export interface LineageListing {
  lineages: string[];
  /** True when the scan cap was hit with entries left unread, or more lineages exist than `limit`. */
  truncated: boolean;
}

/**
 * Sorted lineage ids. Scans at most `maxScan` (default MAX_LINEAGES) directory entries; ignores LOCK, temps, files,
 * symlinks and junk names. Only real lineage directories count against `limit`.
 */
function listLineagesImpl(commonDir: string, options: { limit?: number; maxScan?: number } = {}): LineageListing {
  if (!checkRoot(commonDir, false)) return { lineages: [], truncated: false };
  const root = storeRootFor(commonDir);
  const maxScan = options.maxScan ?? MAX_LINEAGES;
  const found: string[] = [];
  let truncated = false;
  const dir = opendirSync(root);
  try {
    let scanned = 0;
    for (;;) {
      if (scanned >= maxScan) {
        truncated = dir.readSync() !== null;
        break;
      }
      const ent = dir.readSync();
      if (!ent) break;
      scanned++;
      if (!LINEAGE_RE.test(ent.name)) continue;
      const st = lstatOrNull(join(root, ent.name));
      if (st?.isDirectory()) found.push(ent.name);
    }
  } finally {
    dir.closeSync();
  }
  found.sort();
  const limit = options.limit === undefined ? found.length : Math.max(0, options.limit);
  if (found.length > limit) truncated = true;
  return { lineages: found.slice(0, limit), truncated };
}

export function readState(commonDir: string, lineage: string): StateRecord {
  return guard(() => readStateImpl(commonDir, lineage));
}
export function createState(commonDir: string, record: StateRecord, options: StoreOptions = {}): Promise<StateRecord> {
  return guardAsync(() => createStateImpl(commonDir, record, options));
}
export function updateState<T extends object = object>(
  commonDir: string,
  lineage: string,
  expectedRevision: string,
  transition: (record: StateRecord) => Outcome<T> | Promise<Outcome<T>>,
  options: StoreOptions = {},
): Promise<Extract<Outcome<T>, { ok: true }>> {
  return guardAsync(() => updateStateImpl(commonDir, lineage, expectedRevision, transition, options));
}
export function writeReceipt(commonDir: string, lineage: string, receipt: object, options: StoreOptions = {}): Promise<void> {
  return guardAsync(() => writeReceiptImpl(commonDir, lineage, receipt, options));
}
export function readReceipt(commonDir: string, lineage: string): Record<string, unknown> {
  return guard(() => readReceiptImpl(commonDir, lineage));
}
export function listLineages(commonDir: string, options: { limit?: number; maxScan?: number } = {}): LineageListing {
  return guard(() => listLineagesImpl(commonDir, options));
}

export { stateRevision };
