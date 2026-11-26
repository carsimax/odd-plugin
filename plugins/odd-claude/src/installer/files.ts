// Install and uninstall of the files under the Claude dir. The ledger (manifest) decides ownership: a file is replaced
// or removed only when its current hash equals the hash recorded when we wrote it.
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { backupFiles } from "./backup.js";
import { atomicWriteFile, readManifest, sha256, writeManifest, type Manifest } from "./manifest.js";
import { agentFileForRole, applyAgentModel, roleCoverage, type ModelSelection } from "./models.js";
import { activeVersion, readTree } from "./payload.js";
import type { InstallPaths } from "./paths.js";
import { resolvePlaceholders } from "./placeholders.js";

export type FileActionKind = "create" | "update" | "unchanged" | "conflict" | "remove";

export interface FileAction {
  action: FileActionKind;
  /** Path relative to the Claude dir (posix separators). */
  rel: string;
  /** Absolute target path. */
  target: string;
  /** Final content for create/update/unchanged. */
  content?: Buffer;
  mode?: number;
  reason?: string;
}

export interface FilePlan {
  actions: FileAction[];
  warnings: string[];
  selection: ModelSelection;
  oddVersion: string;
  coverage: ReturnType<typeof roleCoverage>;
}

export interface InstallResult {
  backupDir: string | null;
  written: string[];
  conflicts: string[];
  removed: string[];
}

const fileHash = (p: string): string | null => {
  try {
    return lstatSync(p).isFile() ? sha256(readFileSync(p)) : null;
  } catch {
    return null;
  }
};
const safeRel = (rel: string): boolean => rel !== "" && !rel.startsWith("/") && !rel.split("/").includes("..");

/** Removes now-empty parents of `file`, stopping at (excluding) the Claude dir. */
function pruneEmptyDirs(claudeDir: string, file: string): void {
  for (let d = dirname(file); d.startsWith(claudeDir + "/") && d !== claudeDir; d = dirname(d)) {
    try {
      if (readdirSync(d).length > 0) return;
      rmdirSync(d);
    } catch {
      return;
    }
  }
}

/** Desired files, from `payloadDir` (default: the `current` link), keyed by Claude-dir-relative path. */
function desiredFiles(paths: InstallPaths, selection: ModelSelection, payloadDir: string): { files: Map<string, { data: Buffer; mode: number }>; agentFiles: string[] } {
  const resolve = (b: Buffer): Buffer => Buffer.from(resolvePlaceholders(b.toString("utf8"), { root: paths.currentLink, data: paths.dataDir }));
  const files = new Map<string, { data: Buffer; mode: number }>();
  const agentFiles: string[] = [];
  const dir = (name: string): string => join(payloadDir, name);
  if (existsSync(dir("skills"))) for (const [rel, f] of readTree(dir("skills"))) files.set(`skills/${rel}`, { data: resolve(f.data), mode: f.mode });
  if (existsSync(dir("agents"))) {
    for (const [rel, f] of readTree(dir("agents"))) {
      if (rel.includes("/") || !rel.endsWith(".md")) continue;
      agentFiles.push(rel);
      const role = rel.slice(0, -3);
      let text = resolve(f.data).toString("utf8");
      const model = selection.roles[role];
      if (model !== undefined && rel === agentFileForRole(role)) text = applyAgentModel(text, model);
      files.set(`agents/${rel}`, { data: Buffer.from(text), mode: f.mode });
    }
  }
  const style = join(dir("output-styles"), "odd.md");
  if (existsSync(style)) {
    const t = readTree(dir("output-styles")).get("odd.md");
    if (t) files.set("output-styles/odd.md", { data: resolve(t.data), mode: t.mode });
  }
  return { files, agentFiles };
}

export function planInstallFiles(paths: InstallPaths, selection: ModelSelection, opts: { payloadDir?: string; oddVersion?: string } = {}): FilePlan {
  const manifest = readManifest(paths.manifestPath);
  const owned = manifest?.files ?? {};
  const { files, agentFiles } = desiredFiles(paths, selection, opts.payloadDir ?? paths.currentLink);
  const coverage = roleCoverage(agentFiles);
  const warnings = [
    ...coverage.rolesWithoutAgentFile.filter((r) => !r.startsWith("review-")).map((r) => `no agent file for role ${r}`),
    ...coverage.unroutedAgentFiles.map((f) => `agent file ${f} has no model role`),
  ];
  const actions: FileAction[] = [];
  for (const [rel, f] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const target = join(paths.claudeDir, ...rel.split("/"));
    const want = sha256(f.data);
    const cur = fileHash(target);
    const base = { rel, target, content: f.data, mode: f.mode };
    if (cur === null && existsSync(target)) actions.push({ ...base, action: "conflict", reason: "target exists and is not a regular file" });
    else if (cur === null) actions.push({ ...base, action: "create" });
    else if (cur === want) actions.push({ ...base, action: "unchanged" });
    else if (owned[rel] === undefined) actions.push({ ...base, action: "conflict", reason: "file exists and was not installed by odd-claude" });
    else if (cur === owned[rel]) actions.push({ ...base, action: "update" });
    else actions.push({ ...base, action: "conflict", reason: "file was edited since odd-claude installed it" });
  }
  for (const [rel, hash] of Object.entries(owned).sort(([a], [b]) => a.localeCompare(b))) {
    if (files.has(rel) || !safeRel(rel)) continue;
    const target = join(paths.claudeDir, ...rel.split("/"));
    const cur = fileHash(target);
    if (cur === null) continue;
    actions.push(cur === hash ? { action: "remove", rel, target } : { action: "conflict", rel, target, reason: "no longer shipped but edited since install; kept" });
  }
  return { actions, warnings, selection, oddVersion: opts.oddVersion ?? activeVersion(paths) ?? "unknown", coverage };
}

