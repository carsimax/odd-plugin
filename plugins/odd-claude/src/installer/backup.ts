// Copy of every Claude-dir file before the installer changes it.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { InstallPaths } from "./paths.js";

export interface BackupInfo {
  id: string;
  dir: string;
  /** Paths relative to the Claude dir (posix separators). */
  files: string[];
}

const posix = (p: string): string => p.split(sep).join("/");

function relUnder(root: string, abs: string): string {
  const rel = relative(root, abs);
  if (rel === "" || rel.split(sep)[0] === ".." || rel.startsWith(sep)) throw new Error(`${abs} is outside ${root}`);
  return rel;
}

function newBackupDir(backupsDir: string): string {
  const base = new Date().toISOString().replace(/[:.]/g, "-");
  for (let i = 0; ; i++) {
    const dir = join(backupsDir, i === 0 ? base : `${base}-${i}`);
    if (!existsSync(dir)) return dir;
  }
}

/** Copies each existing target into backups/<timestamp>/<relPath>. Returns the dir, or null when nothing existed. */
export function backupFiles(paths: InstallPaths, absPaths: readonly string[]): string | null {
  const rels = absPaths.map((abs) => ({ abs, rel: relUnder(paths.claudeDir, abs) }));
  const existing = rels.filter(({ abs }) => existsSync(abs) && lstatSync(abs).isFile());
  if (existing.length === 0) return null;
  const dir = newBackupDir(paths.backupsDir);
  for (const { abs, rel } of existing) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
  }
  return dir;
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), base) : [posix(relative(base, join(dir, e.name)))]));
}

/** Oldest first. */
export function listBackups(paths: InstallPaths): BackupInfo[] {
  if (!existsSync(paths.backupsDir)) return [];
  return readdirSync(paths.backupsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, dir: join(paths.backupsDir, e.name), files: walk(join(paths.backupsDir, e.name)).sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Copies every file of the backup back under the Claude dir, overwriting. Returns the restored relative paths. */
export function restoreBackup(paths: InstallPaths, id: string): string[] {
  const info = listBackups(paths).find((b) => b.id === id);
  if (!info) throw new Error(`unknown backup ${JSON.stringify(id)}`);
  for (const rel of info.files) {
    const dest = join(paths.claudeDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(info.dir, rel), dest);
  }
  return info.files;
}
