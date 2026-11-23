// Git snapshot freezing for the review engine (U8).
//
// Turns "what is under review" into immutable git tree ids plus content-addressed identities,
// without ever touching the user's real index or working tree:
//   - git runs ONLY through spawnSync with argument arrays (never a shell), a sanitized
//     environment (every caller GIT_* variable is dropped; only the private temp index is set),
//     a bounded timeout, SIGKILL on expiry and a bounded output buffer;
//   - the candidate tree is built in a private copy of the real index (read-tree/add/write-tree
//     would otherwise rewrite the real index's cache-tree), and that copy is always removed;
//   - untracked files enter a candidate ONLY when listed explicitly (intended untracked) and only
//     when they are regular files inside the worktree (no symlink, no `..`, bounded size).
// Mirrors the reference engine's fields (base/candidate tree, sorted paths, paths digest,
// intended-untracked proof, snapshot identity) under odd-claude hash domains and canonical JSON.
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isPidAlive } from "../lib/pid.js";
import { domainHash } from "./canonical.js";

export type SnapshotProjection = "workspace" | "staged";
export type SnapshotKind = "current-changes" | "base-diff" | "base-workspace-overlay";

/**
 * current-changes: HEAD vs the workspace (tracked changes + explicitly intended untracked) or vs
 * the index (`staged`). base-diff: committed-only, baseRef vs HEAD. base-workspace-overlay:
 * baseRef vs the workspace.
 */
export type SnapshotTarget =
  | { kind: "current-changes"; projection?: SnapshotProjection; intendedUntracked?: readonly string[] }
  | { kind: "base-diff"; baseRef: string }
  | { kind: "base-workspace-overlay"; baseRef: string; intendedUntracked?: readonly string[] };

export interface SnapshotOptions {
  /** Per git command wall-clock bound; defaults to DEFAULT_GIT_TIMEOUT_MS. */
  gitTimeoutMs?: number;
}

/** The per-call bound, as threaded through every git call of an operation. */
export type Bound = { timeoutMs: number };

export function boundOf(options: SnapshotOptions): Bound {
  return { timeoutMs: options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS };
}

export interface RepositoryIdentity {
  root: string;
  gitDir: string;
  commonDir: string;
}

export interface Snapshot {
  kind: SnapshotKind;
  projection: SnapshotProjection;
  unbornHead: boolean;
  baseTree: string;
  candidateTree: string;
  /** Sorted bytewise (UTF-8), unique, canonical logical paths changed between the trees. */
  paths: string[];
  pathsDigest: string;
  intendedUntracked: string[];
  intendedUntrackedProof: string;
  /** Authored changed lines (numstat additions + deletions; binary and mode-only count 0). */
  changedLines: number;
  identity: string;
}

export type FreezeResult =
  | { status: "frozen"; repository: RepositoryIdentity; snapshot: Snapshot }
  | { status: "empty"; repository: RepositoryIdentity; kind: SnapshotKind; projection: SnapshotProjection; baseTree: string; candidateTree: string };

export type SnapshotErrorCode =
  | "invalid_target"
  | "invalid_path"
  | "untracked_refused"
  | "not_a_repository"
  | "bare_repository"
  | "untrusted_repository"
  | "unborn_head"
  | "unknown_revision"
  | "index_changed"
  | "git_unavailable"
  | "git_failed"
  | "git_timeout"
  | "git_output_limit"
  | "corrupt_output"
  | "invalid_encoding"
  | "local_graft_active"
  | "scratch_unavailable";

export type UntrackedRefusalReason = "missing" | "symlink" | "outside" | "not_regular" | "too_large" | "too_many" | "hardlink" | "name_mismatch" | "ignored" | "tracked" | "staged_projection" | "not_regular_in_tree" | "changed";

export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;
  readonly reason?: UntrackedRefusalReason;
  readonly exitCode?: number;
  constructor(code: SnapshotErrorCode, message: string, extra: { reason?: UntrackedRefusalReason; exitCode?: number } = {}) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
    if (extra.reason !== undefined) this.reason = extra.reason;
    if (extra.exitCode !== undefined) this.exitCode = extra.exitCode;
  }
}

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;
export const MAX_GIT_TIMEOUT_MS = 5 * 60_000;
export const MAX_INTENDED_UNTRACKED_FILES = 1000;
export const MAX_INTENDED_UNTRACKED_FILE_BYTES = 1024 * 1024;
export const MAX_INTENDED_UNTRACKED_TOTAL_BYTES = 16 * 1024 * 1024;
export const OUTPUT_LIMIT = 8 * 1024 * 1024;
export const INVENTORY_LIMIT = 64 * 1024 * 1024;
const STDERR_SNIPPET = 2000;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// ---------------------------------------------------------------------------------------------
// git runner
// ---------------------------------------------------------------------------------------------

