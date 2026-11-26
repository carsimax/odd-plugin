// Update from GitHub Releases through an injected runner (gh, tar): check, download + verify, extract, install, roll back.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, sha256 } from "./manifest.js";
import { readOddState, writeOddState } from "./managed-settings.js";
import type { McpRunner, RunResult } from "./mcp.js";
import type { ModelSelection } from "./models.js";
import { activeVersion, assertVersion, listVersions, switchCurrent } from "./payload.js";
import type { InstallPaths } from "./paths.js";
import { runInstall, type RunInstallResult } from "./plan.js";
import { BUNDLE_ASSET, CHECKSUMS_ASSET, payloadAsset, releaseRepo, releaseTag } from "./release.js";

type Env = Record<string, string | undefined>;

export const UPDATE_TTL_MS = 6 * 3600_000;

async function run(runner: McpRunner, cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<RunResult> {
  try {
    return await runner(cmd, args, { env });
  } catch (err) {
    return { code: null, stdout: "", stderr: (err as Error).message };
  }
}
const text = (r: RunResult): string => (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split("\n")[0]!;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Semver compare without dependencies: numeric core, a prerelease ranks below its release. Returns -1, 0 or 1. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const split = (v: string): { core: number[]; pre: string[] } => {
    const [main = "", ...rest] = v.replace(/^v/, "").split("+")[0]!.split("-");
    return { core: main.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: rest.length ? rest.join("-").split(".") : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;
  if (y.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === q) continue;
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) > Number(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

export type CheckResult = { ok: true; version: string; assets: string[] } | { ok: false; error: string };

interface UpdateCache {
  checkedAt: number;
  repo: string;
  version: string;
  assets: string[];
}

const GH_HINT = "Install the GitHub CLI (https://cli.github.com) and run `gh auth login` (the repository is private).";

/** Latest release via `gh release view`. A successful result is cached in settings-state.json (`update` key) for 6h. */
export async function checkLatest(runner: McpRunner, env: Env, opts: { statePath?: string; force?: boolean; now?: () => number } = {}): Promise<CheckResult> {
  const repo = releaseRepo(env);
  const now = (opts.now ?? Date.now)();
  if (opts.statePath && !opts.force) {
    const c = readOddState(opts.statePath).update as UpdateCache | undefined;
    if (c && c.repo === repo && typeof c.checkedAt === "number" && now - c.checkedAt >= 0 && now - c.checkedAt < UPDATE_TTL_MS && typeof c.version === "string" && Array.isArray(c.assets)) {
      return { ok: true, version: c.version, assets: c.assets };
    }
  }
  const r = await run(runner, "gh", ["release", "view", "--repo", repo, "--json", "tagName,assets"], env as NodeJS.ProcessEnv);
  if (r.code !== 0) return { ok: false, error: `could not check releases of ${repo}: ${text(r)}. ${GH_HINT}` };
  let version: string;
  let assets: string[];
  try {
    const j = JSON.parse(r.stdout) as { tagName?: unknown; assets?: { name?: unknown }[] };
    version = String(j.tagName ?? "").replace(/^v/, "");
    assertVersion(version);
    assets = (j.assets ?? []).map((a) => String(a.name));
  } catch (err) {
    return { ok: false, error: `unexpected \`gh release view\` output: ${errMsg(err)}` };
  }
  if (opts.statePath) writeOddState(opts.statePath, { ...readOddState(opts.statePath), update: { checkedAt: now, repo, version, assets } satisfies UpdateCache });
  return { ok: true, version, assets };
}

/** `<sha256>  <filename>` lines (sha256sum format; a leading `*` marks binary mode). */
function parseChecksums(raw: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const g = /^([0-9a-fA-F]{64}) [ *]?(.+?)\s*$/.exec(line);
    if (g) m.set(g[2]!, g[1]!.toLowerCase());
  }
  return m;
}

export type DownloadResult = { ok: true; tarball: string; bundle: string; checksums: string } | { ok: false; error: string };

/** Downloads the three assets and verifies the tarball and bundle against checksums.txt. A mismatch or a missing entry is fatal. */
export async function downloadRelease(runner: McpRunner, opts: { repo: string; version: string; destDir: string; env?: NodeJS.ProcessEnv }): Promise<DownloadResult> {
  const { repo, version, destDir } = opts;
  try {
    assertVersion(version);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  const tarName = payloadAsset(version);
  const r = await run(runner, "gh", ["release", "download", releaseTag(version), "--repo", repo, "-p", tarName, "-p", BUNDLE_ASSET, "-p", CHECKSUMS_ASSET, "-D", destDir], opts.env);
  if (r.code !== 0) return { ok: false, error: `download of ${releaseTag(version)} failed: ${text(r)}` };
  const checksumsPath = join(destDir, CHECKSUMS_ASSET);
  let sums: Map<string, string>;
  try {
    sums = parseChecksums(readFileSync(checksumsPath, "utf8"));
  } catch (err) {
    return { ok: false, error: `cannot read ${CHECKSUMS_ASSET}: ${errMsg(err)}` };
  }
  for (const name of [tarName, BUNDLE_ASSET]) {
    const expected = sums.get(name);
    if (!expected) return { ok: false, error: `no checksum entry for ${name} in ${CHECKSUMS_ASSET}` };
    let actual: string;
    try {
      actual = sha256(readFileSync(join(destDir, name)));
    } catch (err) {
      return { ok: false, error: `cannot read ${name}: ${errMsg(err)}` };
    }
    if (actual !== expected) return { ok: false, error: `checksum mismatch for ${name}` };
  }
  return { ok: true, tarball: join(destDir, tarName), bundle: join(destDir, BUNDLE_ASSET), checksums: checksumsPath };
}

export type ExtractResult = { ok: true; root: string } | { ok: false; error: string };

/** Lists the archive first and refuses absolute paths, `..` entries and more than one top-level dir; then extracts with system tar. */
export async function extractPayload(runner: McpRunner, tarball: string, destDir: string, env?: NodeJS.ProcessEnv): Promise<ExtractResult> {
  const l = await run(runner, "tar", ["-tzf", tarball], env);
  if (l.code !== 0) return { ok: false, error: `cannot list ${tarball}: ${text(l)}` };
  const entries = l.stdout.split("\n").map((e) => e.replace(/\r$/, "")).filter((e) => e !== "");
  if (entries.length === 0) return { ok: false, error: "payload archive is empty" };
  const tops = new Set<string>();
  for (const e of entries) {
    const segs = e.split("/");
    if (e.startsWith("/") || /^[A-Za-z]:/.test(e) || segs.includes("..")) return { ok: false, error: `unsafe path in payload archive: ${JSON.stringify(e)}` };
    const first = segs.find((s) => s !== "" && s !== ".");
    if (first) tops.add(first);
  }
  if (tops.size !== 1) return { ok: false, error: "payload archive must have exactly one top-level directory" };
  // Verbose listing (BSD and GNU formats differ): a link shows as type `l`/`h` in the mode column, ` -> ` or ` link to `.
  const v = await run(runner, "tar", ["-tvzf", tarball], env);
  if (v.code !== 0) return { ok: false, error: `cannot list ${tarball}: ${text(v)}` };
  for (const line of v.stdout.split("\n").map((e) => e.replace(/\r$/, ""))) {
    if (/^[lh]/.test(line) || line.includes(" -> ") || line.includes(" link to ")) return { ok: false, error: `payload archive contains a link: ${JSON.stringify(line.trim())}` };
  }
  try {
    mkdirSync(destDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  const x = await run(runner, "tar", ["-xzf", tarball, "-C", destDir], env);
  if (x.code !== 0) return { ok: false, error: `extraction failed: ${text(x)}` };
  const link = findSymlink(destDir);
  if (link) return { ok: false, error: `extracted payload contains a symlink: ${link}` };
  return { ok: true, root: join(destDir, [...tops][0]!) };
}

/** First symlink under `dir` (lstat walk), or null. */
function findSymlink(dir: string): string | null {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return p;
    if (st.isDirectory()) {
      const inner = findSymlink(p);
      if (inner) return inner;
    }
  }
  return null;
}

const statePathOf = (paths: InstallPaths): string => join(paths.oddHome, "settings-state.json");
const binPathOf = (paths: InstallPaths): string => join(paths.oddHome, "bin", BUNDLE_ASSET);

export interface UpdateOptions {
  runner: McpRunner;
  env: Env;
  paths: InstallPaths;
  selection: ModelSelection;
  force?: boolean;
  dryRun?: boolean;
  now?: () => number;
}
export interface UpdateResult {
  status: "updated" | "up-to-date" | "dry-run" | "check-failed" | "failed";
  from: string | null;
  to?: string;
  error?: string;
  /** Planned or executed steps, for the TUI and --dry-run. */
  steps?: string[];
  rolledBack?: boolean;
  warnings?: string[];
  install?: RunInstallResult;
}

function readOptional(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** Check, download to a temp dir under oddHome, verify, extract, install. A failure after staging restores the previous version. */
export async function runUpdate(opts: UpdateOptions): Promise<UpdateResult> {
  const { runner, env, paths, selection } = opts;
  const from = activeVersion(paths);
  const latest = await checkLatest(runner, env, { statePath: statePathOf(paths), force: opts.force, now: opts.now });
  if (!latest.ok) return { status: "check-failed", from, error: latest.error };
  const to = latest.version;
  if (!opts.force && from !== null && compareVersions(to, from) <= 0) return { status: "up-to-date", from, to };
  const repo = releaseRepo(env);
  const steps = [
    `gh release download ${releaseTag(to)} --repo ${repo}`,
    `verify sha256 of ${payloadAsset(to)} and ${BUNDLE_ASSET} against ${CHECKSUMS_ASSET}`,
    `extract ${payloadAsset(to)}`,
    `stage versions/${to} and point current at it`,
    "install files into the Claude config dir",
    `save ${binPathOf(paths)}`,
  ];
  if (opts.dryRun) return { status: "dry-run", from, to, steps };

  mkdirSync(paths.oddHome, { recursive: true });
  const work = mkdtempSync(join(paths.oddHome, ".update-"));
  const oldBundle = readOptional(binPathOf(paths));
  try {
    const dl = await downloadRelease(runner, { repo, version: to, destDir: join(work, "dl"), env: env as NodeJS.ProcessEnv });
    if (!dl.ok) return { status: "failed", from, to, error: dl.error, steps };
    const ex = await extractPayload(runner, dl.tarball, join(work, "src"), env as NodeJS.ProcessEnv);
    if (!ex.ok) return { status: "failed", from, to, error: ex.error, steps };
    try {
      const install = runInstall({ paths, sourceRoot: ex.root, version: to, selection });
      mkdirSync(join(paths.oddHome, "bin"), { recursive: true });
      atomicWriteFile(binPathOf(paths), readFileSync(dl.bundle), 0o755);
      return { status: "updated", from, to, steps, install, warnings: install.warnings };
    } catch (err) {
      const rolledBack = restorePrevious(opts, from, oldBundle);
      return { status: "failed", from, to, error: errMsg(err), steps, rolledBack: rolledBack.ok, warnings: rolledBack.ok ? undefined : [`rollback failed: ${rolledBack.error}`] };
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function restorePrevious(opts: UpdateOptions, previous: string | null, oldBundle: Buffer | null): { ok: true } | { ok: false; error: string } {
  if (previous === null) return { ok: false, error: "there was no previous version" };
  try {
    switchCurrent(opts.paths, previous);
    runInstall({ paths: opts.paths, sourceRoot: join(opts.paths.versionsDir, previous), version: previous, selection: opts.selection });
    if (oldBundle) {
      mkdirSync(join(opts.paths.oddHome, "bin"), { recursive: true });
      atomicWriteFile(binPathOf(opts.paths), oldBundle, 0o755);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

export interface RollbackResult {
  ok: boolean;
  from: string | null;
  to?: string;
  error?: string;
  warnings?: string[];
}

/** Points `current` at the previous (or the given) installed version and re-runs the file install from it. */
export function rollback(opts: { paths: InstallPaths; selection: ModelSelection; to?: string }): RollbackResult {
  const { paths, selection } = opts;
  const from = activeVersion(paths);
  const versions = listVersions(paths);
  let to = opts.to;
  if (to === undefined) {
    const i = from === null ? -1 : versions.indexOf(from);
    if (i <= 0) return { ok: false, from, error: "no previous version is installed" };
    to = versions[i - 1]!;
  } else {
    try {
      assertVersion(to);
    } catch (err) {
      return { ok: false, from, error: errMsg(err) };
    }
    if (!versions.includes(to)) return { ok: false, from, error: `version ${to} is not installed (installed: ${versions.join(", ") || "none"})` };
  }
  if (to === from) return { ok: false, from, to, error: `version ${to} is already current` };
  try {
    const r = runInstall({ paths, sourceRoot: join(paths.versionsDir, to), version: to, selection });
    return { ok: true, from, to, warnings: r.warnings };
  } catch (err) {
    if (from !== null && existsSync(join(paths.versionsDir, from))) {
      try {
        switchCurrent(paths, from);
      } catch {
        /* keep the original error */
      }
    }
    return { ok: false, from, to, error: errMsg(err) };
  }
}
