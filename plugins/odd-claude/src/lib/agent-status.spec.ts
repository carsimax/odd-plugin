import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStatusPath, writeAgentStatus } from "./agent-status.js";
import { titleSequence, CLEAR_TITLE } from "./terminal.js";

test("writes <data>/status/<session>.json atomically with state, cwd and updatedAt", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-status-"));
  try {
    writeAgentStatus("s1", "working", "/work/p", { dataDir: dir });
    const p = agentStatusPath("s1", { dataDir: dir });
    assert.equal(p, join(dir, "status", "s1.json"));
    const j = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(j.state, "working");
    assert.equal(j.cwd, "/work/p");
    assert.equal(j.session, "s1");
    assert.ok(!Number.isNaN(Date.parse(j.updatedAt)));
    assert.equal(lstatSync(p).mode & 0o077, 0);
    writeAgentStatus("s1", "idle", "/work/p", { dataDir: dir });
    assert.equal(JSON.parse(readFileSync(p, "utf8")).state, "idle");
    assert.deepEqual(readdirSync(join(dir, "status")), ["s1.json"], "no temp files left");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlinked status dir is refused and nothing is written through it", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-status-"));
  const outside = mkdtempSync(join(tmpdir(), "odd-status-out-"));
  try {
    symlinkSync(outside, join(dir, "status"));
    assert.throws(() => writeAgentStatus("s", "idle", "/c", { dataDir: dir }));
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("title sequence is a plain OSC 0 with the project name, control characters stripped", () => {
  assert.equal(titleSequence("/home/u/my-proj"), "\u001b]0;odd-claude · my-proj\u0007");
  assert.equal(titleSequence(undefined), "\u001b]0;odd-claude\u0007");
  const evil = titleSequence("/x/a\u001b]52;c;AAAA\u0007b\nc");
  assert.equal(evil.slice(0, 4), "\u001b]0;");
  assert.equal(evil.slice(4).includes("\u001b"), false);
  assert.equal(evil.endsWith("\u0007"), true);
  assert.equal(evil.slice(0, -1).includes("\u0007"), false);
  assert.ok(titleSequence("/x/" + "p".repeat(500)).length < 120);
  assert.equal(CLEAR_TITLE, "\u001b]0;\u0007");
});
