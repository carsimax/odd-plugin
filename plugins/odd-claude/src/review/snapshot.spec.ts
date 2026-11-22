import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, utimesSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domainHash } from "./canonical.js";
import {
  countChangedLines,
  digestPaths,
  freezeSnapshot,
  intendedUntrackedProof,
  MAX_INTENDED_UNTRACKED_FILE_BYTES,
  normalizeLogicalPath,
  resolveRepository,
  runGit,
  SnapshotError,
  verifyIntendedFiles,
  snapshotIdentity,
  type FreezeResult,
  type Snapshot,
  type SnapshotTarget,
} from "./snapshot.js";

// ---- helpers: real temp git repos, always removed in teardown ----

const CLEAN_ENV = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith("GIT_")) env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
})();

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-C", cwd, ...args], {
    env: CLEAN_ENV,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

interface Fixture {
  dir: string;
  repo: string;
  cleanup: () => void;
}

function scratch(): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-snapshot-")));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeRepo(opts: { commit?: boolean } = {}): Fixture {
  const s = scratch();
  const repo = join(s.dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  if (opts.commit !== false) {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(repo, "b.txt"), "bee\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
  }
  return { dir: s.dir, repo, cleanup: s.cleanup };
}

function frozen(result: FreezeResult): Snapshot {
  assert.equal(result.status, "frozen");
  if (result.status !== "frozen") throw new Error("unreachable");
  return result.snapshot;
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Hash of the real index, every file in the worktree (not .git) and the raw .git listing. */
function userState(repo: string): { index: string; indexMtime: number; files: Record<string, string>; gitListing: string[] } {
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git" && prefix === "") continue;
      const full = join(dir, name);
      const rel = prefix + name;
      const st = statSync(full, { throwIfNoEntry: false });
      if (st?.isDirectory()) walk(full, rel + "/");
      else if (st) files[rel] = sha(full);
    }
  };
  walk(repo, "");
  const indexPath = join(repo, ".git", "index");
  return {
    index: existsSync(indexPath) ? sha(indexPath) : "absent",
    indexMtime: existsSync(indexPath) ? statSync(indexPath).mtimeMs : 0,
    files,
    gitListing: readdirSync(join(repo, ".git")).sort(),
  };
}

