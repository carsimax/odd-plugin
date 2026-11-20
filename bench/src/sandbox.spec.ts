import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createSandbox } from "./sandbox.js";
import { runProcess } from "./process.js";

test("sandbox has its own HOME, a git repo with one commit and cleans up", async () => {
  const sb = await createSandbox();
  try {
    assert.ok(existsSync(sb.home) && existsSync(sb.repo));
    assert.notEqual(sb.home, process.env.HOME);
    assert.match(sb.git(["log", "--oneline"]).trim(), /bench: initial/);
    assert.equal(sb.env.HOME, sb.home);
  } finally {
    sb.cleanup();
  }
  assert.equal(existsSync(sb.root), false);
});

test("optional bare origin is wired as the repo's origin", async () => {
  const sb = await createSandbox({ origin: true });
  try {
    assert.ok(sb.origin && existsSync(sb.origin));
    assert.equal(sb.git(["remote", "get-url", "origin"]).trim(), sb.origin);
  } finally {
    sb.cleanup();
  }
});

test("git shim counts every forwarded invocation and keeps real git behaviour", async () => {
  const sb = await createSandbox();
  try {
    assert.equal(sb.countGit(), 0, "setup git calls are not counted");
    const a = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], { cwd: sb.repo, env: sb.env, deadlineMs: 10_000 });
    const b = await runProcess("git", ["status", "--short"], { cwd: sb.repo, env: sb.env, deadlineMs: 10_000 });
    assert.equal(a.stdout.trim(), "true");
    assert.equal(a.code, 0);
    assert.equal(b.code, 0);
    assert.equal(sb.countGit(), 2);
    const bad = await runProcess("git", ["no-such-subcommand"], { cwd: sb.repo, env: sb.env, deadlineMs: 10_000 });
    assert.notEqual(bad.code, 0, "exit code is forwarded");
    assert.equal(sb.countGit(), 3, "failed invocations count too");
  } finally {
    sb.cleanup();
  }
});

test("fake claude shim counts model runs, prints canned output and never runs a model", async () => {
  const sb = await createSandbox();
  try {
    const r = await runProcess("claude", ["-p", "hi"], { cwd: sb.repo, env: sb.env, deadlineMs: 10_000 });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /odd-bench fake claude/);
    assert.equal(sb.countModelRuns(), 1);
  } finally {
    sb.cleanup();
  }
});

test("runProcess enforces the deadline", async () => {
  const r = await runProcess(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { deadlineMs: 300 });
  assert.equal(r.timedOut, true);
});
