import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, statSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneModePath, readReviewMode, ReviewModeError, setReviewMode } from "./mode.js";
import { resolveRepository, SnapshotError } from "./snapshot.js";

const ENV = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith("GIT_")) env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
})();

interface Fx {
  data: string;
  repo: string;
  commonDir: string;
  plain: string;
  cleanup: () => void;
}

function fx(): Fx {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-mode-")));
  const repo = join(dir, "repo");
  const plain = join(dir, "plain");
  mkdirSync(repo);
  mkdirSync(plain);
  const r = spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"], { env: ENV });
  assert.equal(r.status, 0);
  return { data: join(dir, "data"), repo, commonDir: realpathSync(join(repo, ".git")), plain, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      out.push(p + (e.isDirectory() ? "/" : ":" + readFileSync(p, "utf8")));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

test("default is OFF: nothing stored, nothing set, source default", () => {
  const f = fx();
  try {
    const s = readReviewMode(f.repo, { dataDir: f.data });
    assert.deepEqual(s, { effective: "off", source: "default", global: "unset", cloneLocal: "unset", problems: [] });
    assert.equal(readReviewMode(undefined, { dataDir: f.data }).effective, "off");
    // no data dir at all (hook without CLAUDE_PLUGIN_DATA): still off, never throws
    assert.equal(readReviewMode(f.repo, { env: {} }).effective, "off");
  } finally {
    f.cleanup();
  }
});

test("global enable/disable: on only after enable, off again after disable", () => {
  const f = fx();
  try {
    const on = setReviewMode("enable", "global", f.repo, { dataDir: f.data });
    assert.equal(on.effective, "on");
    assert.equal(on.source, "global");
    assert.equal(readReviewMode(f.repo, { dataDir: f.data }).effective, "on");
    assert.equal(readReviewMode(f.plain, { dataDir: f.data }).effective, "on"); // global applies outside a repo too
    const off = setReviewMode("disable", "global", f.repo, { dataDir: f.data });
    assert.deepEqual([off.effective, off.source, off.global], ["off", "global", "off"]);
  } finally {
    f.cleanup();
  }
});

test("clone scope: disable stores an off-only override under <git-common-dir>/odd-plugin; enable clears it and never forces on", () => {
  const f = fx();
  try {
    setReviewMode("enable", "global", f.repo, { dataDir: f.data });
    const off = setReviewMode("disable", "clone", f.repo, { dataDir: f.data });
    assert.deepEqual([off.effective, off.source, off.cloneLocal, off.global], ["off", "clone-local", "off", "on"]);
    assert.equal(cloneModePath(f.commonDir), join(f.commonDir, "odd-plugin", "review-mode.json"));
    assert.equal(lstatSync(cloneModePath(f.commonDir)).isFile(), true);
    // the override is per clone: another repo is untouched
    const other = fx();
    try {
      assert.equal(readReviewMode(other.repo, { dataDir: f.data }).effective, "on");
    } finally {
      other.cleanup();
    }
    const cleared = setReviewMode("enable", "clone", f.repo, { dataDir: f.data });
    assert.deepEqual([cleared.effective, cleared.source, cleared.cloneLocal], ["on", "global", "unset"]);
    assert.equal(existsSync(cloneModePath(f.commonDir)), false);
    // clearing the override with the global switch off cannot turn it on
    setReviewMode("disable", "global", f.repo, { dataDir: f.data });
    assert.equal(setReviewMode("enable", "clone", f.repo, { dataDir: f.data }).effective, "off");
    // enabling an already-clear override is a no-op, not an error
    assert.equal(setReviewMode("enable", "clone", f.repo, { dataDir: f.data }).cloneLocal, "unset");
  } finally {
    f.cleanup();
  }
});

test("clone scope without a repository, global scope without a data dir: typed errors, nothing written", () => {
  const f = fx();
  try {
    assert.throws(() => setReviewMode("disable", "clone", f.plain, { dataDir: f.data }), ReviewModeError);
    assert.throws(() => setReviewMode("disable", "clone", undefined, { dataDir: f.data }), ReviewModeError);
    assert.throws(() => setReviewMode("enable", "global", f.repo, { env: {} }), ReviewModeError);
    assert.deepEqual(tree(f.data), []);
    assert.deepEqual(tree(join(f.commonDir, "odd-plugin")), []);
  } finally {
    f.cleanup();
  }
});

test("status is read-only: reading writes and creates nothing, before and after a write", () => {
  const f = fx();
  try {
    const before = [tree(f.data), tree(f.commonDir).filter((p) => p.includes("odd-plugin"))];
    readReviewMode(f.repo, { dataDir: f.data });
    assert.deepEqual([tree(f.data), tree(f.commonDir).filter((p) => p.includes("odd-plugin"))], before);
    setReviewMode("enable", "global", f.repo, { dataDir: f.data });
    setReviewMode("disable", "clone", f.repo, { dataDir: f.data });
    const snap = [tree(f.data), tree(join(f.commonDir, "odd-plugin"))];
    for (let i = 0; i < 3; i++) readReviewMode(f.repo, { dataDir: f.data });
    assert.deepEqual([tree(f.data), tree(join(f.commonDir, "odd-plugin"))], snap);
  } finally {
    f.cleanup();
  }
});

test("a clone override that cannot be read or is malformed fails closed (off) and says why", () => {
  const f = fx();
  try {
    setReviewMode("enable", "global", f.repo, { dataDir: f.data });
    mkdirSync(join(f.commonDir, "odd-plugin"), { recursive: true });
    const p = cloneModePath(f.commonDir);
    for (const body of ["{not json", JSON.stringify({ schema: "other", mode: "off" }), JSON.stringify({ schema: "odd-claude.review-mode-override/v1", mode: "on" })]) {
      writeFileSync(p, body);
      const s = readReviewMode(f.repo, { dataDir: f.data });
      assert.deepEqual([s.effective, s.source, s.cloneLocal], ["off", "clone-local", "unreadable"], body);
      assert.equal(s.problems.length, 1);
    }
    rmSync(p);
    symlinkSync(join(f.plain), p); // a symlink is never followed
    const s = readReviewMode(f.repo, { dataDir: f.data });
    assert.deepEqual([s.effective, s.cloneLocal], ["off", "unreadable"]);
    // a corrupt global file reads as unset (default off), never on
    rmSync(p);
    writeFileSync(join(f.data, "review-mode.json"), "garbage");
    assert.equal(readReviewMode(f.repo, { dataDir: f.data }).effective, "off");
    chmodSync(f.data, 0o700);
  } finally {
    f.cleanup();
  }
});

test("a symlinked odd-plugin dir: enable --scope clone refuses and the external file survives; disable refuses; reads fail closed to off", () => {
  const f = fx();
  try {
    setReviewMode("enable", "global", f.repo, { dataDir: f.data });
    const outside = join(f.plain, "elsewhere");
    mkdirSync(outside);
    const external = join(outside, "review-mode.json");
    writeFileSync(external, JSON.stringify({ schema: "odd-claude.review-mode-override/v1", mode: "off" }) + "\n");
    symlinkSync(outside, join(f.commonDir, "odd-plugin"));
    assert.throws(() => setReviewMode("enable", "clone", f.repo, { dataDir: f.data }), ReviewModeError);
    assert.equal(existsSync(external), true);
    assert.throws(() => setReviewMode("disable", "clone", f.repo, { dataDir: f.data }), ReviewModeError);
    assert.equal(readFileSync(external, "utf8").includes('"off"'), true);
    assert.deepEqual(readdirSync(outside), ["review-mode.json"]);
    // reading does not follow it either: unreadable, effective off even though the target says nothing about on
    writeFileSync(external, JSON.stringify({ schema: "other" }));
    const s = readReviewMode(f.repo, { dataDir: f.data });
    assert.deepEqual([s.effective, s.source, s.cloneLocal], ["off", "clone-local", "unreadable"]);
    assert.equal(s.problems.length, 1);
  } finally {
    f.cleanup();
  }
});

test("a symlinked odd-plugin dir pointing at an EMPTY directory reads unreadable/off even with global on", () => {
  const f = fx();
  try {
    setReviewMode("enable", "global", f.repo, { dataDir: f.data });
    const empty = join(f.plain, "empty-target");
    mkdirSync(empty);
    symlinkSync(empty, join(f.commonDir, "odd-plugin"));
    const s = readReviewMode(f.repo, { dataDir: f.data });
    assert.deepEqual([s.effective, s.source, s.cloneLocal], ["off", "clone-local", "unreadable"]);
    assert.equal(s.problems.length, 1);
    assert.deepEqual(readdirSync(empty), []);
  } finally {
    f.cleanup();
  }
});

test("enable --scope clone refuses a symlinked or non-regular override file and leaves it alone", () => {
  const f = fx();
  try {
    mkdirSync(join(f.commonDir, "odd-plugin"));
    const target = join(f.plain, "t.json");
    writeFileSync(target, "x");
    const p = cloneModePath(f.commonDir);
    symlinkSync(target, p);
    assert.throws(() => setReviewMode("enable", "clone", f.repo, { dataDir: f.data }), ReviewModeError);
    assert.equal(existsSync(target), true);
    assert.equal(lstatSync(p).isSymbolicLink(), true);
    rmSync(p);
    mkdirSync(p);
    assert.throws(() => setReviewMode("enable", "clone", f.repo, { dataDir: f.data }), ReviewModeError);
    assert.equal(lstatSync(p).isDirectory(), true);
  } finally {
    f.cleanup();
  }
});

test("reading never rewrites the global file: inode, mtime and bytes unchanged after three reads", async () => {
  const f = fx();
  try {
    setReviewMode("enable", "global", f.repo, { dataDir: f.data });
    const file = join(f.data, "review-mode.json");
    const before = statSync(file);
    const bytes = readFileSync(file, "utf8");
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 3; i++) readReviewMode(f.repo, { dataDir: f.data });
    const after = statSync(file);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(readFileSync(file, "utf8"), bytes);
  } finally {
    f.cleanup();
  }
});

test("git failing while resolving the repository: the clone override is read from the nearest .git directory (off wins); a .git file is followed to the real common dir; an unlocatable one leaves the global switch; no repository stays n/a", () => {
  const f = fx();
  const prevPath = process.env.PATH;
  try {
    setReviewMode("enable", "global", f.repo, { dataDir: f.data });
    const bin = join(f.plain, "bin");
    mkdirSync(bin);
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase "$*" in *--git-common-dir*) echo "fatal: boom" >&2; exit 128;; esac\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    const sub = join(f.repo, "a", "b");
    mkdirSync(sub, { recursive: true });
    setReviewMode("disable", "clone", f.repo, { dataDir: f.data });
    process.env.PATH = `${bin}:${prevPath ?? ""}`;
    const off = readReviewMode(sub, { dataDir: f.data });
    assert.equal(off.effective, "off");
    assert.equal(off.cloneLocal, "off");
    process.env.PATH = prevPath;
    setReviewMode("enable", "clone", f.repo, { dataDir: f.data });
    process.env.PATH = `${bin}:${prevPath ?? ""}`;
    const none = readReviewMode(sub, { dataDir: f.data });
    assert.equal(none.effective, "on");
    assert.equal(none.cloneLocal, "unset");
    // a .git FILE leading nowhere cannot be located: never assumed off, the global switch decides
    const wt = join(f.plain, "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), "gitdir: /nowhere\n");
    const slow = join(f.plain, "slow");
    mkdirSync(slow);
    writeFileSync(join(slow, "git"), `#!/bin/sh\ncase "$*" in *--show-toplevel*) exec sleep 3;; esac\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${slow}:${prevPath ?? ""}`;
    const lost = readReviewMode(wt, { dataDir: f.data, gitTimeoutMs: 800 });
    assert.equal(lost.effective, "on");
    assert.equal(lost.cloneLocal, "n/a");
    assert.match(lost.problems.join("\n"), /could not be located/);
    // no repository at all (git says so): n/a, the global switch decides
    process.env.PATH = prevPath;
    const plain = join(f.plain, "empty");
    mkdirSync(plain);
    assert.equal(readReviewMode(plain, { dataDir: f.data }).cloneLocal, "n/a");
  } finally {
    process.env.PATH = prevPath;
    f.cleanup();
  }
});

test("git timing out: .git file parsing follows git (CRLF, absolute with spaces) and unsafe links never read as off (S3)", () => {
  const f = fx();
  const prevPath = process.env.PATH;
  try {
    setReviewMode("enable", "global", f.repo, { dataDir: f.data });
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const slow = join(f.plain, "slow");
    mkdirSync(slow);
    writeFileSync(join(slow, "git"), `#!/bin/sh\ncase "$*" in *--show-toplevel*) exec sleep 3;; esac\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    const opts = { dataDir: f.data, gitTimeoutMs: 400 };
    const root = join(f.plain, "layouts");
    mkdirSync(root);

    // the main repository's override is off
    setReviewMode("disable", "clone", f.repo, { dataDir: f.data });
    assert.equal(readReviewMode(f.repo, opts).cloneLocal, "off");

    // a second main repository whose path contains spaces, override off
    const spaced = join(root, "my main repo");
    mkdirSync(spaced);
    assert.equal(spawnSync("git", ["-C", spaced, "init", "-q", "-b", "main"], { env: ENV }).status, 0);
    setReviewMode("disable", "clone", spaced, { dataDir: f.data });
    const spacedCommon = realpathSync(join(spaced, ".git"));
    assert.match(spacedCommon, / /);

    const relative = (from: string, to: string): string => {
      const a = from.split("/").filter(Boolean);
      const b = to.split("/").filter(Boolean);
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
    };
    // a linked-worktree layout: <root>/<name> (with its .git file) and <root>/<name>-gitdir (with `setup` applied)
    const layout = (name: string, gitFile: (gitdir: string) => string, setup: (gitdir: string) => void): string => {
      const wt = join(root, name);
      const gitdir = join(root, `${name}-gitdir`);
      mkdirSync(wt);
      mkdirSync(gitdir);
      writeFileSync(join(wt, ".git"), gitFile(gitdir));
      setup(gitdir);
      return wt;
    };
    const status = (wt: string): [string, string] => {
      const s = readReviewMode(wt, opts);
      return [s.effective, s.cloneLocal];
    };

    process.env.PATH = `${slow}:${prevPath ?? ""}`;
    const t0 = Date.now();

    const crlf = layout("crlf", (g) => `gitdir: ${relative(join(root, "crlf"), g)}\r\n`, (g) => writeFileSync(join(g, "commondir"), `${relative(g, f.commonDir)}\r\n`));
    assert.deepEqual(status(crlf), ["off", "off"], "CRLF .git file and commondir, relative paths");

    const withSpaces = layout("sp ace", (g) => `gitdir: ${g}\n`, (g) => writeFileSync(join(g, "commondir"), `${spacedCommon}\n`));
    assert.deepEqual(status(withSpaces), ["off", "off"], "absolute paths containing spaces");

    const viaLink = layout("link", (g) => `gitdir: ${g}\n`, (g) => symlinkSync(f.commonDir, join(g, "commondir")));
    assert.deepEqual(status(viaLink), ["on", "n/a"], "a symlinked commondir is never followed nor read as off");

    const viaFifo = layout("fifo", (g) => `gitdir: ${g}\n`, (g) => assert.equal(spawnSync("mkfifo", [join(g, "commondir")]).status, 0));
    assert.deepEqual(status(viaFifo), ["on", "n/a"], "a FIFO commondir neither blocks nor reads as off");

    assert.ok(Date.now() - t0 < 3000, "never waits for the slow git");
  } finally {
    process.env.PATH = prevPath;
    f.cleanup();
  }
});

test("dubious-ownership classifier: a warning line is not the fatal line (S3)", () => {
  const f = fx();
  const prevPath = process.env.PATH;
  try {
    const bin = join(f.plain, "bin");
    mkdirSync(bin);
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in *--show-toplevel*) printf '%s\\n' "warning: detected dubious ownership in repository at 'x'" "	git config --global --add safe.directory x" >&2; exit 128;; esac\nexec ${realGit} "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${prevPath ?? ""}`;
    assert.throws(
      () => resolveRepository(f.repo, { gitTimeoutMs: 800 }),
      (err: unknown) => err instanceof SnapshotError && err.code === "not_a_repository",
    );
  } finally {
    process.env.PATH = prevPath;
    f.cleanup();
  }
});