function expectCode(fn: () => unknown, code: string, reason?: string): SnapshotError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof SnapshotError, `expected SnapshotError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    if (reason !== undefined) assert.equal(error.reason, reason, error.message);
    return error;
  }
  assert.fail(`expected SnapshotError ${code}`);
}

function blob(repo: string, tree: string, path: string): string {
  return git(repo, "cat-file", "blob", `${tree}:${path}`);
}

const WORKSPACE: SnapshotTarget = { kind: "current-changes" };

// ---- projections ----

test("clean repository: empty diff is a typed result, not a snapshot", () => {
  const f = makeRepo();
  try {
    const r = freezeSnapshot(f.repo, WORKSPACE);
    assert.equal(r.status, "empty");
    if (r.status !== "empty") return;
    assert.equal(r.baseTree, r.candidateTree);
    assert.equal(r.baseTree, git(f.repo, "rev-parse", "HEAD^{tree}").trim());
    assert.equal(r.kind, "current-changes");
    assert.equal(r.projection, "workspace");
    assert.equal(freezeSnapshot(f.repo, { kind: "current-changes", projection: "staged" }).status, "empty");
  } finally {
    f.cleanup();
  }
});

test("modified tracked file: workspace snapshot carries every mirrored field", () => {
  const f = makeRepo();
  try {
    writeFileSync(join(f.repo, "a.txt"), "one\nTWO\nthree\n");
    const s = frozen(freezeSnapshot(f.repo, WORKSPACE));
    assert.equal(s.kind, "current-changes");
    assert.equal(s.projection, "workspace");
    assert.equal(s.unbornHead, false);
    assert.equal(s.baseTree, git(f.repo, "rev-parse", "HEAD^{tree}").trim());
    assert.notEqual(s.candidateTree, s.baseTree);
    assert.deepEqual(s.paths, ["a.txt"]);
    assert.equal(s.pathsDigest, domainHash("paths", 1, ["a.txt"]));
    assert.equal(s.pathsDigest, digestPaths(["a.txt"]));
    assert.deepEqual(s.intendedUntracked, []);
    assert.equal(s.intendedUntrackedProof, domainHash("intended-untracked", 1, []));
    assert.equal(s.changedLines, 2); // one line replaced = 1 addition + 1 deletion
    assert.equal(s.identity, domainHash("review-snapshot", 3, { kind: "current-changes", baseTree: s.baseTree, candidateTree: s.candidateTree, pathsDigest: s.pathsDigest }));
    assert.equal(s.identity, snapshotIdentity("current-changes", "workspace", s.baseTree, s.candidateTree, s.pathsDigest));
    assert.equal(blob(f.repo, s.candidateTree, "a.txt"), "one\nTWO\nthree\n");
    // resolveRepository from the same dir agrees
    const r = freezeSnapshot(f.repo, WORKSPACE);
    assert.equal(r.status === "frozen" && r.repository.root, f.repo);
  } finally {
    f.cleanup();
  }
});

test("deletions and tracked-file additions in the index are part of the workspace candidate", () => {
  const f = makeRepo();
  try {
    rmSync(join(f.repo, "b.txt"));
    writeFileSync(join(f.repo, "c.txt"), "new\n");
    git(f.repo, "add", "c.txt");
    const s = frozen(freezeSnapshot(f.repo, WORKSPACE));
    assert.deepEqual(s.paths, ["b.txt", "c.txt"]);
    assert.equal(s.changedLines, 2);
  } finally {
    f.cleanup();
  }
});

test("staged and workspace projections differ and use distinct identity domains", () => {
  const f = makeRepo();
  try {
    writeFileSync(join(f.repo, "a.txt"), "staged\n");
    git(f.repo, "add", "a.txt");
    writeFileSync(join(f.repo, "a.txt"), "workspace\n");
    const ws = frozen(freezeSnapshot(f.repo, { kind: "current-changes", projection: "workspace" }));
    const st = frozen(freezeSnapshot(f.repo, { kind: "current-changes", projection: "staged" }));
    assert.equal(blob(f.repo, st.candidateTree, "a.txt"), "staged\n");
    assert.equal(blob(f.repo, ws.candidateTree, "a.txt"), "workspace\n");
    assert.notEqual(ws.candidateTree, st.candidateTree);
    assert.notEqual(ws.identity, st.identity);
    assert.equal(st.projection, "staged");
    assert.equal(st.identity, domainHash("review-snapshot", 4, { kind: "current-changes", projection: "staged", baseTree: st.baseTree, candidateTree: st.candidateTree, pathsDigest: st.pathsDigest }));
    // staged ignores unstaged-only edits entirely
    writeFileSync(join(f.repo, "b.txt"), "unstaged only\n");
    const st2 = frozen(freezeSnapshot(f.repo, { kind: "current-changes", projection: "staged" }));
    assert.deepEqual(st2.paths, ["a.txt"]);
  } finally {
    f.cleanup();
  }
});

test("committed-only base-diff compares baseRef with HEAD and ignores dirty worktree and index", () => {
  const f = makeRepo();
  try {
    const first = git(f.repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(f.repo, "a.txt"), "second\n");
    git(f.repo, "commit", "-q", "-am", "second");
    writeFileSync(join(f.repo, "b.txt"), "dirty\n");
    writeFileSync(join(f.repo, "untracked.txt"), "u\n");
    const s = frozen(freezeSnapshot(f.repo, { kind: "base-diff", baseRef: first }));
    assert.equal(s.kind, "base-diff");
    assert.equal(s.projection, "workspace");
    assert.equal(s.baseTree, git(f.repo, "rev-parse", `${first}^{tree}`).trim());
    assert.equal(s.candidateTree, git(f.repo, "rev-parse", "HEAD^{tree}").trim());
    assert.deepEqual(s.paths, ["a.txt"]);
    assert.equal(s.changedLines, 4); // three lines replaced by one: 1 addition + 3 deletions
    assert.equal(s.identity, snapshotIdentity("base-diff", "workspace", s.baseTree, s.candidateTree, s.pathsDigest));
    // a tree id and a branch name resolve to the same base
    assert.equal(frozen(freezeSnapshot(f.repo, { kind: "base-diff", baseRef: "HEAD~1" })).identity, s.identity);
    assert.equal(frozen(freezeSnapshot(f.repo, { kind: "base-diff", baseRef: s.baseTree })).identity, s.identity);
    // baseRef == HEAD: empty
    assert.equal(freezeSnapshot(f.repo, { kind: "base-diff", baseRef: "HEAD" }).status, "empty");
  } finally {
    f.cleanup();
  }
});

test("base-diff refuses ranges, option-looking refs, unknown refs and intended paths", () => {
  const f = makeRepo();
  try {
    expectCode(() => freezeSnapshot(f.repo, { kind: "base-diff", baseRef: "HEAD~1..HEAD" }), "invalid_target");
    expectCode(() => freezeSnapshot(f.repo, { kind: "base-diff", baseRef: "--output=/tmp/x" }), "invalid_target");
    expectCode(() => freezeSnapshot(f.repo, { kind: "base-diff", baseRef: "  " }), "invalid_target");
    expectCode(() => freezeSnapshot(f.repo, { kind: "base-diff", baseRef: "no-such-branch" }), "unknown_revision");
    expectCode(() => freezeSnapshot(f.repo, { kind: "base-diff", baseRef: "HEAD", intendedUntracked: ["x"] } as SnapshotTarget), "invalid_target");
  } finally {
    f.cleanup();
  }
});

test("base-workspace-overlay: baseRef vs workspace, with its own identity domain", () => {
  const f = makeRepo();
  try {
    const first = git(f.repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(f.repo, "a.txt"), "second\n");
    git(f.repo, "commit", "-q", "-am", "second");
    writeFileSync(join(f.repo, "b.txt"), "dirty\n");
    const o = frozen(freezeSnapshot(f.repo, { kind: "base-workspace-overlay", baseRef: first }));
    assert.deepEqual(o.paths, ["a.txt", "b.txt"]);
    assert.equal(o.identity, domainHash("review-snapshot-base-workspace-overlay", 2, { kind: "base-workspace-overlay", baseTree: o.baseTree, candidateTree: o.candidateTree, pathsDigest: o.pathsDigest }));
    const cur = frozen(freezeSnapshot(f.repo, WORKSPACE));
    assert.notEqual(cur.identity, o.identity);
  } finally {
    f.cleanup();
  }
});

test("unborn HEAD: staged files diff against the empty tree; nothing staged is empty", () => {
  const f = makeRepo({ commit: false });
  try {
    assert.equal(freezeSnapshot(f.repo, { kind: "current-changes", projection: "staged" }).status, "empty");
    writeFileSync(join(f.repo, "first.txt"), "hello\n");
    git(f.repo, "add", "first.txt");
    const s = frozen(freezeSnapshot(f.repo, { kind: "current-changes", projection: "staged" }));
    assert.equal(s.unbornHead, true);
    assert.equal(s.baseTree, git(f.repo, "hash-object", "-t", "tree", "--stdin").trim() || s.baseTree);
    assert.deepEqual(s.paths, ["first.txt"]);
    expectCode(() => freezeSnapshot(f.repo, { kind: "base-diff", baseRef: "HEAD" }), "unknown_revision");
  } finally {
    f.cleanup();
  }
});

// ---- untracked handling ----

test("intended untracked is included only when listed; unlisted untracked files stay out", () => {
  const f = makeRepo();
  try {
    writeFileSync(join(f.repo, "listed.txt"), "listed\n");
    mkdirSync(join(f.repo, "sub"));
    writeFileSync(join(f.repo, "sub", "deep.txt"), "deep\n");
    writeFileSync(join(f.repo, "unlisted.txt"), "no\n");
    const without = freezeSnapshot(f.repo, WORKSPACE);
    assert.equal(without.status, "empty");
    const s = frozen(freezeSnapshot(f.repo, { kind: "current-changes", intendedUntracked: ["sub/deep.txt", "listed.txt"] }));
    assert.deepEqual(s.paths, ["listed.txt", "sub/deep.txt"]);
    assert.deepEqual(s.intendedUntracked, ["listed.txt", "sub/deep.txt"]);
    assert.ok(!s.paths.includes("unlisted.txt"));
    const entries = ["listed.txt", "sub/deep.txt"].map((p) => {
      const line = git(f.repo, "ls-tree", s.candidateTree, "--", p).trim();
      const m = /^(\d+) blob ([0-9a-f]+)\t/.exec(line)!;
      return { mode: m[1], oid: m[2], path: p };
    });
    assert.equal(s.intendedUntrackedProof, domainHash("intended-untracked", 1, entries));
    assert.notEqual(s.intendedUntrackedProof, domainHash("intended-untracked", 1, []));
    // listing order is irrelevant
    const swapped = frozen(freezeSnapshot(f.repo, { kind: "current-changes", intendedUntracked: ["listed.txt", "sub/deep.txt"] }));
    assert.equal(swapped.identity, s.identity);
    assert.equal(swapped.intendedUntrackedProof, s.intendedUntrackedProof);
    // tracked changes ride along
    writeFileSync(join(f.repo, "a.txt"), "changed\n");
    const both = frozen(freezeSnapshot(f.repo, { kind: "current-changes", intendedUntracked: ["listed.txt"] }));
    assert.deepEqual(both.paths, ["a.txt", "listed.txt"]);
  } finally {
    f.cleanup();
  }
});

test("untracked refusals: symlink, symlinked dir, `..`, absolute, outside, directory, missing, .git, big, ignored, tracked, staged", () => {
  const f = makeRepo();
  try {
    const outside = join(f.dir, "outside.txt");
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, join(f.repo, "link.txt"));
    mkdirSync(join(f.dir, "elsewhere"));
    writeFileSync(join(f.dir, "elsewhere", "f.txt"), "x\n");
    symlinkSync(join(f.dir, "elsewhere"), join(f.repo, "dirlink"));
    mkdirSync(join(f.repo, "adir"));
    writeFileSync(join(f.repo, "adir", "x.txt"), "x\n");
    writeFileSync(join(f.repo, "big.bin"), Buffer.alloc(MAX_INTENDED_UNTRACKED_FILE_BYTES + 1, 1));
    writeFileSync(join(f.repo, ".gitignore"), "*.log\n");
    git(f.repo, "add", ".gitignore");
    git(f.repo, "commit", "-q", "-m", "ignore");
    writeFileSync(join(f.repo, "x.log"), "log\n");
    const before = userState(f.repo);
    const t = (paths: string[]): SnapshotTarget => ({ kind: "current-changes", intendedUntracked: paths });
    expectCode(() => freezeSnapshot(f.repo, t(["link.txt"])), "untracked_refused", "symlink");
    expectCode(() => freezeSnapshot(f.repo, t(["dirlink/f.txt"])), "untracked_refused", "symlink");
    expectCode(() => freezeSnapshot(f.repo, t(["../outside.txt"])), "invalid_path");
    expectCode(() => freezeSnapshot(f.repo, t(["adir/../adir/x.txt"])), "invalid_path");
    expectCode(() => freezeSnapshot(f.repo, t([outside])), "invalid_path");
    expectCode(() => freezeSnapshot(f.repo, t(["./adir/x.txt"])), "invalid_path");
    expectCode(() => freezeSnapshot(f.repo, t(["adir/"])), "invalid_path");
    expectCode(() => freezeSnapshot(f.repo, t(["a\\b"])), "invalid_path");
    expectCode(() => freezeSnapshot(f.repo, t(["adir", "adir"])), "invalid_path");
    expectCode(() => freezeSnapshot(f.repo, t(["adir"])), "untracked_refused", "not_regular");
    expectCode(() => freezeSnapshot(f.repo, t(["nope.txt"])), "untracked_refused", "missing");
    expectCode(() => freezeSnapshot(f.repo, t([".git/config"])), "invalid_path");
    expectCode(() => freezeSnapshot(f.repo, t(["big.bin"])), "untracked_refused", "too_large");
    expectCode(() => freezeSnapshot(f.repo, t(["x.log"])), "untracked_refused", "ignored");
    expectCode(() => freezeSnapshot(f.repo, t(["a.txt"])), "untracked_refused", "tracked");
    expectCode(() => freezeSnapshot(f.repo, { kind: "current-changes", projection: "staged", intendedUntracked: ["adir/x.txt"] }), "untracked_refused", "staged_projection");
    assert.deepEqual(userState(f.repo), before, "refusals must not touch the user's index or worktree");
    assert.equal(readFileSync(outside, "utf8"), "secret\n");
  } finally {
    f.cleanup();
  }
});

// ---- the user's state is never modified ----

test("user's index and working tree are byte-identical across every projection (including a stale-stat index)", () => {
  const f = makeRepo();
  try {
    writeFileSync(join(f.repo, "a.txt"), "edited\n");
    writeFileSync(join(f.repo, "new.txt"), "new\n");
    writeFileSync(join(f.repo, "staged.txt"), "s\n");
    git(f.repo, "add", "staged.txt");
    const before = userState(f.repo);
    frozen(freezeSnapshot(f.repo, { kind: "current-changes", intendedUntracked: ["new.txt"] }));
    frozen(freezeSnapshot(f.repo, { kind: "current-changes", projection: "staged" }));
    frozen(freezeSnapshot(f.repo, { kind: "base-workspace-overlay", baseRef: "HEAD", intendedUntracked: ["new.txt"] }));
    assert.equal(freezeSnapshot(f.repo, { kind: "base-diff", baseRef: "HEAD" }).status, "empty");
    assert.deepEqual(userState(f.repo), before);
    // no scratch index left in the git dir
    assert.ok(!readdirSync(join(f.repo, ".git")).some((n) => n.includes("odd-review-index")));
  } finally {
    f.cleanup();
  }
});

test("missing index file: workspace candidate is built from an empty index and no index is created", () => {
  const f = makeRepo();
  try {
    rmSync(join(f.repo, ".git", "index"));
    const s = frozen(freezeSnapshot(f.repo, { kind: "current-changes", projection: "staged" }));
    assert.deepEqual(s.paths.sort(), ["a.txt", "b.txt"]); // everything looks deleted from an empty index
    assert.equal(existsSync(join(f.repo, ".git", "index")), false);
  } finally {
    f.cleanup();
  }
});

test("intent-to-add entries: workspace includes the content, the real index stays intact", () => {
  const f = makeRepo();
  try {
    writeFileSync(join(f.repo, "ita.txt"), "ita\n");
    git(f.repo, "add", "-N", "ita.txt");
    const before = userState(f.repo);
    const s = frozen(freezeSnapshot(f.repo, WORKSPACE));
    assert.deepEqual(s.paths, ["ita.txt"]);
    assert.equal(blob(f.repo, s.candidateTree, "ita.txt"), "ita\n");
    assert.deepEqual(userState(f.repo), before);
  } finally {
    f.cleanup();
  }
});

// ---- environment hygiene ----

test("caller GIT_* variables do not leak into git and do not change results", () => {
  const f = makeRepo();
  const other = makeRepo();
  const saved: Record<string, string | undefined> = {};
  const names = ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES", "GIT_NAMESPACE"];
  try {
    writeFileSync(join(f.repo, "a.txt"), "edited\n");
    const baseline = frozen(freezeSnapshot(f.repo, WORKSPACE));
    const baselineStaged = freezeSnapshot(f.repo, { kind: "current-changes", projection: "staged" });
    const bogusIndex = join(f.dir, "bogus-index");
    for (const n of names) saved[n] = process.env[n];
    process.env.GIT_INDEX_FILE = bogusIndex;
    process.env.GIT_DIR = join(other.repo, ".git");
    process.env.GIT_WORK_TREE = other.repo;
    process.env.GIT_OBJECT_DIRECTORY = join(other.repo, ".git", "objects");
    process.env.GIT_COMMON_DIR = join(other.repo, ".git");
    process.env.GIT_CEILING_DIRECTORIES = f.dir;
    process.env.GIT_NAMESPACE = "x";
    const before = userState(f.repo);
    const again = frozen(freezeSnapshot(f.repo, WORKSPACE));
    assert.deepEqual(again, baseline);
    assert.deepEqual(freezeSnapshot(f.repo, { kind: "current-changes", projection: "staged" }), baselineStaged);
    assert.equal(existsSync(bogusIndex), false, "the caller's GIT_INDEX_FILE must never be created or written");
    assert.deepEqual(userState(f.repo), before);
    assert.equal(resolveRepository(f.repo).root, f.repo);
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
    f.cleanup();
    other.cleanup();
  }
});

test("a hung or slow git is cut by the bounded timeout with a typed error", () => {
  const f = makeRepo();
  try {
    writeFileSync(join(f.repo, "a.txt"), "edited\n");
    expectCode(() => freezeSnapshot(f.repo, WORKSPACE, { gitTimeoutMs: 1 }), "git_timeout");
  } finally {
    f.cleanup();
  }
});

// ---- repository identity ----

test("repository identity: root, git dir and common dir; subdirectory cwd resolves to the root", () => {
  const f = makeRepo();
  try {
    mkdirSync(join(f.repo, "sub", "deeper"), { recursive: true });
    const id = resolveRepository(join(f.repo, "sub", "deeper"));
    assert.deepEqual(id, { root: f.repo, gitDir: join(f.repo, ".git"), commonDir: join(f.repo, ".git") });
    writeFileSync(join(f.repo, "a.txt"), "edited\n");
    assert.deepEqual(frozen(freezeSnapshot(join(f.repo, "sub"), WORKSPACE)).paths, ["a.txt"]);
  } finally {
    f.cleanup();
  }
});

test("not a repository, missing directory and bare repository are typed errors", () => {
  const s = scratch();
  try {
    expectCode(() => resolveRepository(s.dir), "not_a_repository");
    expectCode(() => resolveRepository(join(s.dir, "missing")), "not_a_repository");
    expectCode(() => freezeSnapshot(s.dir, WORKSPACE), "not_a_repository");
    const bare = join(s.dir, "bare.git");
    git(s.dir, "init", "-q", "--bare", bare);
    expectCode(() => resolveRepository(bare), "bare_repository");
    expectCode(() => freezeSnapshot(s.dir, { kind: "nope" } as unknown as SnapshotTarget), "invalid_target");
    expectCode(() => freezeSnapshot(s.dir, { kind: "current-changes", projection: "bogus" } as unknown as SnapshotTarget), "invalid_target");
  } finally {
    s.cleanup();
  }
});

test("linked worktrees: own index and root, shared common dir, main checkout untouched", () => {
  const f = makeRepo();
  try {
    const wt = join(f.dir, "linked");
    git(f.repo, "worktree", "add", "-q", "-b", "feature", wt);
    const id = resolveRepository(wt);
    assert.equal(id.root, wt);
    assert.equal(id.commonDir, join(f.repo, ".git"));
    assert.notEqual(id.gitDir, id.commonDir);
    writeFileSync(join(wt, "a.txt"), "linked edit\n");
    writeFileSync(join(wt, "n.txt"), "n\n");
    git(wt, "add", "b.txt");
    const mainBefore = userState(f.repo);
    const s = frozen(freezeSnapshot(wt, { kind: "current-changes", intendedUntracked: ["n.txt"] }));
    assert.deepEqual(s.paths, ["a.txt", "n.txt"]);
    assert.equal(blob(wt, s.candidateTree, "a.txt"), "linked edit\n");
    const staged = freezeSnapshot(wt, { kind: "current-changes", projection: "staged" });
    assert.equal(staged.status, "empty"); // b.txt staged but unchanged
    assert.deepEqual(userState(f.repo), mainBefore);
    // main checkout sees none of the linked edits
    assert.equal(freezeSnapshot(f.repo, WORKSPACE).status, "empty");
  } finally {
    f.cleanup();
  }
});

// ---- determinism and hostile names ----

test("same inputs give identical results; different content gives a different identity", () => {
  const f = makeRepo();
  try {
    writeFileSync(join(f.repo, "a.txt"), "x\n");
    writeFileSync(join(f.repo, "u.txt"), "u\n");
    const target: SnapshotTarget = { kind: "current-changes", intendedUntracked: ["u.txt"] };
    const one = freezeSnapshot(f.repo, target);
    const two = freezeSnapshot(f.repo, target);
    assert.deepEqual(one, two);
    writeFileSync(join(f.repo, "a.txt"), "y\n");
    const three = frozen(freezeSnapshot(f.repo, target));
    assert.notEqual(three.identity, frozen(one).identity);
    assert.equal(three.pathsDigest, frozen(one).pathsDigest);
  } finally {
    f.cleanup();
  }
});

test("hostile filenames (spaces, newlines, unicode, leading dash, pathspec magic, globs) round-trip", () => {
  const f = makeRepo();
  try {
    const names = ["with space.txt", "new\nline.txt", "ünï ☃ 😀.txt", "-dash.txt", ":(top)magic.txt", "glob*.txt", "[br].txt", "tab\there.txt", "quote\"s.txt", "emoji/😀/dir file.txt"];
    for (const name of names) {
      const full = join(f.repo, name);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, `${name}\n`);
    }
    // two of them tracked first, then modified
    git(f.repo, "add", "--", "with space.txt", "new\nline.txt");
    git(f.repo, "commit", "-q", "-m", "hostile");
    writeFileSync(join(f.repo, "with space.txt"), "changed\n");
    writeFileSync(join(f.repo, "new\nline.txt"), "changed\n");
    const untracked = names.filter((n) => n !== "with space.txt" && n !== "new\nline.txt");
    const s = frozen(freezeSnapshot(f.repo, { kind: "current-changes", intendedUntracked: untracked }));
    const expected = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    assert.deepEqual(s.paths, expected);
    assert.deepEqual(s.intendedUntracked, [...untracked].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    assert.equal(blob(f.repo, s.candidateTree, "new\nline.txt"), "changed\n");
    assert.equal(blob(f.repo, s.candidateTree, "glob*.txt"), "glob*.txt\n");
    assert.equal(blob(f.repo, s.candidateTree, ":(top)magic.txt"), ":(top)magic.txt\n");
    // an unlisted lookalike of a glob is not swept in
    writeFileSync(join(f.repo, "globX.txt"), "no\n");
    assert.ok(!frozen(freezeSnapshot(f.repo, { kind: "current-changes", intendedUntracked: untracked })).paths.includes("globX.txt"));
  } finally {
    f.cleanup();
  }
});

test("paths sort bytewise on UTF-8, not by UTF-16 code unit", () => {
  const f = makeRepo();
  try {
    // U+FF5E (BMP, UTF-8 EF BD 9E) vs U+1F600 (astral, UTF-8 F0 9F 98 80): bytewise puts the BMP one first,
    // UTF-16 code unit order would put the astral surrogate (D83D) before U+FF5E.
    const bmp = "～.txt";
    const astral = "\u{1f600}.txt";
    writeFileSync(join(f.repo, bmp), "a\n");
    writeFileSync(join(f.repo, astral), "b\n");
    const s = frozen(freezeSnapshot(f.repo, { kind: "current-changes", intendedUntracked: [astral, bmp] }));
    assert.deepEqual(s.paths, [bmp, astral]);
  } finally {
    f.cleanup();
  }
});

// ---- changed lines ----

test("changed lines: additions + deletions; binary and mode-only count zero", () => {
  const f = makeRepo();
  try {
    writeFileSync(join(f.repo, "bin.dat"), Buffer.from([0, 1, 2, 0, 3]));
    git(f.repo, "add", "bin.dat");
    git(f.repo, "commit", "-q", "-m", "bin");
    const base = frozen(freezeSnapshot(f.repo, { kind: "base-diff", baseRef: "HEAD~1" }));
    assert.equal(base.changedLines, 0, "a lone binary file counts zero lines");
    writeFileSync(join(f.repo, "bin.dat"), Buffer.from([9, 9, 0, 9]));
    writeFileSync(join(f.repo, "a.txt"), "one\ntwo\nthree\nfour\nfive\n"); // +2
    chmodSync(join(f.repo, "b.txt"), 0o755);
    const s = frozen(freezeSnapshot(f.repo, WORKSPACE));
    assert.deepEqual(s.paths, ["a.txt", "b.txt", "bin.dat"]);
    assert.equal(s.changedLines, 2);
    const repo = resolveRepository(f.repo);
    assert.equal(countChangedLines(repo, s.baseTree, s.candidateTree), 2);
    assert.equal(countChangedLines(repo, s.baseTree, s.baseTree), 0);
    expectCode(() => countChangedLines(repo, "HEAD", s.candidateTree), "invalid_target");
  } finally {
    f.cleanup();
  }
});

test("generated golden files do not count toward changed lines", () => {
  const f = makeRepo();
  try {
    mkdirSync(join(f.repo, "pkg", "testdata", "golden"), { recursive: true });
    writeFileSync(join(f.repo, "pkg", "testdata", "golden", "x.golden"), "g\n".repeat(50));
    writeFileSync(join(f.repo, "real.txt"), "r\n");
    const s = frozen(freezeSnapshot(f.repo, { kind: "current-changes", intendedUntracked: ["pkg/testdata/golden/x.golden", "real.txt"] }));
    assert.equal(s.changedLines, 1);
  } finally {
    f.cleanup();
  }
});

test("normalizeLogicalPath accepts canonical paths only", () => {
  assert.equal(normalizeLogicalPath("a/b c/d.txt"), "a/b c/d.txt");
  assert.equal(normalizeLogicalPath("new\nline"), "new\nline");
  for (const bad of ["", "/a", "a//b", "a/./b", "a/../b", "..", ".", "a/", "a\\b", "a\0b"]) {
    expectCode(() => normalizeLogicalPath(bad), "invalid_path");
  }
});

// ---- verifier findings F1-F7 ----

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i}\n`).join("");
}

