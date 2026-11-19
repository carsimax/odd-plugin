import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChanges, summarizeChanges } from "./changes.js";
import { changesCli } from "../cli/changes.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });
}

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "odd-changes-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "b.txt"), "keep\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

test("summary of a fixture repo: modified, staged, untracked, deleted, with diff stat", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(dir, "new file.txt"), "x\n");
    writeFileSync(join(dir, "staged.txt"), "s\n");
    git(dir, "add", "staged.txt");
    rmSync(join(dir, "b.txt"));
    const out = collectChanges(dir);
    const lines = out.split("\n");
    assert.equal(lines[0], "odd-claude changes · branch main");
    assert.ok(lines.includes(" M a.txt"), out);
    assert.ok(lines.includes(" D b.txt"), out);
    assert.ok(lines.includes("A  staged.txt"), out);
    assert.ok(lines.includes("?? new file.txt"), out);
    assert.match(out, /4 changed, 1 untracked/);
    assert.match(out, /a\.txt\s+\| 1 \+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clean tree, non-repo dir and a repo without commits never throw", () => {
  const dir = fixture();
  const plain = mkdtempSync(join(tmpdir(), "odd-changes-plain-"));
  const fresh = mkdtempSync(join(tmpdir(), "odd-changes-fresh-"));
  try {
    assert.equal(collectChanges(dir), "odd-claude changes · branch main\nWorking tree clean.");
    assert.equal(collectChanges(plain), "Not a git repository; no changes to summarize.");
    assert.equal(collectChanges(join(plain, "missing")), "Not a git repository; no changes to summarize.");
    git(fresh, "init", "-q", "-b", "main");
    writeFileSync(join(fresh, "u.txt"), "u\n");
    assert.match(collectChanges(fresh), /\?\? u\.txt/);
  } finally {
    for (const d of [dir, plain, fresh]) rmSync(d, { recursive: true, force: true });
  }
});

test("renames, long lists and hostile file names are rendered safely and capped", () => {
  const raw = ["## main...origin/main [ahead 1]", "R  new.txt", "old.txt", ` M evil\u001b]0;pwn\u0007‮.txt`, ...Array.from({ length: 80 }, (_, i) => `?? f${i}.txt`)].join("\0") + "\0";
  const out = summarizeChanges(raw, " 1 file changed, 1 insertion(+)\n");
  assert.ok(out.includes("R  old.txt -> new.txt"), out);
  assert.doesNotMatch(out, /[\u001b\u0007‮]/);
  assert.match(out, /… and \d+ more/);
  assert.match(out, /82 changed, 80 untracked/);
  assert.ok(out.split("\n").length < 70);
});

test("the CLI prints the summary for --cwd and for the process cwd; garbage args never throw", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const r = changesCli(["--cwd", dir]);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, / M a\.txt/);
    assert.equal(changesCli(["--cwd", join(dir, "nope")]).stdout, "Not a git repository; no changes to summarize.");
    assert.equal(changesCli(["--bogus"]).exitCode, 0);
    mkdirSync(join(dir, "sub"));
    assert.match(changesCli(["--cwd", join(dir, "sub")]).stdout, / M a\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function withPath<T>(path: string, fn: () => T): T {
  const old = process.env.PATH;
  process.env.PATH = path;
  try {
    return fn();
  } finally {
    process.env.PATH = old;
  }
}

test("a git that ignores SIGTERM is killed at the timeout and reported as a timeout", () => {
  const bin = mkdtempSync(join(tmpdir(), "odd-changes-bin-"));
  const dir = mkdtempSync(join(tmpdir(), "odd-changes-hang-"));
  try {
    writeFileSync(join(bin, "git"), "#!/bin/sh\ntrap '' TERM\nexec sleep 30\n");
    chmodSync(join(bin, "git"), 0o755);
    const t0 = Date.now();
    const out = withPath(`${bin}:/usr/bin:/bin`, () => collectChanges(dir, { timeoutMs: 300 }));
    assert.equal(out, "git timed out; changes unavailable.");
    assert.ok(Date.now() - t0 < 5000, "SIGKILL must end the hung git quickly");
  } finally {
    for (const d of [bin, dir]) rmSync(d, { recursive: true, force: true });
  }
});

test("a missing git binary is reported as such, not as a non-repository", () => {
  const empty = mkdtempSync(join(tmpdir(), "odd-changes-nogit-"));
  const dir = mkdtempSync(join(tmpdir(), "odd-changes-dir-"));
  try {
    assert.equal(withPath(empty, () => collectChanges(dir)), "git not found; changes unavailable.");
    assert.equal(collectChanges(dir), "Not a git repository; no changes to summarize.");
  } finally {
    for (const d of [empty, dir]) rmSync(d, { recursive: true, force: true });
  }
});

function fakeGit(script: string, fn: (dir: string) => void): void {
  const bin = mkdtempSync(join(tmpdir(), "odd-changes-fake-"));
  const dir = mkdtempSync(join(tmpdir(), "odd-changes-cwd-"));
  try {
    writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, "git"), 0o755);
    withPath(`${bin}:/usr/bin:/bin`, () => fn(dir));
  } finally {
    for (const d of [bin, dir]) rmSync(d, { recursive: true, force: true });
  }
}

test("a git that exits non-zero for another reason is reported as failed, not as a non-repository", () => {
  fakeGit('echo "fatal: boom" >&2\nexit 1', (dir) => {
    assert.equal(collectChanges(dir), "git failed; changes unavailable.");
    assert.equal(changesCli(["--cwd", dir]).stdout, "git failed; changes unavailable.");
  });
});

test("git stderr 'not a git repository' is reported as a non-repository", () => {
  fakeGit('echo "fatal: not a git repository (or any of the parent directories): .git" >&2\nexit 128', (dir) => {
    assert.equal(collectChanges(dir), "Not a git repository; no changes to summarize.");
  });
});

test("a non-English git locale in the environment still classifies a non-repo directory", () => {
  const bin = mkdtempSync(join(tmpdir(), "odd-changes-loc-"));
  const plain = mkdtempSync(join(tmpdir(), "odd-changes-locd-"));
  const keep = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, LANGUAGE: process.env.LANGUAGE };
  try {
    // fake git: Spanish message unless the runner forces the C locale
    writeFileSync(join(bin, "git"), '#!/bin/sh\nif [ "$LC_ALL" = C ] && [ "$LANG" = C ] && [ -z "$LANGUAGE" ]; then echo "fatal: not a git repository (or any of the parent directories): .git" >&2; else echo "fatal: no es un repositorio git (ni ninguno de los directorios superiores): .git" >&2; fi\nexit 128\n');
    chmodSync(join(bin, "git"), 0o755);
    process.env.LC_ALL = "es_ES.UTF-8";
    process.env.LANG = "es_ES.UTF-8";
    process.env.LANGUAGE = "es";
    const out = withPath(`${bin}:${process.env.PATH}`, () => collectChanges(plain));
    assert.equal(out, "Not a git repository; no changes to summarize.");
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of [bin, plain]) rmSync(d, { recursive: true, force: true });
  }
});
