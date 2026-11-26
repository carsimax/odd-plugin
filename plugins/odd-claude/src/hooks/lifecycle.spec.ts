import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "./run.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-life-"));
}
const run = (event: string, input: object, dir: string) => runHook(event, JSON.stringify(input), { dataDir: dir, env: { CLAUDE_PLUGIN_ROOT: "/r/odd" } });
const status = (dir: string, s: string) => JSON.parse(readFileSync(join(dir, "status", `${s}.json`), "utf8"));

test("SessionStart creates the scratch, injects its path, sets the title and writes the status", () => {
  const dir = tmp();
  try {
    const r = run("SessionStart", { session_id: "s1", cwd: "/work/my-proj", source: "startup" }, dir);
    const out = JSON.parse(r.stdout);
    const scratch = join(dir, "scratch", "s1");
    assert.ok(existsSync(scratch));
    assert.ok((out.hookSpecificOutput.additionalContext as string).includes(scratch));
    assert.equal(out.terminalSequence, "\u001b]0;odd-claude · my-proj\u0007");
    assert.equal(status(dir, "s1").state, "idle");
    assert.equal(status(dir, "s1").cwd, "/work/my-proj");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStart sweeps stale tombstones in the scratch root and keeps fresh ones", () => {
  const dir = tmp();
  try {
    const root = join(dir, "scratch");
    mkdirSync(root, { recursive: true });
    const stale = join(root, ".rm-1-1000-old");
    const fresh = join(root, `.rm-1-${Date.now()}-new`);
    mkdirSync(stale);
    mkdirSync(fresh);
    run("SessionStart", { session_id: "s1", cwd: "/w/p", source: "startup" }, dir);
    assert.equal(existsSync(stale), false);
    assert.ok(existsSync(fresh));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStart without a data dir env or session id still injects the context (home default)", () => {
  const home = tmp();
  try {
    const r = runHook("SessionStart", JSON.stringify({ cwd: "/w/p" }), { env: { CLAUDE_PLUGIN_ROOT: "/r/odd", ODD_CLAUDE_HOME: home, ODD_CLAUDE_NO_SKILL_REGISTRY: "1", ODD_CLAUDE_NO_CODEGRAPH_WARMUP: "1" } });
    const out = JSON.parse(r.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /Coordinator mode: ON/);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /Session scratch/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("UserPromptSubmit marks the status working and keeps the language anchor", () => {
  const dir = tmp();
  try {
    const r = run("UserPromptSubmit", { session_id: "s1", cwd: "/w/p", prompt: "hola, qué tal" }, dir);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /"hola, qué tal"/);
    assert.equal(status(dir, "s1").state, "working");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stop writes idle and its output is always empty", () => {
  const dir = tmp();
  try {
    assert.deepEqual(run("Stop", { session_id: "s1", cwd: "/w/p", stop_hook_active: false }, dir), { exitCode: 0, stdout: "" });
    assert.equal(status(dir, "s1").state, "idle");
    assert.deepEqual(run("Stop", {}, dir), { exitCode: 0, stdout: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionEnd removes only its scratch, marks ended, clears the title and prints the resume hint", () => {
  const dir = tmp();
  try {
    run("SessionStart", { session_id: "s1", cwd: "/w/p" }, dir);
    run("SessionStart", { session_id: "s2", cwd: "/w/q" }, dir);
    const r = run("SessionEnd", { session_id: "s1", cwd: "/w/p", reason: "prompt_input_exit" }, dir);
    assert.equal(existsSync(join(dir, "scratch", "s1")), false);
    assert.ok(existsSync(join(dir, "scratch", "s2")));
    assert.equal(status(dir, "s1").state, "ended");
    const out = JSON.parse(r.stdout);
    assert.equal(out.terminalSequence, "\u001b]0;\u0007");
    assert.match(out.systemMessage, /claude --resume s1/);
    assert.deepEqual(Object.keys(out).sort(), ["systemMessage", "terminalSequence"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionEnd for /clear prints no resume hint but still cleans up", () => {
  const dir = tmp();
  try {
    run("SessionStart", { session_id: "s1" }, dir);
    const out = JSON.parse(run("SessionEnd", { session_id: "s1", reason: "clear" }, dir).stdout);
    assert.equal(out.systemMessage, undefined);
    assert.equal(existsSync(join(dir, "scratch", "s1")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StopFailure is silent, logs the classification and arms one advisory for the next prompt", () => {
  const dir = tmp();
  try {
    const r = run("StopFailure", { session_id: "s1", error: "rate_limit", error_details: "429" }, dir);
    assert.deepEqual(r, { exitCode: 0, stdout: "" });
    assert.match(readFileSync(join(dir, "logs", "hooks.log"), "utf8"), /StopFailure: rate_limit/);
    const p = JSON.parse(run("UserPromptSubmit", { session_id: "s1", prompt: "sigue" }, dir).stdout).hookSpecificOutput.additionalContext as string;
    assert.match(p, /--fallback-model/);
    const again = JSON.parse(run("UserPromptSubmit", { session_id: "s1", prompt: "sigue" }, dir).stdout).hookSpecificOutput.additionalContext as string;
    assert.doesNotMatch(again, /--fallback-model/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StopFailure for a non-recoverable error arms nothing", () => {
  const dir = tmp();
  try {
    run("StopFailure", { session_id: "s1", error: "invalid_request" }, dir);
    const out = run("UserPromptSubmit", { session_id: "s1", prompt: "sigue" }, dir).stdout;
    assert.doesNotMatch(out, /fallback-model/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook failures never produce output or a non-zero exit", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "status"), "not a dir");
    for (const e of ["Stop", "StopFailure", "SessionEnd"]) {
      const r = run(e, { session_id: "s1" }, dir);
      assert.equal(r.exitCode, 0);
      assert.doesNotMatch(r.stdout, /block|continue/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
