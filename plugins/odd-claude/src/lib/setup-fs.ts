// Write path of /odd-claude:setup. Real filesystem; callers (tests/CLI) pick the paths.
// Order on apply: validate/plan -> backup original (atomic) -> record state -> atomic write.
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, readPluginState, writePluginState } from "./state.js";
import {
  BACKUP_NAME_RE,
  NO_CHANGES,
  SHIM_NAME,
  backupFileName,
  planModeChange,
  planStatusLineChange,
  shimSource,
  statusLineCommand,
  unifiedDiff,
  type StatusLineAction,
  type StatusLinePlan,
} from "./setup.js";

export interface SetupOptions {
  settingsPath: string;
  dataDir: string;
  now?: Date;
}

export interface ApplyResult {
  status: "applied" | "unchanged" | "error";
  diff: string;
  backupPath?: string;
  error?: string;
}

export type RestorePlan =
  | { ok: true; changed: boolean; diff: string; backupPath: string; content: Buffer }
  | { ok: false; error: string };

function readCurrent(path: string): Buffer | null {
  return existsSync(path) ? readFileSync(path) : null;
}

export function backupsDir(dataDir: string): string {
  return join(dataDir, "backups");
}

/** Backup file names, newest first (names embed a sortable timestamp). */
export function listBackups(dataDir: string): string[] {
  try {
    return readdirSync(backupsDir(dataDir))
      .filter((f) => BACKUP_NAME_RE.test(f))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

type Target = { ok: true; path: string } | { ok: false; error: string };

/** Follows a symlinked settings file so the link is kept and its target updated. */
function resolveTarget(path: string): Target {
  try {
    if (lstatSync(path).isSymbolicLink()) return { ok: true, path: realpathSync(path) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // lstat failing means the path itself is missing: fine (will be created)
      return { ok: true, path };
    }
    return { ok: false, error: `cannot inspect ${path}: ${(err as Error).message}` };
  }
  return { ok: true, path };
}

/** Error text when an existing target cannot be written by this user; undefined when fine. */
function notWritable(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    accessSync(path, constants.W_OK);
    return undefined;
  } catch {
    return `${path} is not writable by this user (read-only?); refusing to overwrite it`;
  }
}

function writeBackup(dataDir: string, original: Buffer, now: Date): string {
  const dir = backupsDir(dataDir);
  let path = join(dir, backupFileName(now));
  for (let n = 1; existsSync(path); n++) path = join(dir, backupFileName(now).replace(/\.json$/, `-${n}.json`));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFile(path, original, 0o600);
  return path;
}

function record(dataDir: string, backupPath: string): void {
  const prev = readPluginState("setup", { dataDir });
  const backups = Array.isArray(prev.backups) ? (prev.backups as string[]) : [];
  writePluginState("setup", { ...prev, lastBackup: backupPath, backups: [...backups, backupPath] }, { dataDir });
}

function fileMode(path: string): number | undefined {
  return existsSync(path) ? statSync(path).mode & 0o7777 : undefined;
}

/** Shared tail of apply/restore: backup current, record state, atomic write keeping the mode. */
function commit(opts: SetupOptions, target: string, content: string | Buffer, diff: string, what: string): ApplyResult {
  let backupPath: string | undefined;
  try {
    const cur = readCurrent(target);
    if (cur !== null) {
      backupPath = writeBackup(opts.dataDir, cur, opts.now ?? new Date());
      record(opts.dataDir, backupPath);
    }
    atomicWriteFile(target, content, fileMode(target));
    return { status: "applied", diff, backupPath };
  } catch (err) {
    const kept = backupPath ? `; backup kept at ${backupPath}` : "";
    return { status: "error", diff, error: `${what} failed: ${(err as Error).message}${kept}; settings left as they were`, backupPath };
  }
}

export function applyMode(opts: SetupOptions & { mode: string }): ApplyResult {
  const t = resolveTarget(opts.settingsPath);
  if (!t.ok) return { status: "error", diff: NO_CHANGES, error: t.error };
  if (lstatDangling(opts.settingsPath, t.path)) return { status: "error", diff: NO_CHANGES, error: `${opts.settingsPath} is a dangling symlink` };
  let cur: Buffer | null;
  try {
    cur = readCurrent(t.path);
  } catch (err) {
    return { status: "error", diff: NO_CHANGES, error: `cannot read ${t.path}: ${(err as Error).message}` };
  }
  const plan = planModeChange(cur === null ? null : cur.toString("utf8"), opts.mode, opts.settingsPath);
  if (!plan.ok) return { status: "error", diff: NO_CHANGES, error: plan.error };
  if (!plan.changed) return { status: "unchanged", diff: plan.diff };
  const nw = notWritable(t.path);
  if (nw) return { status: "error", diff: plan.diff, error: nw };
  return commit(opts, t.path, plan.after, plan.diff, "write");
}

export function shimPath(dataDir: string): string {
  return join(dataDir, SHIM_NAME);
}

/** Existing shim rewritten when the plugin root moved (plugin update). Never creates it. */
export function refreshStatuslineShim(dataDir: string, pluginRoot: string): boolean {
  try {
    const p = shimPath(dataDir);
    const want = shimSource(pluginRoot);
    if (!existsSync(p) || readFileSync(p, "utf8") === want) return false;
    atomicWriteFile(p, want, 0o644);
    return true;
  } catch {
    return false;
  }
}

export interface StatusLineOptions extends SetupOptions {
  action: StatusLineAction;
  pluginRoot: string;
  /** Explicit consent to replace a statusLine odd-claude did not write. */
  replaceForeign?: boolean;
}

function previousStatusLine(dataDir: string): unknown {
  try {
    return readPluginState("setup", { dataDir }).statusLinePrevious;
  } catch {
    return undefined;
  }
}

/** Read-only plan (dry run): the same computation apply uses. */
export function planStatusLine(opts: StatusLineOptions): StatusLinePlan {
  const t = resolveTarget(opts.settingsPath);
  if (!t.ok) return { ok: false, error: t.error };
  if (lstatDangling(opts.settingsPath, t.path)) return { ok: false, error: `${opts.settingsPath} is a dangling symlink` };
  let cur: Buffer | null;
  try {
    cur = readCurrent(t.path);
  } catch (err) {
    return { ok: false, error: `cannot read ${t.path}: ${(err as Error).message}` };
  }
  return planStatusLineChange(cur === null ? null : cur.toString("utf8"), opts.action, { command: statusLineCommand(shimPath(opts.dataDir)), previous: previousStatusLine(opts.dataDir) }, opts.settingsPath);
}

export function applyStatusLine(opts: StatusLineOptions): ApplyResult {
  const plan = planStatusLine(opts);
  if (!plan.ok) return { status: "error", diff: NO_CHANGES, error: plan.error };
  if (!plan.changed) return { status: "unchanged", diff: plan.diff };
  if (plan.foreign && !opts.replaceForeign) {
    return { status: "error", diff: plan.diff, error: "settings already has a statusLine that odd-claude did not write; nothing was written. Re-run with --replace-statusline to replace it (the original stays in the backup)" };
  }
  const t = resolveTarget(opts.settingsPath);
  if (!t.ok) return { status: "error", diff: plan.diff, error: t.error };
  const nw = notWritable(t.path);
  if (nw) return { status: "error", diff: plan.diff, error: nw };
  if (opts.action === "on") {
    try {
      atomicWriteFile(shimPath(opts.dataDir), shimSource(opts.pluginRoot), 0o644);
    } catch (err) {
      return { status: "error", diff: plan.diff, error: `cannot write the statusLine shim: ${(err as Error).message}; settings left as they were` };
    }
  }
  const replaced = plan.before === null ? undefined : (JSON.parse(plan.before) as Record<string, unknown>).statusLine;
  const res = commit(opts, t.path, plan.after, plan.diff, "write");
  if (res.status !== "applied") return res;
  try {
    const prev = readPluginState("setup", { dataDir: opts.dataDir });
    if (opts.action === "on" && plan.foreign) writePluginState("setup", { ...prev, statusLinePrevious: replaced }, { dataDir: opts.dataDir });
    else if (opts.action === "off" && "statusLinePrevious" in prev) {
      const { statusLinePrevious: _gone, ...rest } = prev;
      writePluginState("setup", rest, { dataDir: opts.dataDir });
    }
  } catch {
    // the settings write succeeded; only the "previous value" bookkeeping is lost (the backup still has it)
  }
  return res;
}

/** A symlink whose target does not exist: realpath would have thrown, so the path is unchanged. */
function lstatDangling(path: string, resolved: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && !existsSync(resolved);
  } catch {
    return false;
  }
}