test("F1: attributes outside the frozen trees never change changedLines or identity", () => {
  const f = makeRepo();
  try {
    writeFileSync(join(f.repo, "a.txt"), lines(503));
    const baseline = frozen(freezeSnapshot(f.repo, WORKSPACE));
    assert.equal(baseline.changedLines, 503 + 3);
    writeFileSync(join(f.repo, ".gitattributes"), "* -diff\n"); // untracked: not part of the candidate
    writeFileSync(join(f.repo, ".git", "info", "attributes"), "*.txt binary\n");
    const after = frozen(freezeSnapshot(f.repo, WORKSPACE));
    assert.equal(after.identity, baseline.identity);
    assert.equal(after.changedLines, baseline.changedLines);
    const repo = resolveRepository(f.repo);
    assert.equal(countChangedLines(repo, after.baseTree, after.candidateTree), 506);
  } finally {
    f.cleanup();
  }
});

test("F1: a candidate that adds `*.txt -diff` cannot lower its own count", () => {
  const f = makeRepo();
  try {
    writeFileSync(join(f.repo, "a.txt"), lines(503));
    writeFileSync(join(f.repo, ".gitattributes"), "*.txt -diff\n");
    git(f.repo, "add", ".gitattributes");
    const s = frozen(freezeSnapshot(f.repo, WORKSPACE));
    assert.deepEqual(s.paths, [".gitattributes", "a.txt"]);
    assert.equal(s.changedLines, 503 + 3 + 1);
    // user config that changes diff behaviour is ignored as well
    git(f.repo, "config", "diff.algorithm", "histogram");
    assert.equal(frozen(freezeSnapshot(f.repo, WORKSPACE)).changedLines, 507);
  } finally {
    f.cleanup();
  }
});

