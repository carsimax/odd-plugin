// Generic, reversible edits of ~/.claude/settings.json (outputStyle, statusLine, claude.ai keys, enabledPlugins...).
// Order on every write: parse (abort on invalid JSON) -> compute -> backup original (0600) -> record state -> atomic write.
// Ownership ledger: <oddHome>/settings-state.json remembers, per JSON path, the value we replaced and the value we wrote,
// so restore only undoes what is still ours. Safe-write primitives come from setup-fs (symlink following, mode keeping).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteFile } from "../lib/state.js";
import { backupFileName } from "../lib/setup.js";
import { fileMode, lstatDangling, notWritable, resolveTarget } from "../lib/setup-fs.js";

export type Settings = Record<string, unknown>;
export interface SettingsChange {
  path: string[];
  value: unknown;
}
export interface ManagedPaths {
  settingsPath: string;
  statePath: string;
  backupDir: string;
  now?: Date;
}
export interface WriteResult {
  status: "applied" | "unchanged" | "error";
  backupPath?: string;
  error?: string;
}
export interface ApplyManagedResult extends WriteResult {
  changed: string[][];
}
export interface RestoreManagedResult extends WriteResult {
  restored: string[][];
  kept: { path: string[]; reason: string }[];
}

interface Owned {
  path: string[];
  previous: { present: boolean; value?: unknown };
  written: unknown;
}
/** Shape of settings-state.json; other modules (mcp) add their own top-level keys and must preserve the rest. */
export interface OddState {
  version?: number;
  settings?: Record<string, Owned>;
  mcp?: { added?: string[] };
  [key: string]: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keyOf = (path: string[]): string => JSON.stringify(path);

export function readOddState(statePath: string): OddState {
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`settings state ${statePath} is not valid JSON; fix or remove it before continuing`);
  }
  return isObject(parsed) ? (parsed as OddState) : {};
}

export function writeOddState(statePath: string, state: OddState): void {
  atomicWriteFile(statePath, JSON.stringify({ ...state, version: 1 }, null, 2) + "\n", 0o600);
}

type Loaded = { ok: true; settings: Settings; existed: boolean; target: string } | { ok: false; error: string };

function loadSettings(settingsPath: string): Loaded {
  const t = resolveTarget(settingsPath);
  if (!t.ok) return { ok: false, error: t.error };
  if (lstatDangling(settingsPath, t.path)) return { ok: false, error: `${settingsPath} is a dangling symlink` };
  if (!existsSync(t.path)) return { ok: true, settings: {}, existed: false, target: t.path };
  let raw: string;
  try {
    raw = readFileSync(t.path, "utf8");
  } catch (err) {
    return { ok: false, error: `cannot read ${t.path}: ${(err as Error).message}` };
  }
  if (raw.trim() === "") return { ok: true, settings: {}, existed: true, target: t.path };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `${settingsPath} is not valid JSON (${(err as Error).message}); refusing to modify it` };
  }
  if (!isObject(parsed)) return { ok: false, error: `${settingsPath} is not a JSON object; refusing to modify it` };
  return { ok: true, settings: parsed, existed: true, target: t.path };
}

function writeBackup(backupDir: string, original: Buffer, now: Date): string {
  let path = join(backupDir, backupFileName(now));
  for (let n = 1; existsSync(path); n++) path = join(backupDir, backupFileName(now).replace(/\.json$/, `-${n}.json`));
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  atomicWriteFile(path, original, 0o600);
  return path;
}

/**
 * Shared transaction: load, run `mutate` on a copy, and when the result differs back up the original and write it
 * atomically. `beforeWrite` runs after the backup and before the write (state recording). `mutate` may return an
 * error string to abort without writing.
 */
export function updateSettingsFile(
  paths: { settingsPath: string; backupDir: string; now?: Date },
  mutate: (settings: Settings) => string | void,
  beforeWrite?: () => void,
): WriteResult {
  const loaded = loadSettings(paths.settingsPath);
  if (!loaded.ok) return { status: "error", error: loaded.error };
  const next = structuredClone(loaded.settings);
  const err = mutate(next);
  if (typeof err === "string") return { status: "error", error: err };
  if (isDeepStrictEqual(next, loaded.settings)) return { status: "unchanged" };
  const nw = notWritable(loaded.target);
  if (nw) return { status: "error", error: nw };
  let backupPath: string | undefined;
  try {
    if (loaded.existed) backupPath = writeBackup(paths.backupDir, readFileSync(loaded.target), paths.now ?? new Date());
    beforeWrite?.();
    atomicWriteFile(loaded.target, JSON.stringify(next, null, 2) + "\n", fileMode(loaded.target));
    return { status: "applied", backupPath };
  } catch (e) {
    const kept = backupPath ? `; backup kept at ${backupPath}` : "";
    return { status: "error", error: `write failed: ${(e as Error).message}${kept}; settings left as they were`, backupPath };
  }
}