/** Caller GIT_* variables never reach git (a stray GIT_INDEX_FILE would redirect our writes). */
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper.startsWith("GIT_") || upper === "LC_ALL") continue;
    env[key] = value;
  }
  env.LC_ALL = "C";
  env.GIT_OPTIONAL_LOCKS = "0"; // read-only commands must not refresh the real index
  env.GIT_TERMINAL_PROMPT = "0";
  return { ...env, ...extra };
}

export interface GitCall {
  cwd: string;
  args: string[];
  timeoutMs: number;
  env?: Record<string, string>;
  input?: string | Buffer;
  okExit?: number[];
  limit?: number;
}

export interface GitOut {
  stdout: Buffer;
  exitCode: number;
}

export function runGit(call: GitCall): GitOut {
  const timeout = Math.min(Math.max(call.timeoutMs, 1), MAX_GIT_TIMEOUT_MS);
  const result = spawnSync("git", ["--no-replace-objects", "-C", call.cwd, ...call.args], {
    env: gitEnv(call.env),
    input: call.input,
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: call.limit ?? OUTPUT_LIMIT,
    windowsHide: true,
    shell: false,
  });
  const label = `git ${call.args[0] ?? ""}`;
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new SnapshotError("git_unavailable", "git executable not found");
    if (code === "ETIMEDOUT") throw new SnapshotError("git_timeout", `${label} timed out after ${Math.ceil(timeout)}ms`);
    if (code === "ENOBUFS") throw new SnapshotError("git_output_limit", `${label} output exceeded the deterministic byte limit`);
    throw new SnapshotError("git_failed", `${label} could not run: ${result.error.message}`);
  }
  if (result.status === null) throw new SnapshotError("git_timeout", `${label} was killed (${result.signal ?? "no status"})`);
  const ok = call.okExit ?? [0];
  if (!ok.includes(result.status)) {
    const stderr = (result.stderr ?? Buffer.alloc(0)).toString("utf8").trim().slice(0, STDERR_SNIPPET);
    throw new SnapshotError("git_failed", `${label} failed with exit code ${result.status}${stderr ? `: ${stderr}` : ""}`, { exitCode: result.status });
  }
  return { stdout: result.stdout ?? Buffer.alloc(0), exitCode: result.status };
}

function oneLine(out: Buffer, what: string): string {
  let text = out.toString("utf8");
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text === "" || text.includes("\n") || text.includes("\0")) throw new SnapshotError("corrupt_output", `${what} is not exactly one record`);
  return text;
}

function oid(out: Buffer, what: string): string {
  const value = oneLine(out, what);
  if (!OID_RE.test(value)) throw new SnapshotError("corrupt_output", `${what} is not an object id`);
  return value;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Fail closed on any name that is not valid UTF-8: a lossy decode would hash a different path. */
export function decodeName(bytes: Uint8Array, what: string): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new SnapshotError("invalid_encoding", `${what} is not valid UTF-8`);
  }
}

export function nulRecords(out: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === 0) {
      if (i > start) records.push(out.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < out.length) throw new SnapshotError("corrupt_output", "unterminated NUL record");
  return records;
}

// ---------------------------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------------------------

/** Canonical repository-relative logical path: '/'-separated, no `.`/`..`/empty segment, no `\`, no NUL. */
export function normalizeLogicalPath(value: string): string {
  if (typeof value !== "string" || value === "" || value.includes("\0") || value.includes("\\") || value.startsWith("/")) {
    throw new SnapshotError("invalid_path", `invalid logical path ${JSON.stringify(value)}`);
  }
  for (const segment of value.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new SnapshotError("invalid_path", `logical path is not canonical: ${JSON.stringify(value)}`);
    }
  }
  return value;
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function canonicalPaths(values: readonly string[]): string[] {
  const normalized = values.map(normalizeLogicalPath).sort(compareBytes);
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i] === normalized[i - 1]) throw new SnapshotError("invalid_path", `duplicate intended-untracked path ${JSON.stringify(normalized[i])}`);
  }
  return normalized;
}

function refuse(reason: UntrackedRefusalReason, path: string, detail: string): SnapshotError {
  return new SnapshotError("untracked_refused", `intended-untracked path ${JSON.stringify(path)} ${detail}`, { reason });
}