test("F2: an active info/grafts file is refused; an empty or comment-only one is not", () => {
  const f = makeRepo();
  try {
    writeFileSync(join(f.repo, "a.txt"), "x\n");
    const grafts = join(f.repo, ".git", "info", "grafts");
    mkdirSync(join(f.repo, ".git", "info"), { recursive: true });
    writeFileSync(grafts, "# nothing\n\n");
    assert.equal(frozen(freezeSnapshot(f.repo, WORKSPACE)).paths[0], "a.txt");
    const head = git(f.repo, "rev-parse", "HEAD").trim();
    writeFileSync(grafts, `${head}\n`);
    expectCode(() => freezeSnapshot(f.repo, WORKSPACE), "local_graft_active");
    expectCode(() => freezeSnapshot(f.repo, { kind: "base-diff", baseRef: "HEAD" }), "local_graft_active");
  } finally {
    f.cleanup();
  }
});

test("F2: grafts in the common dir are refused from a linked worktree too", () => {
  const f = makeRepo();
  try {
    const wt = join(f.dir, "linked");
    git(f.repo, "worktree", "add", "-q", "-b", "feat", wt);
    mkdirSync(join(f.repo, ".git", "info"), { recursive: true });
    writeFileSync(join(f.repo, ".git", "info", "grafts"), `${git(f.repo, "rev-parse", "HEAD").trim()}\n`);
    writeFileSync(join(wt, "a.txt"), "x\n");
    expectCode(() => freezeSnapshot(wt, WORKSPACE), "local_graft_active");
  } finally {
    f.cleanup();
  }
});

