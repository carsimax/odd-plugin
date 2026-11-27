// Shared state-file helper. The data dir resolves, in order: an explicit `dataDir` option (tests/CLI),
// ODD_CLAUDE_DATA, CLAUDE_PLUGIN_DATA (plugin distribution), then `${ODD_CLAUDE_HOME:-~/.odd-claude}/data`;
// never under ~/.claude directly.
// Layout: <dataDir>/sessions/<session>.json  and  <dataDir>/logs/hooks.log
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { acquireLock, releaseOwnedLock } from "./lock.js";

export const STATE_SCHEMA_VERSION = 1;

export type StateData = Record<string, unknown>;

export interface StateOptions {
  /** Explicit data dir; wins over the environment. */
  dataDir?: string;
  /** Environment to read ODD_CLAUDE_DATA / CLAUDE_PLUGIN_DATA / ODD_CLAUDE_HOME from (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

interface StateFile {
  version: number;
  sessionId: string;
  data: StateData;
}

/** Data dir from the environment alone: ODD_CLAUDE_DATA > CLAUDE_PLUGIN_DATA > `${ODD_CLAUDE_HOME:-~/.odd-claude}/data`. */
export function dataDirFromEnv(env: Record<string, string | undefined> = process.env): string {
  // CLAUDE_PLUGIN_DATA is legacy (removed plugin distribution; bench still sets it).
  const explicit = env.ODD_CLAUDE_DATA || env.CLAUDE_PLUGIN_DATA;
  if (explicit) return explicit;
  const oddHome = env.ODD_CLAUDE_HOME || join(env.HOME || homedir(), ".odd-claude");
  return join(oddHome, "data");
}

export function resolveDataDir(opts: StateOptions = {}): string {
  const dir = opts.dataDir ?? dataDirFromEnv(opts.env ?? process.env);
  // A relative dir would resolve against the hook's cwd and could make scratch removal hit the project tree.
  if (!isAbsolute(dir)) throw new Error("data dir must be an absolute path");
  return dir;
}

export function safeSegment(id: string): string {
  const s = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return s === "" ? "_" : s;
}

export function sessionStatePath(sessionId: string, opts: StateOptions = {}): string {
  return join(resolveDataDir(opts), "sessions", `${safeSegment(sessionId)}.json`);
}

/** Returns the stored data, or {} when missing, corrupt or of another schema version. */
export function readSessionState(sessionId: string, opts: StateOptions = {}): StateData {
  try {
    const parsed = JSON.parse(readFileSync(sessionStatePath(sessionId, opts), "utf8")) as Partial<StateFile>;
    if (parsed.version !== STATE_SCHEMA_VERSION || typeof parsed.data !== "object" || parsed.data === null) return {};
    return parsed.data;
  } catch {
    return {};
  }
}

/** Atomic write: temp file in the same dir as `path`, then rename. Creates the dir. */
export function atomicWriteFile(path: string, content: string | Buffer, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    // `mode` is applied explicitly (chmod) so the umask cannot widen or narrow it.
    writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function writeSessionState(sessionId: string, data: StateData, opts: StateOptions = {}): void {
  const body: StateFile = { version: STATE_SCHEMA_VERSION, sessionId, data };
  atomicWriteFile(sessionStatePath(sessionId, opts), JSON.stringify(body, null, 2) + "\n");
}

/** Plugin-wide (non-session) state at <dataDir>/<name>.json, e.g. `setup`. Same envelope. */
export function readPluginState(name: string, opts: StateOptions = {}): StateData {
  try {
    const parsed = JSON.parse(readFileSync(join(resolveDataDir(opts), `${safeSegment(name)}.json`), "utf8")) as Partial<StateFile>;
    if (parsed.version !== STATE_SCHEMA_VERSION || typeof parsed.data !== "object" || parsed.data === null) return {};
    return parsed.data;
  } catch {
    return {};
  }
}

export function writePluginState(name: string, data: StateData, opts: StateOptions = {}): void {
  const body: StateFile = { version: STATE_SCHEMA_VERSION, sessionId: name, data };
  atomicWriteFile(join(resolveDataDir(opts), `${safeSegment(name)}.json`), JSON.stringify(body, null, 2) + "\n");
}

/** Throws when the file exists with another schema version: an update would silently destroy it. Missing or corrupt files pass. */
function assertSchemaMatches(path: string): void {
  let version: unknown;
  try {
    version = (JSON.parse(readFileSync(path, "utf8")) as Partial<StateFile>).version;
  } catch {
    return;
  }
  if (version !== undefined && version !== STATE_SCHEMA_VERSION) throw new Error(`session state has schema version ${String(version)}; refusing to overwrite`);
}

const LOCK_WAIT_MS = 1000;
const LOCK_STALE_MS = 2000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read-modify-write under a short cross-process lock (`<session>.json.lock`, shared lock.ts semantics), so parallel
 * hook processes neither lose counts nor double-fire a once-per-turn notice. Spins up to ~1s; on timeout it throws
 * and the caller (run.js) fails open: no output, nothing blocked. Returning the same object skips the write.
 */
export function updateSessionState(
  sessionId: string,
  update: (current: StateData) => StateData,
  opts: StateOptions = {},
): StateData {
  const lock = `${sessionStatePath(sessionId, opts)}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!acquireLock(lock, process.pid, { staleMs: LOCK_STALE_MS, proofOfDeathOnly: true })) {
    if (Date.now() >= deadline) throw new Error("session state lock timeout");
    sleepSync(3 + Math.random() * 5); // jitter so backing-off takeover claimants do not retry in lockstep
  }
  try {
    assertSchemaMatches(sessionStatePath(sessionId, opts));
    const current = readSessionState(sessionId, opts);
    const next = update(current);
    if (next !== current) writeSessionState(sessionId, next, opts);
    return next;
  } finally {
    releaseOwnedLock(lock, process.pid);
  }
}

/** Appends one line to <dataDir>/logs/hooks.log. Never throws. */
export function logError(message: string, opts: StateOptions = {}): void {
  try {
    const dir = join(resolveDataDir(opts), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "hooks.log"), `${new Date().toISOString()} ${message.replace(/\n/g, " ")}\n`, "utf8");
  } catch {
    // logging must never break a hook
  }
}

const PRUNE_AGE_MS = 7 * 86_400_000;

/** Deletes `*.json` in sessions/ and status/ older than 7 days (mtime), never `keepId`'s nor one with a `.lock` beside it. Never throws. */
export function pruneStaleSessionFiles(keepId: string, opts: StateOptions = {}, now: number = Date.now()): void {
  for (const sub of ["sessions", "status"]) {
    try {
      const dir = join(resolveDataDir(opts), sub);
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json") || f === `${safeSegment(keepId)}.json`) continue;
        try {
          const p = join(dir, f);
          if (now - statSync(p).mtimeMs > PRUNE_AGE_MS && !existsSync(`${p}.lock`)) rmSync(p, { force: true });
        } catch {
          // vanished or unreadable: leave it
        }
      }
    } catch {
      // missing dir
    }
  }
}

/** Session ids (file stems) newest first by mtime; [] when the dir is missing. Read-only. */
export function listSessionIds(opts: StateOptions = {}): string[] {
  try {
    const dir = join(resolveDataDir(opts), "sessions");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ id: f.slice(0, -".json".length), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? -1 : 1))
      .map((e) => e.id);
  } catch {
    return [];
  }
}
