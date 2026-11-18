import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