test("F3: an intended-untracked hardlink (even to a file outside the repo) is refused", () => {
  const f = makeRepo();
  try {
    const outside = join(f.dir, "outside.txt");
    writeFileSync(outside, "secret\n");
    linkSync(outside, join(f.repo, "hard.txt"));
    const before = userState(f.repo);
    expectCode(() => freezeSnapshot(f.repo, { kind: "current-changes", intendedUntracked: ["hard.txt"] }), "untracked_refused", "hardlink");
    assert.deepEqual(userState(f.repo), before);
  } finally {
    f.cleanup();
  }
});

/** Builds a tree holding `entries` directly through plumbing (no worktree involved). */
function plumbTree(repo: string, entries: Array<{ mode: string; type: string; content?: Buffer; oid?: string; name: Buffer }>): string {
  const chunks: Buffer[] = [];
  for (const e of entries) {
    let oid = e.oid;
    if (!oid) {
      const r = spawnSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { env: CLEAN_ENV, input: e.content ?? Buffer.alloc(0) });
      oid = r.stdout.toString().trim();
    }
    chunks.push(Buffer.from(`${e.mode} ${e.type} ${oid}\t`), e.name, Buffer.from([0]));
  }
  const r = spawnSync("git", ["-C", repo, "mktree", "-z"], { env: CLEAN_ENV, input: Buffer.concat(chunks) });
  assert.equal(r.status, 0, r.stderr.toString());
  return r.stdout.toString().trim();
}