/** Every intended path must be a regular, in-worktree, bounded file reached without a symlink. */
function checkIntendedFiles(root: string, paths: string[], precompose = false): void {
  if (paths.length > MAX_INTENDED_UNTRACKED_FILES) {
    throw refuse("too_many", `(${paths.length} paths)`, `list exceeds ${MAX_INTENDED_UNTRACKED_FILES} files`);
  }
  let total = 0;
  const names = new Map<string, Set<string>>();
  const exact = (dir: string, name: string, logical: string): void => {
    let set = names.get(dir);
    if (!set) {
      // core.precomposeunicode: git itself reports (and freezes) NFC names, so an NFD name on disk matches its NFC spelling.
      set = new Set(readdirSync(dir).map((n) => (precompose ? n.normalize("NFC") : n)));
      names.set(dir, set);
    }
    // Case-insensitive volumes resolve a wrong-case spelling; only the on-disk spelling may be frozen.
    if (!set.has(name)) throw refuse("name_mismatch", logical, "does not match the on-disk spelling of its path");
  };
  for (const path of paths) {
    if (path !== path.normalize("NFC")) throw new SnapshotError("invalid_path", `intended-untracked path ${JSON.stringify(path)} must use Unicode NFC spelling`);
    const segments = path.split("/");
    if (segments.some((s) => s.toLowerCase() === ".git")) throw new SnapshotError("invalid_path", `intended-untracked path ${JSON.stringify(path)} is inside .git`);
    let current = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const parent = current;
      current = join(current, segments[i]!);
      const info = statNoFollow(current, path);
      if (info.isSymbolicLink()) throw refuse("symlink", path, "traverses a symbolic link");
      if (!info.isDirectory()) throw refuse("not_regular", path, "has a non-directory parent");
      exact(parent, segments[i]!, path);
    }
    const full = join(current, segments[segments.length - 1]!);
    const info = statNoFollow(full, path);
    if (info.isSymbolicLink()) throw refuse("symlink", path, "is a symbolic link");
    if (!info.isFile()) throw refuse("not_regular", path, "is not a regular file");
    if (info.nlink > 1) throw refuse("hardlink", path, "has more than one hard link");
    exact(current, segments[segments.length - 1]!, path);
    if (info.size > MAX_INTENDED_UNTRACKED_FILE_BYTES) throw refuse("too_large", path, `exceeds ${MAX_INTENDED_UNTRACKED_FILE_BYTES} bytes`);
    total += info.size;
    if (total > MAX_INTENDED_UNTRACKED_TOTAL_BYTES) throw refuse("too_large", path, `pushes the list past ${MAX_INTENDED_UNTRACKED_TOTAL_BYTES} bytes`);
    let real: string;
    try {
      real = realpathSync(full);
    } catch {
      throw refuse("missing", path, "does not exist");
    }
    if (!real.startsWith(root + sep)) throw refuse("outside", path, "resolves outside the worktree");
  }
}

function statNoFollow(path: string, logical: string): Stats {
  try {
    return lstatSync(path) as Stats;
  } catch {
    throw refuse("missing", logical, "does not exist");
  }
}

// ---------------------------------------------------------------------------------------------
// repository identity
// ---------------------------------------------------------------------------------------------