export function planRestore(opts: SetupOptions & { backup?: string }): RestorePlan {
  const names = listBackups(opts.dataDir);
  let name: string | undefined;
  if (opts.backup === undefined) name = names[0];
  else name = names.includes(opts.backup) ? opts.backup : undefined;
  if (name === undefined) {
    return {
      ok: false,
      error: opts.backup === undefined ? "no backups to restore" : `unknown backup "${opts.backup}"; available: ${names.join(", ") || "none"}`,
    };
  }
  const backupPath = join(backupsDir(opts.dataDir), name);
  const content = readFileSync(backupPath);
  try {
    JSON.parse(content.toString("utf8"));
  } catch {
    return { ok: false, error: `backup ${name} is not valid JSON; refusing to restore it` };
  }
  let cur: Buffer | null;
  try {
    cur = readCurrent(opts.settingsPath);
  } catch (err) {
    return { ok: false, error: `cannot read ${opts.settingsPath}: ${(err as Error).message}` };
  }
  const same = cur !== null && cur.equals(content);
  const diff = same ? NO_CHANGES : unifiedDiff(cur === null ? "" : cur.toString("utf8"), content.toString("utf8"), opts.settingsPath, `${opts.settingsPath} (restored from ${name})`);
  return { ok: true, changed: !same, diff, backupPath, content };
}

/** Restores atomically; the current file is backed up first so a restore is itself reversible. */
export function applyRestore(opts: SetupOptions & { backup?: string }): ApplyResult {
  const plan = planRestore(opts);
  if (!plan.ok) return { status: "error", diff: NO_CHANGES, error: plan.error };
  if (!plan.changed) return { status: "unchanged", diff: plan.diff };
  const t = resolveTarget(opts.settingsPath);
  if (!t.ok) return { status: "error", diff: plan.diff, error: t.error };
  const nw = notWritable(t.path);
  if (nw) return { status: "error", diff: plan.diff, error: nw };
  return commit(opts, t.path, plan.content, plan.diff, "restore");
}