test("F4: the proof checks blob size and mode in the candidate tree, not the pre-add file", () => {
  const f = makeRepo();
  try {
    const repo = resolveRepository(f.repo);
    const big = plumbTree(f.repo, [{ mode: "100644", type: "blob", content: Buffer.alloc(MAX_INTENDED_UNTRACKED_FILE_BYTES + 1, 7), name: Buffer.from("big.bin") }]);
    expectCode(() => intendedUntrackedProof(repo, big, ["big.bin"]), "untracked_refused", "too_large");
    const ok = plumbTree(f.repo, [{ mode: "100644", type: "blob", content: Buffer.alloc(MAX_INTENDED_UNTRACKED_FILE_BYTES, 7), name: Buffer.from("fits.bin") }]);
    assert.match(intendedUntrackedProof(repo, ok, ["fits.bin"]), /^sha256:[0-9a-f]{64}$/);
    const link = plumbTree(f.repo, [{ mode: "120000", type: "blob", content: Buffer.from("/etc/passwd"), name: Buffer.from("l") }]);
    expectCode(() => intendedUntrackedProof(repo, link, ["l"]), "untracked_refused", "not_regular_in_tree");
    expectCode(() => intendedUntrackedProof(repo, ok, ["absent.bin"]), "untracked_refused", "missing");
  } finally {
    f.cleanup();
  }
});