export function resolveRepository(cwd: string, options: SnapshotOptions = {}): RepositoryIdentity {
  const bound = boundOf(options);
  if (typeof cwd !== "string" || cwd === "" || cwd.includes("\0")) throw new SnapshotError("invalid_target", "repository path is required");
  let start: string;
  try {
    start = realpathSync(resolve(cwd));
  } catch {
    throw new SnapshotError("not_a_repository", `${cwd} does not exist`);
  }
  let toplevel: string;
  try {
    toplevel = oneLine(runGit({ cwd: start, args: ["rev-parse", "--show-toplevel"], ...bound }).stdout, "repository root");
  } catch (error) {
    if (error instanceof SnapshotError && error.code === "git_failed") {
      // upstream parity (its review-incident classifier): git refuses a repository owned by someone else with exit 128 and
      // a `fatal: detected dubious ownership` (or `unsafe repository`) line AND the safe.directory hint (runGit forces LC_ALL=C, so the text is stable). That is
      // not "no repository": the repository exists but git will not work in it.
      if (error.exitCode === 128 && /fatal: (?:detected dubious ownership|unsafe repository)/i.test(error.message) && /safe\.directory/i.test(error.message)) {
        throw new SnapshotError("untrusted_repository", `${start} is a repository git does not trust (dubious ownership); add it to safe.directory to use it`, { exitCode: 128 });
      }
      let bare = false;
      try {
        bare = oneLine(runGit({ cwd: start, args: ["rev-parse", "--is-bare-repository"], ...bound }).stdout, "bare probe") === "true";
      } catch {
        bare = false;
      }
      if (bare) throw new SnapshotError("bare_repository", `${start} is a bare repository; a review candidate needs a working tree`);
      throw new SnapshotError("not_a_repository", `${start} is not inside a git repository`);
    }
    throw error;
  }
  const root = realpathSync(toplevel);
  const gitDir = realpathSync(oneLine(runGit({ cwd: root, args: ["rev-parse", "--absolute-git-dir"], ...bound }).stdout, "git dir"));
  const common = oneLine(runGit({ cwd: root, args: ["rev-parse", "--git-common-dir"], ...bound }).stdout, "git common dir");
  const commonDir = realpathSync(isAbsolute(common) ? common : resolve(root, common));
  return { root, gitDir, commonDir };
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

function validateRef(ref: unknown, what: string): string {
  if (typeof ref !== "string") throw new SnapshotError("invalid_target", `${what} must be a string`);
  const value = ref.trim();
  // eslint-disable-next-line no-control-regex
  if (value === "" || value.startsWith("-") || value.includes("..") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SnapshotError("invalid_target", `${what} must be exactly one revision (not a range or option)`);
  }
  return value;
}

function resolveTree(repo: RepositoryIdentity, rev: string, bound: Bound): string {
  try {
    return oid(runGit({ cwd: repo.root, args: ["rev-parse", "--verify", `${rev}^{tree}`], ...bound }).stdout, "tree id");
  } catch (error) {
    if (error instanceof SnapshotError && error.code === "git_failed") throw new SnapshotError("unknown_revision", `cannot resolve ${JSON.stringify(rev)} to a tree`, { exitCode: error.exitCode });
    throw error;
  }
}

function emptyTree(repo: RepositoryIdentity, bound: Bound): string {
  return oid(runGit({ cwd: repo.root, args: ["mktree"], ...bound, input: "" }).stdout, "empty tree id");
}

/** HEAD's tree, or the empty tree plus `unborn` when HEAD names a branch that has no commit yet. */
function resolveHeadBase(repo: RepositoryIdentity, bound: Bound): { tree: string; unborn: boolean } {
  try {
    return { tree: oid(runGit({ cwd: repo.root, args: ["rev-parse", "--verify", "HEAD^{tree}"], ...bound }).stdout, "tree id"), unborn: false };
  } catch (error) {
    if (!(error instanceof SnapshotError) || error.code !== "git_failed") throw error;
    let ref: string;
    try {
      ref = oneLine(runGit({ cwd: repo.root, args: ["symbolic-ref", "--quiet", "HEAD"], ...bound }).stdout, "HEAD ref");
    } catch {
      throw new SnapshotError("unknown_revision", "cannot resolve HEAD to a tree");
    }
    if (!ref.startsWith("refs/heads/") || ref === "refs/heads/") throw new SnapshotError("unknown_revision", "cannot resolve HEAD to a tree");
    const exists = runGit({ cwd: repo.root, args: ["show-ref", "--verify", "--quiet", "--", ref], ...bound, okExit: [0, 1] });
    if (exists.exitCode === 0) throw new SnapshotError("unknown_revision", "cannot resolve HEAD to a tree");
    return { tree: emptyTree(repo, bound), unborn: true };
  }
}

function changedPaths(repo: RepositoryIdentity, baseTree: string, candidateTree: string, bound: Bound): string[] {
  const out = runGit({
    cwd: repo.root,
    args: ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", "--ignore-submodules=none", baseTree, candidateTree],
    ...bound,
    limit: INVENTORY_LIMIT,
  }).stdout;
  return nulRecords(out)
    .map((record) => normalizeLogicalPath(decodeName(record, "changed path")))
    .sort(compareBytes);
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  size: number | null;
}

function listTreeEntries(repo: RepositoryIdentity, tree: string, bound: Bound): Map<string, TreeEntry> {
  const out = runGit({ cwd: repo.root, args: ["ls-tree", "-r", "-t", "-l", "-z", tree], ...bound, limit: INVENTORY_LIMIT }).stdout;
  const entries = new Map<string, TreeEntry>();
  for (const record of nulRecords(out)) {
    const tab = record.indexOf(9);
    const header = tab < 0 ? "" : record.subarray(0, tab).toString("utf8");
    const match = /^(\d{6}) (\w+) ([0-9a-f]+) +(\d+|-)$/.exec(header);
    if (!match) throw new SnapshotError("corrupt_output", "unexpected tree entry");
    entries.set(decodeName(record.subarray(tab + 1), "tree path"), { mode: match[1]!, type: match[2]!, oid: match[3]!, size: match[4] === "-" ? null : Number(match[4]) });
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// hashes
// ---------------------------------------------------------------------------------------------

export function digestPaths(paths: readonly string[]): string {
  return domainHash("paths", 1, [...paths]);
}

/**
 * Post-build verification (closes the check-then-`git add` window): every intended path must STILL be a regular,
 * single-link file whose current content hashes (with the same clean filters `git add` applies) to the blob the
 * candidate tree holds. A swap to a hardlink, symlink or different content after the pre-add check is refused.
 */
export function verifyIntendedFiles(repo: RepositoryIdentity, candidateTree: string, intended: readonly string[], options: SnapshotOptions = {}): void {
  if (intended.length === 0) return;
  const bound = boundOf(options);
  const entries = listTreeEntries(repo, candidateTree, bound);
  for (const path of intended) {
    const entry = entries.get(path);
    if (!entry) throw refuse("missing", path, "is absent from the candidate tree");
    const full = join(repo.root, ...path.split("/"));
    let info: Stats;
    try {
      info = lstatSync(full) as Stats;
    } catch {
      throw refuse("changed", path, "disappeared after the candidate tree was built");
    }
    if (info.isSymbolicLink()) throw refuse("symlink", path, "became a symbolic link after the pre-add check");
    if (!info.isFile()) throw refuse("not_regular", path, "is no longer a regular file");
    if (info.nlink > 1) throw refuse("hardlink", path, "has more than one hard link after the pre-add check");
    const actual = oid(runGit({ cwd: repo.root, args: ["hash-object", "--", full], ...bound }).stdout, "file object id");
    if (actual !== entry.oid) throw refuse("changed", path, "changed after the candidate tree was built");
  }
}

/** Proof that each intended path is a regular blob of the candidate tree (path, mode, object id). */
export function intendedUntrackedProof(repo: RepositoryIdentity, candidateTree: string, intended: string[], options: SnapshotOptions = {}): string {
  return untrackedProof(repo, candidateTree, intended, boundOf(options));
}

function untrackedProof(repo: RepositoryIdentity, candidateTree: string, intended: string[], bound: Bound): string {
  if (intended.length === 0) return domainHash("intended-untracked", 1, []);
  const entries = listTreeEntries(repo, candidateTree, bound);
  const proof: Array<{ mode: string; oid: string; path: string }> = [];
  let total = 0;
  for (const path of intended) {
    const entry = entries.get(path);
    if (!entry) throw refuse("missing", path, "is absent from the candidate tree");
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw refuse("not_regular_in_tree", path, "is not a regular file in the candidate tree");
    }
    // The size limit is re-checked on the frozen blob: the file could have been swapped after the pre-add check.
    const size = entry.size ?? 0;
    total += size;
    if (size > MAX_INTENDED_UNTRACKED_FILE_BYTES) throw refuse("too_large", path, `is ${size} bytes in the candidate tree (limit ${MAX_INTENDED_UNTRACKED_FILE_BYTES})`);
    if (total > MAX_INTENDED_UNTRACKED_TOTAL_BYTES) throw refuse("too_large", path, `pushes the list past ${MAX_INTENDED_UNTRACKED_TOTAL_BYTES} bytes in the candidate tree`);
    proof.push({ mode: entry.mode, oid: entry.oid, path });
  }
  return domainHash("intended-untracked", 1, proof);
}

/**
 * Content-addressed identity. kind and projection stay in the domain on purpose (a current-changes
 * receipt must never match an overlay review of identical bytes); the intended-untracked list and
 * its proof describe HOW bytes were declared, not WHAT they are, so they stay out of the identity.
 */
export function snapshotIdentity(kind: SnapshotKind, projection: SnapshotProjection, baseTree: string, candidateTree: string, pathsDigest: string): string {
  const payload = { kind, baseTree, candidateTree, pathsDigest };
  if (kind === "base-workspace-overlay") return domainHash("review-snapshot-base-workspace-overlay", 2, payload);
  if (projection === "staged") return domainHash("review-snapshot", 4, { ...payload, projection });
  return domainHash("review-snapshot", 3, payload);
}

// ---------------------------------------------------------------------------------------------
// changed lines
// ---------------------------------------------------------------------------------------------

export function isGeneratedGoldenPath(path: string): boolean {
  return `/${path}`.includes("/testdata/golden/") && path.endsWith(".golden");
}

/**
 * Authored changed lines between two trees: numstat additions + deletions. Binary entries ("-")
 * and generated golden files count 0, as does a mode-only change (numstat reports 0/0).
 * Rename-aware credit is not applied: it is advisory in the reference and the no-rename total is
 * the conservative upper bound.
 */
export function countChangedLines(repo: RepositoryIdentity, baseTree: string, candidateTree: string, options: SnapshotOptions = {}): number {
  if (!OID_RE.test(baseTree) || !OID_RE.test(candidateTree)) throw new SnapshotError("invalid_target", "tree ids must be full hexadecimal object ids");
  const bound = boundOf(options);
  const out = withIsolatedGit(repo, baseTree, ({ cwd, env }) =>
    runGit({
      cwd,
      env,
      args: ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", baseTree, candidateTree, "--"],
      ...bound,
      limit: INVENTORY_LIMIT,
    }).stdout,
  );
  const seen = new Set<string>();
  let total = 0;
  for (const record of nulRecords(out)) {
    const text = decodeName(record, "diff stat record");
    const first = text.indexOf("\t");
    const second = first < 0 ? -1 : text.indexOf("\t", first + 1);
    if (first < 0 || second < 0) throw new SnapshotError("corrupt_output", "unexpected diff stat record");
    const additions = text.slice(0, first);
    const deletions = text.slice(first + 1, second);
    const path = normalizeLogicalPath(text.slice(second + 1));
    if (seen.has(path)) throw new SnapshotError("corrupt_output", `duplicate diff stat path ${JSON.stringify(path)}`);
    seen.add(path);
    if (additions === "-" && deletions === "-") continue;
    if (!/^\d+$/.test(additions) || !/^\d+$/.test(deletions)) throw new SnapshotError("corrupt_output", "unexpected diff stat counts");
    if (isGeneratedGoldenPath(path)) continue;
    total += Number(additions) + Number(deletions);
  }
  return total;
}

// ---------------------------------------------------------------------------------------------
// candidate from the index / workspace
// ---------------------------------------------------------------------------------------------

function readRealIndex(path: string): { content: Buffer; atimeMs: number; mtimeMs: number } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = fstatSync(fd);
    const content = readFileSync(fd);
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || content.length !== after.size) {
      throw new SnapshotError("index_changed", "the real index changed while being copied");
    }
    return { content, atimeMs: after.atimeMs, mtimeMs: after.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

const SCRATCH_PREFIX = ".odd-review-index-";
const SCRATCH_ALLOWED = new Set(["index", "index.lock", "owner.json", "git"]);
export const STALE_SCRATCH_MS = 10 * 60_000;
const MAX_SWEEP_ENTRIES = 64;

function makeScratch(repo: RepositoryIdentity): string {
  for (const base of [tmpdir(), repo.gitDir]) {
    try {
      const dir = mkdtempSync(join(base, SCRATCH_PREFIX));
      writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      return dir;
    } catch {
      continue;
    }
  }
  throw new SnapshotError("scratch_unavailable", "no writable location for a private review index");
}

const processAlive = isPidAlive;

/**
 * Bounded best-effort sweep of private index copies a killed process left behind. Only plain
 * directories we own, named like our scratch, older than STALE_SCRATCH_MS, whose recorded owner
 * pid is dead (or unrecorded) and that hold nothing but our own files are removed. The real
 * index is never a candidate: it is not a directory with that prefix.
 */
function sweepStaleScratch(repo: RepositoryIdentity): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const now = Date.now();
  let examined = 0;
  for (const base of new Set([tmpdir(), repo.gitDir])) {
    let entries: string[];
    try {
      entries = readdirSync(base).filter((n) => n.startsWith(SCRATCH_PREFIX));
    } catch {
      continue;
    }
    for (const name of entries) {
      if (examined++ >= MAX_SWEEP_ENTRIES) return;
      const dir = join(base, name);
      try {
        const info = lstatSync(dir);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        if (uid !== undefined && info.uid !== uid) continue;
        if (now - info.mtimeMs < STALE_SCRATCH_MS) continue;
        if (readdirSync(dir).some((n) => !SCRATCH_ALLOWED.has(n))) continue;
        let pid: unknown;
        try {
          pid = (JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as { pid?: unknown }).pid;
        } catch {
          pid = undefined;
        }
        if (typeof pid === "number" && Number.isInteger(pid) && pid > 0 && processAlive(pid)) continue;
        rmSync(dir, { recursive: true, force: true });
      } catch {
        continue;
      }
    }
  }
}

/** Refuse while a repository-local graft can substitute a commit's true parent (shared across worktrees). */
function rejectActiveGraft(repo: RepositoryIdentity): void {
  const path = join(repo.commonDir, "info", "grafts");
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new SnapshotError("corrupt_output", `cannot read repository-local graft file ${path}`);
  }
  if (content.split("\n").some((line) => {
    const t = line.replace(/\r$/, "").trim();
    return t !== "" && !t.startsWith("#");
  })) {
    throw new SnapshotError("local_graft_active", `repository-local graft file ${path} is active and can change the base tree; remove it before freezing a snapshot`);
  }
}