/** Backs up what it overwrites or removes, writes create/update, skips conflicts, then rewrites the ledger. */
export function applyInstallFiles(paths: InstallPaths, plan: FilePlan): InstallResult {
  const prev = readManifest(paths.manifestPath);
  const touched = plan.actions.filter((a) => a.action === "update" || a.action === "remove");
  const backupDir = backupFiles(paths, touched.map((a) => a.target));
  const files: Record<string, string> = {};
  const result: InstallResult = { backupDir, written: [], conflicts: [], removed: [] };
  for (const a of plan.actions) {
    if (a.action === "create" || a.action === "update") {
      atomicWriteFile(a.target, a.content!, a.mode || 0o644);
      result.written.push(a.rel);
      files[a.rel] = sha256(a.content!);
    } else if (a.action === "unchanged") {
      files[a.rel] = sha256(a.content!);
    } else if (a.action === "remove") {
      rmSync(a.target, { force: true });
      pruneEmptyDirs(paths.claudeDir, a.target);
      result.removed.push(a.rel);
    } else {
      result.conflicts.push(a.rel);
      const old = prev?.files[a.rel];
      if (old !== undefined) files[a.rel] = old;
    }
  }
  const manifest: Manifest = { version: 1, oddVersion: plan.oddVersion, installedAt: new Date().toISOString(), files, models: plan.selection };
  writeManifest(paths.manifestPath, manifest);
  return result;
}

export interface UninstallAction {
  action: "remove" | "keep" | "missing";
  rel: string;
  target: string;
  reason?: string;
}
export interface UninstallFilesPlan {
  actions: UninstallAction[];
}
export interface UninstallResult {
  removed: string[];
  kept: string[];
}

export function planUninstallFiles(paths: InstallPaths): UninstallFilesPlan {
  const manifest = readManifest(paths.manifestPath);
  const actions: UninstallAction[] = [];
  for (const [rel, hash] of Object.entries(manifest?.files ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!safeRel(rel)) continue;
    const target = join(paths.claudeDir, ...posix.normalize(rel).split("/"));
    const cur = fileHash(target);
    if (cur === null) actions.push({ action: "missing", rel, target });
    else if (cur === hash) actions.push({ action: "remove", rel, target });
    else actions.push({ action: "keep", rel, target, reason: "file was edited since odd-claude installed it" });
  }
  return { actions };
}

/** Removes hash-matching manifest files and the dirs they leave empty, `current` and `versions/`; `data/` and `backups/` only with `purge`. */
export function applyUninstallFiles(paths: InstallPaths, opts: { purge?: boolean } = {}): UninstallResult {
  const manifest = readManifest(paths.manifestPath);
  const plan = planUninstallFiles(paths);
  const result: UninstallResult = { removed: [], kept: [] };
  const left: Record<string, string> = {};
  for (const a of plan.actions) {
    if (a.action === "remove") {
      rmSync(a.target, { force: true });
      pruneEmptyDirs(paths.claudeDir, a.target);
      result.removed.push(a.rel);
    } else if (a.action === "keep") {
      result.kept.push(a.rel);
      left[a.rel] = manifest!.files[a.rel]!;
    }
  }
  rmSync(paths.currentLink, { force: true });
  rmSync(paths.versionsDir, { recursive: true, force: true });
  if (result.kept.length > 0 && manifest) writeManifest(paths.manifestPath, { ...manifest, files: left });
  else rmSync(paths.manifestPath, { force: true });
  if (opts.purge) {
    rmSync(paths.dataDir, { recursive: true, force: true });
    rmSync(paths.backupsDir, { recursive: true, force: true });
    try {
      rmdirSync(paths.oddHome);
    } catch {
      // not empty (kept files still tracked, or user content): leave it
    }
  }
  return result;
}