function deadPid(): number {
  return Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
}

function seedScratch(base: string, name: string, owner: unknown, ageMs: number, extra: string[] = ["index"]): string {
  const dir = join(base, name);
  mkdirSync(dir);
  for (const n of extra) writeFileSync(join(dir, n), "x");
  if (owner !== undefined) writeFileSync(join(dir, "owner.json"), JSON.stringify(owner));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(dir, t, t);
  return dir;
}

test("F5: stale private index copies (old, owner dead) are swept; live, fresh and foreign ones are kept; real index untouched", () => {
  const f = makeRepo();
  try {
    const gitDir = join(f.repo, ".git");
    const HOUR = 3_600_000;
    const stale = seedScratch(gitDir, ".odd-review-index-stale", { pid: deadPid() }, HOUR);
    const noOwner = seedScratch(gitDir, ".odd-review-index-noowner", undefined, HOUR);
    const live = seedScratch(gitDir, ".odd-review-index-live", { pid: process.pid }, HOUR);
    const fresh = seedScratch(gitDir, ".odd-review-index-fresh", { pid: deadPid() }, 1000);
    const foreign = seedScratch(gitDir, ".odd-review-index-foreign", { pid: deadPid() }, HOUR, ["index", "precious.txt"]);
    const unrelated = seedScratch(gitDir, "unrelated-dir", { pid: deadPid() }, HOUR);
    const indexBefore = sha(join(gitDir, ".git".length ? "index" : "index"));
    writeFileSync(join(f.repo, "a.txt"), "x\n");
    frozen(freezeSnapshot(f.repo, WORKSPACE));
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(noOwner), false);
    assert.equal(existsSync(live), true);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(foreign), true, "directories with unexpected content are never removed");
    assert.equal(existsSync(unrelated), true);
    assert.equal(sha(join(gitDir, "index")), indexBefore);
  } finally {
    f.cleanup();
  }
});

test("F5: a symlink named like a scratch dir is never followed or removed", () => {
  const f = makeRepo();
  try {
    const target = join(f.dir, "precious");
    mkdirSync(target);
    writeFileSync(join(target, "index"), "keep");
    const link = join(f.repo, ".git", ".odd-review-index-link");
    symlinkSync(target, link);
    const t = (Date.now() - 3_600_000) / 1000;
    writeFileSync(join(f.repo, "a.txt"), "x\n");
    frozen(freezeSnapshot(f.repo, WORKSPACE));
    assert.equal(readFileSync(join(target, "index"), "utf8"), "keep");
    assert.equal(existsSync(link), true);
    void t;
  } finally {
    f.cleanup();
  }
});

test("F6: wrong-case and non-NFC spellings are refused instead of frozen under the caller's spelling", () => {
  const f = makeRepo();
  try {
    mkdirSync(join(f.repo, "sub"));
    writeFileSync(join(f.repo, "sub", "f.txt"), "f\n");
    writeFileSync(join(f.repo, "Mixed.txt"), "m\n");
    const t = (p: string): SnapshotTarget => ({ kind: "current-changes", intendedUntracked: [p] });
    for (const wrong of ["SUB/f.txt", "sub/F.TXT", "mixed.txt"]) {
      const e = expectCode(() => freezeSnapshot(f.repo, t(wrong)), "untracked_refused");
      assert.ok(e.reason === "name_mismatch" || e.reason === "missing", `${wrong}: ${e.reason}`);
    }
    assert.deepEqual(frozen(freezeSnapshot(f.repo, t("sub/f.txt"))).paths, ["sub/f.txt"]);
    // NFD spelling is refused outright; the NFC spelling works
    const nfd = "e\u0301.txt";
    const nfc = "\u00e9.txt";
    writeFileSync(join(f.repo, nfc), "e\n");
    expectCode(() => freezeSnapshot(f.repo, t(nfd)), "invalid_path");
    assert.deepEqual(frozen(freezeSnapshot(f.repo, t(nfc))).paths, [nfc]);
  } finally {
    f.cleanup();
  }
});

