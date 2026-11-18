// Shared state-file helper. State lives under CLAUDE_PLUGIN_DATA (set by Claude Code for
// hooks) or an explicit `dataDir` option (tests/CLI); never under ~/.claude directly.
// Layout: <dataDir>/sessions/<session>.json  and  <dataDir>/logs/hooks.log
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const STATE_SCHEMA_VERSION = 1;

export type StateData = Record<string, unknown>;

export interface StateOptions {
  /** Explicit data dir; wins over the environment. */
  dataDir?: string;
  /** Environment to read CLAUDE_PLUGIN_DATA from (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

interface StateFile {
  version: number;
  sessionId: string;
  data: StateData;
}

export function resolveDataDir(opts: StateOptions = {}): string {
  const dir = opts.dataDir ?? (opts.env ?? process.env).CLAUDE_PLUGIN_DATA;
  if (!dir) throw new Error("no data dir: set CLAUDE_PLUGIN_DATA or pass dataDir");
  return dir;
}

function safeSegment(id: string): string {
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

export function updateSessionState(
  sessionId: string,
  update: (current: StateData) => StateData,
  opts: StateOptions = {},
): StateData {
  const next = update(readSessionState(sessionId, opts));
  writeSessionState(sessionId, next, opts);
  return next;
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