function getAt(root: Settings, path: string[]): { present: boolean; value?: unknown } {
  let cur: unknown = root;
  for (const k of path) {
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) return { present: false };
    cur = cur[k];
  }
  return { present: true, value: cur };
}

/** Returns an error string when an intermediate value is not an object. */
function setAt(root: Settings, path: string[], value: unknown): string | undefined {
  let cur: Record<string, unknown> = root;
  for (const k of path.slice(0, -1)) {
    if (!Object.prototype.hasOwnProperty.call(cur, k)) cur[k] = {};
    const next = cur[k];
    if (!isObject(next)) return `settings key "${path.slice(0, path.indexOf(k) + 1).join(".")}" is not an object; refusing to modify it`;
    cur = next;
  }
  cur[path[path.length - 1]] = value;
  return undefined;
}

function deleteAt(root: Settings, path: string[]): void {
  const chain: Record<string, unknown>[] = [root];
  for (const k of path.slice(0, -1)) {
    const next = chain[chain.length - 1][k];
    if (!isObject(next)) return;
    chain.push(next);
  }
  delete chain[chain.length - 1][path[path.length - 1]];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length === 0) delete chain[i - 1][path[i - 1]];
  }
}

export function applyManagedSettings(paths: ManagedPaths, changes: SettingsChange[]): ApplyManagedResult {
  const state = readOddState(paths.statePath);
  const owned: Record<string, Owned> = { ...(state.settings ?? {}) };
  const changed: string[][] = [];
  const r = updateSettingsFile(
    paths,
    (s) => {
      for (const c of changes) {
        const k = keyOf(c.path);
        const before = getAt(s, c.path);
        if (!before.present || !isDeepStrictEqual(before.value, c.value)) changed.push(c.path);
        // Ownership starts the first time we touch the path; later applies keep the original previous value.
        if (!owned[k]) owned[k] = { path: c.path, previous: before.present ? { present: true, value: before.value } : { present: false }, written: c.value };
        else owned[k] = { ...owned[k], written: c.value };
        const err = setAt(s, c.path, c.value);
        if (err) return err;
      }
      return undefined;
    },
    () => writeOddState(paths.statePath, { ...state, settings: owned }),
  );
  if (r.status === "unchanged" && !isDeepStrictEqual(owned, state.settings ?? {})) {
    // Value was already in place (e.g. set by hand): still take ownership so uninstall removes what we asked for.
    writeOddState(paths.statePath, { ...state, settings: owned });
  }
  return { ...r, changed: r.status === "applied" ? changed : [] };
}

export function restoreManagedSettings(paths: ManagedPaths, only?: string[][]): RestoreManagedResult {
  const state = readOddState(paths.statePath);
  const all = state.settings ?? {};
  const wanted = only ? new Set(only.map(keyOf)) : undefined;
  const entries = Object.entries(all).filter(([k]) => !wanted || wanted.has(k));
  if (entries.length === 0) return { status: "unchanged", restored: [], kept: [] };
  const restored: string[][] = [];
  const kept: { path: string[]; reason: string }[] = [];
  const r = updateSettingsFile(paths, (s) => {
    for (const [, o] of entries) {
      const cur = getAt(s, o.path);
      if (cur.present && isDeepStrictEqual(cur.value, o.written)) {
        if (o.previous.present) {
          const err = setAt(s, o.path, o.previous.value);
          if (err) return err;
        } else deleteAt(s, o.path);
        restored.push(o.path);
      } else {
        kept.push({ path: o.path, reason: `${o.path.join(".")} was changed after install; kept your value` });
      }
    }
    return undefined;
  });
  if (r.status === "error") return { ...r, restored: [], kept: [] };
  // Ownership of every handled path ends here, restored or kept.
  const rest = { ...all };
  for (const [k] of entries) delete rest[k];
  writeOddState(paths.statePath, { ...state, settings: rest });
  return { ...r, restored, kept };
}

/** Output style: install sets `outputStyle: "odd"`, uninstall restores the previous value. */
export function installOutputStyle(paths: ManagedPaths): ApplyManagedResult {
  return applyManagedSettings(paths, [{ path: ["outputStyle"], value: "odd" }]);
}

export function uninstallOutputStyle(paths: ManagedPaths): RestoreManagedResult {
  return restoreManagedSettings(paths, [["outputStyle"]]);
}