test("F7: a path that is not valid UTF-8 fails closed instead of being hashed lossily", () => {
  const f = makeRepo();
  try {
    const bad = plumbTree(f.repo, [{ mode: "100644", type: "blob", content: Buffer.from("x\n"), name: Buffer.from([0x62, 0xff, 0x2e, 0x74]) }]);
    expectCode(() => freezeSnapshot(f.repo, { kind: "base-diff", baseRef: bad }), "invalid_encoding");
    // a valid-UTF-8 name that starts with a BOM survives intact
    writeFileSync(join(f.repo, "\ufeffbom.txt"), "b\n");
    const s = frozen(freezeSnapshot(f.repo, { kind: "current-changes", intendedUntracked: ["\ufeffbom.txt"] }));
    assert.deepEqual(s.paths, ["\ufeffbom.txt"]);
  } finally {
    f.cleanup();
  }
});

test("R1: after the tree is built, a file swapped for a hardlink or changed content is refused", () => {
  const f = makeRepo();
  try {
    writeFileSync(join(f.repo, "new.txt"), "inside\n");
    const s = frozen(freezeSnapshot(f.repo, { kind: "current-changes", intendedUntracked: ["new.txt"] }));
    const repo = resolveRepository(f.repo);
    // unchanged file: verified
    verifyIntendedFiles(repo, s.candidateTree, ["new.txt"]);
    // content changed after the freeze
    writeFileSync(join(f.repo, "new.txt"), "different\n");
    expectCode(() => verifyIntendedFiles(repo, s.candidateTree, ["new.txt"]), "untracked_refused", "changed");
    // swapped for a hardlink to outside content (same bytes, so only the link count gives it away)
    writeFileSync(join(f.repo, "new.txt"), "inside\n");
    const outside = join(f.dir, "outside.txt");
    writeFileSync(outside, "inside\n");
    rmSync(join(f.repo, "new.txt"));
    linkSync(outside, join(f.repo, "new.txt"));
    expectCode(() => verifyIntendedFiles(repo, s.candidateTree, ["new.txt"]), "untracked_refused", "hardlink");
    // swapped for a symlink
    rmSync(join(f.repo, "new.txt"));
    symlinkSync(outside, join(f.repo, "new.txt"));
    expectCode(() => verifyIntendedFiles(repo, s.candidateTree, ["new.txt"]), "untracked_refused", "symlink");
  } finally {
    f.cleanup();
  }
});

test("R2: with core.precomposeunicode, an NFD name on disk is frozen under its NFC path", { skip: process.platform !== "darwin" ? "core.precomposeunicode and NFD/NFC normalization are macOS-only" : false }, () => {
  const f = makeRepo();
  try {
    git(f.repo, "config", "core.precomposeunicode", "true"); // explicit: the default differs per platform (macOS sets it, Linux leaves it unset)
    const nfd = "cafe\u0301.txt";
    const nfc = "caf\u00e9.txt";
    writeFileSync(join(f.repo, nfd), "c\n");
    if (!readdirSync(f.repo).includes(nfd)) return; // the filesystem normalizes names itself
    const s = frozen(freezeSnapshot(f.repo, { kind: "current-changes", intendedUntracked: [nfc] }));
    assert.deepEqual(s.paths, [nfc]);
    assert.deepEqual(s.intendedUntracked, [nfc]);
    expectCode(() => freezeSnapshot(f.repo, { kind: "current-changes", intendedUntracked: [nfd] }), "invalid_path");
  } finally {
    f.cleanup();
  }
});

test("R2b: with core.precomposeunicode unset (git exits 1 for an absent key), the snapshot still freezes on every OS", () => {
  const f = makeRepo();
  try {
    spawnSync("git", ["-C", f.repo, "config", "--unset-all", "core.precomposeunicode"], { env: CLEAN_ENV }); // exit 5 when already absent: fine
    const absent = spawnSync("git", ["-C", f.repo, "config", "--type=bool", "--get", "core.precomposeunicode"], { env: CLEAN_ENV, encoding: "utf8" });
    assert.equal(absent.status, 1);
    writeFileSync(join(f.repo, "new.txt"), "n\n");
    const s = frozen(freezeSnapshot(f.repo, { kind: "current-changes", intendedUntracked: ["new.txt"] }));
    assert.deepEqual(s.intendedUntracked, ["new.txt"]);
  } finally {
    f.cleanup();
  }
});

test("A2: a timed-out git call reports the bound actually applied; the check's time budget when that was the binding limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-snap-bound-"));
  const prevPath = process.env.PATH;
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\nsleep 5 >/dev/null 2>&1 </dev/null\n", { mode: 0o755 });
    process.env.PATH = `${bin}:${prevPath ?? ""}`;
    const message = (call: Parameters<typeof runGit>[0]): string => {
      try {
        runGit(call);
      } catch (error) {
        assert.ok(error instanceof SnapshotError);
        assert.equal(error.code, "git_timeout");
        return error.message;
      }
      throw new Error("expected git_timeout");
    };
    // the per-call bound binds (no deadline, or a deadline far away): its own value, no budget wording
    const own = message({ cwd: dir, args: ["status"], timeoutMs: 300 });
    assert.equal(own, "git status timed out after 300ms");
    assert.equal(message({ cwd: dir, args: ["status"], timeoutMs: 300, deadlineAt: Date.now() + 60_000 }), own);
    // the deadline binds: the time left (well under the 8000 ms per-call bound), named as the check's time budget
    const t0 = Date.now();
    const cut = message({ cwd: dir, args: ["status"], timeoutMs: 8000, deadlineAt: t0 + 400 });
    const m = /^git status timed out after (\d+)ms \(the check's time budget\)$/.exec(cut);
    assert.ok(m, cut);
    assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= 400, cut);
    assert.ok(Date.now() - t0 < 3000);
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
