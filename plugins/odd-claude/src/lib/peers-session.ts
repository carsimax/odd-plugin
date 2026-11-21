// This session's id for the peers MCP server (R07 P3). An MCP server is not handed the Claude Code session_id, so the
// SessionStart hook records `<data>/peers/.current/<claude-pid>.json` ({session_id}) keyed by its parent process (the Claude Code
// process); the MCP server, a sibling child of that same process, reads the entry for its own parent pid.
// ASSUMPTION (unverified against the real claude): the hook's process.ppid and the MCP server's process.ppid are the same pid.
// Order of resolution: the hook's pid entry (when valid) -> env CLAUDE_CODE_SESSION_ID (fallback only, when valid; the name Claude Code
// exports into its Bash tool environment, whether MCP servers receive it is unverified) -> null (the tool says "unknown" with guidance).
// The hook entry wins because it comes from the hook input; an inherited env var could be stale or belong to another session.
// CLAUDE_SESSION_ID is not read: Claude Code does not export that name.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, resolveDataDir, type StateOptions } from "./state.js";
import { isValidSessionId } from "./peers.js";

export const MAX_CURRENT_ENTRIES = 50;
export const CURRENT_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRY_BYTES = 4096;
const ENTRY_RE = /^(\d{1,10})\.json$/;

export interface CurrentOptions extends StateOptions {
  now?: () => number;
}

export interface ResolvedSession {
  session_id: string;
  source: "env" | "hook";
}

export function currentDir(opts: StateOptions = {}): string {
  return join(resolveDataDir(opts), "peers", ".current");
}

function ensureDir(path: string): void {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`unsafe peers dir: ${path}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(path, { mode: 0o700 });
  }
}

const isPid = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 1 && n <= 0x7fffffff;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Atomic private (0600) write of the pid entry, then prunes stale entries (older than 7 days, dead pid) and caps the dir at 50. Throws on invalid input or an unsafe dir. */
export function recordCurrentSession(sessionId: string, pid: number, opts: CurrentOptions = {}): void {
  if (!isValidSessionId(sessionId)) throw new Error("invalid session id");
  if (!isPid(pid)) throw new Error("invalid pid");
  const data = resolveDataDir(opts);
  mkdirSync(data, { recursive: true });
  ensureDir(join(data, "peers"));
  const dir = currentDir(opts);
  ensureDir(dir);
  const now = (opts.now ?? Date.now)();
  atomicWriteFile(join(dir, `${pid}.json`), JSON.stringify({ session_id: sessionId, recorded_at: new Date(now).toISOString() }) + "\n", 0o600);
  prune(dir, pid, now);
}

function prune(dir: string, keepPid: number, now: number): void {
  try {
    const entries: { name: string; pid: number; mtime: number }[] = [];
    for (const name of readdirSync(dir)) {
      const m = ENTRY_RE.exec(name);
      if (m === null) continue;
      const st = lstatSync(join(dir, name));
      if (!st.isFile()) continue;
      entries.push({ name, pid: Number(m[1]), mtime: st.mtimeMs });
    }
    const keep = entries.filter((e) => {
      if (e.pid === keepPid) return true;
      if (now - e.mtime > CURRENT_STALE_MS || !alive(e.pid)) {
        try { unlinkSync(join(dir, e.name)); } catch { /* already gone */ }
        return false;
      }
      return true;
    });
    keep.sort((a, b) => b.mtime - a.mtime);
    for (const e of keep.slice(MAX_CURRENT_ENTRIES)) {
      if (e.pid === keepPid) continue;
      try { unlinkSync(join(dir, e.name)); } catch { /* already gone */ }
    }
  } catch {
    // pruning is best effort
  }
}

/** Reads the entry for `pid`; null when missing, unsafe, oversized, corrupt or holding an invalid id. Read-only. */
export function readCurrentSession(pid: number, opts: StateOptions = {}): string | null {
  if (!isPid(pid)) return null;
  try {
    const data = resolveDataDir(opts);
    for (const d of [join(data, "peers"), currentDir(opts)]) {
      const st = lstatSync(d);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    }
    const file = join(currentDir(opts), `${pid}.json`);
    if (!lstatSync(file).isFile()) return null;
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (fstatSync(fd).size > MAX_ENTRY_BYTES) return null;
      const parsed = JSON.parse(readFileSync(fd, "utf8")) as unknown;
      const id = typeof parsed === "object" && parsed !== null ? (parsed as { session_id?: unknown }).session_id : undefined;
      return isValidSessionId(id) ? id : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function resolveSessionId(pid: number, opts: StateOptions = {}): ResolvedSession | null {
  const id = readCurrentSession(pid, opts);
  if (id !== null) return { session_id: id, source: "hook" };
  const env = (opts.env ?? process.env).CLAUDE_CODE_SESSION_ID;
  return isValidSessionId(env) ? { session_id: env, source: "env" } : null;
}

/** mtime-free helper kept for tests: number of entries in the dir. */
export function currentEntryCount(opts: StateOptions = {}): number {
  try {
    statSync(currentDir(opts));
    return readdirSync(currentDir(opts)).filter((n) => ENTRY_RE.test(n)).length;
  } catch {
    return 0;
  }
}

/** SessionEnd cleanup: removes only `<pid>.json` regular files whose session_id equals `sessionId`. Never touches other files or symlinks; a missing dir is a no-op; a symlinked/unsafe dir throws. */
export function forgetCurrentSession(sessionId: string, opts: StateOptions = {}): void {
  if (!isValidSessionId(sessionId)) throw new Error("invalid session id");
  const dir = currentDir(opts);
  let names: string[];
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`unsafe peers dir: ${dir}`);
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const name of names) {
    const m = ENTRY_RE.exec(name);
    if (m === null) continue;
    const pid = Number(m[1]);
    try {
      if (lstatSync(join(dir, name)).isFile() && readCurrentSession(pid, opts) === sessionId) unlinkSync(join(dir, name));
    } catch {
      // already gone or unreadable: leave it
    }
  }
}