/**
 * Runs `fn` against a scratch bare git dir that borrows the real object store through alternates
 * and carries no config, attributes, grafts or index, so results depend only on the trees named.
 */
function withIsolatedGit<T>(repo: RepositoryIdentity, treeId: string, fn: (call: { cwd: string; env: Record<string, string> }) => T): T {
  const objects = join(repo.commonDir, "objects");
  if (objects.includes("\n")) throw new SnapshotError("corrupt_output", "object directory path contains a newline");
  const scratch = makeScratch(repo);
  try {
    const gitDir = join(scratch, "git");
    mkdirSync(join(gitDir, "objects", "info"), { recursive: true });
    mkdirSync(join(gitDir, "refs"));
    mkdirSync(join(gitDir, "info"));
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/frozen-context\n");
    writeFileSync(join(gitDir, "info", "attributes"), "");
    const sha256 = treeId.length === 64;
    writeFileSync(
      join(gitDir, "config"),
      `[core]\n\trepositoryformatversion = ${sha256 ? 1 : 0}\n\tbare = true\n\tattributesFile = /dev/null\n${sha256 ? "[extensions]\n\tobjectFormat = sha256\n" : ""}`,
    );
    writeFileSync(join(gitDir, "objects", "info", "alternates"), `${objects}\n`);
    return fn({ cwd: scratch, env: { GIT_DIR: gitDir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1" } });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function buildIndexCandidate(
  repo: RepositoryIdentity,
  projection: SnapshotProjection,
  intended: string[],
  bound: Bound,
): { candidateTree: string; proof: string } {
  const indexPath = resolve(repo.root, oneLine(runGit({ cwd: repo.root, args: ["rev-parse", "--git-path", "index"], ...bound }).stdout, "index path"));
  const real = readRealIndex(indexPath);
  const precompose = projection === "workspace" && intended.length > 0 && runGit({ cwd: repo.root, args: ["config", "--type=bool", "--get", "core.precomposeunicode"], ...bound, okExit: [0, 1] }).stdout.toString("utf8").trim() === "true";
  if (projection === "workspace") checkIntendedFiles(repo.root, intended, precompose);

  const scratch = makeScratch(repo);
  try {
    const tempIndex = join(scratch, "index");
    const env = { GIT_INDEX_FILE: tempIndex };
    if (real === null) {
      runGit({ cwd: repo.root, args: ["read-tree", "--empty"], ...bound, env });
    } else {
      writeFileSync(tempIndex, real.content, { mode: 0o600 });
      // Keep the real index timestamp: git's racily-clean check compares entry times with it.
      utimesSync(tempIndex, real.atimeMs / 1000, real.mtimeMs / 1000);
    }
    if (projection === "workspace") {
      const cached = runGit({ cwd: repo.root, args: ["ls-files", "--cached", "-z"], ...bound, env, limit: INVENTORY_LIMIT }).stdout;
      const tracked = new Set(nulRecords(cached).map((r) => decodeName(r, "index path")));
      for (const path of intended) if (tracked.has(path)) throw refuse("tracked", path, "is already tracked");
      if (intended.length > 0) {
        const ignored = runGit({ cwd: repo.root, args: ["check-ignore", "-z", "--stdin", "--no-index"], ...bound, env, input: intended.join("\0") + "\0", okExit: [0, 1] });
        const ignoredSet = new Set(nulRecords(ignored.stdout).map((r) => decodeName(r, "ignored path")));
        for (const path of intended) if (ignoredSet.has(path)) throw refuse("ignored", path, "is ignored");
      }
      if (tracked.size > 0) {
        const budget = Math.min(MAX_GIT_TIMEOUT_MS, Math.max(bound.timeoutMs, tracked.size * 25));
        runGit({ cwd: repo.root, args: ["add", "-u", "--", "."], ...bound, timeoutMs: budget, env, limit: INVENTORY_LIMIT });
      }
      if (intended.length > 0) {
        const specs = intended.map((p) => `:(literal)${p}`).join("\0");
        runGit({ cwd: repo.root, args: ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], ...bound, env, input: specs });
      }
    }
    const candidateTree = oid(runGit({ cwd: repo.root, args: ["write-tree"], ...bound, env }).stdout, "candidate tree id");
    const proof = untrackedProof(repo, candidateTree, intended, bound);
    if (projection === "workspace") verifyIntendedFiles(repo, candidateTree, intended, { gitTimeoutMs: bound.timeoutMs });
    return { candidateTree, proof };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// public entry point
// ---------------------------------------------------------------------------------------------

function validateTarget(target: SnapshotTarget): { projection: SnapshotProjection; intended: string[]; baseRef?: string } {
  if (typeof target !== "object" || target === null) throw new SnapshotError("invalid_target", "target must be an object");
  const raw = target as unknown as Record<string, unknown>;
  const intendedRaw = raw.intendedUntracked;
  if (intendedRaw !== undefined && (!Array.isArray(intendedRaw) || intendedRaw.some((v) => typeof v !== "string"))) {
    throw new SnapshotError("invalid_target", "intendedUntracked must be a list of strings");
  }
  switch (target.kind) {
    case "base-diff": {
      if (intendedRaw !== undefined && intendedRaw.length > 0) throw new SnapshotError("invalid_target", "a committed-only base-diff does not accept intended-untracked paths");
      return { projection: "workspace", intended: [], baseRef: validateRef(raw.baseRef, "baseRef") };
    }
    case "base-workspace-overlay":
      return { projection: "workspace", intended: canonicalPaths((intendedRaw as string[] | undefined) ?? []), baseRef: validateRef(raw.baseRef, "baseRef") };
    case "current-changes": {
      const projection = raw.projection ?? "workspace";
      if (projection !== "workspace" && projection !== "staged") throw new SnapshotError("invalid_target", `unsupported projection ${JSON.stringify(projection)}`);
      const intended = canonicalPaths((intendedRaw as string[] | undefined) ?? []);
      if (projection === "staged" && intended.length > 0) throw refuse("staged_projection", intended[0]!, "is not accepted by the staged projection");
      return { projection, intended };
    }
    default:
      throw new SnapshotError("invalid_target", `unsupported target kind ${JSON.stringify((raw as { kind?: unknown }).kind)}`);
  }
}

export function freezeSnapshot(cwd: string, target: SnapshotTarget, options: SnapshotOptions = {}): FreezeResult {
  const bound = boundOf(options);
  const { projection, intended, baseRef } = validateTarget(target);
  const repo = resolveRepository(cwd, options);
  const kind = target.kind;
  sweepStaleScratch(repo);
  rejectActiveGraft(repo);

  let baseTree: string;
  let candidateTree: string;
  let proof: string;
  let unbornHead = false;
  if (kind === "base-diff") {
    baseTree = resolveTree(repo, baseRef!, bound);
    const head = resolveHeadBase(repo, bound);
    if (head.unborn) throw new SnapshotError("unborn_head", "a committed-only base-diff needs a commit at HEAD");
    candidateTree = head.tree;
    proof = domainHash("intended-untracked", 1, []);
  } else if (kind === "base-workspace-overlay") {
    baseTree = resolveTree(repo, baseRef!, bound);
    ({ candidateTree, proof } = buildIndexCandidate(repo, "workspace", intended, bound));
  } else {
    const head = resolveHeadBase(repo, bound);
    baseTree = head.tree;
    unbornHead = head.unborn;
    ({ candidateTree, proof } = buildIndexCandidate(repo, projection, intended, bound));
  }

  const paths = changedPaths(repo, baseTree, candidateTree, bound);
  if (paths.length === 0) return { status: "empty", repository: repo, kind, projection, baseTree, candidateTree };
  const changedLines = countChangedLines(repo, baseTree, candidateTree, options);
  const pathsDigest = digestPaths(paths);
  return {
    status: "frozen",
    repository: repo,
    snapshot: {
      kind,
      projection,
      unbornHead,
      baseTree,
      candidateTree,
      paths,
      pathsDigest,
      intendedUntracked: intended,
      intendedUntrackedProof: proof,
      changedLines,
      identity: snapshotIdentity(kind, projection, baseTree, candidateTree, pathsDigest),
    },
  };
}
