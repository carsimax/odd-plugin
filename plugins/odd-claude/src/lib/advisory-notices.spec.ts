// S4a/S4b advisory notices of the PreToolUse hook, driven through the public hook entries (runHook and runHookLazy).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../hooks/run.js";
import { runHookLazy } from "../hooks/lazy.js";
import { writeDelegationMode } from "./context.js";

const FORBIDDEN_KEYS = ["decision", "continue", "stopReason", "permissionDecision", "reason"];

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "odd-advisory-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const pre = (dir: string, input: Record<string, unknown>) => runHook("PreToolUse", JSON.stringify({ session_id: "s1", cwd: dir, ...input }), { dataDir: dir, env: {} });
const preLazy = (dir: string, input: Record<string, unknown>) => runHookLazy("PreToolUse", JSON.stringify({ session_id: "s1", cwd: dir, ...input }), { dataDir: dir, env: {} });
const edit = (tool_name = "Edit", extra: Record<string, unknown> = {}) => ({ tool_name, tool_input: { file_path: "/x" }, ...extra });
const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: "Bash", tool_input: { command }, ...extra });

function advisory(r: { exitCode: number; stdout: string }): string {
  assert.equal(r.exitCode, 0);
  const out = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
  const h = out.hookSpecificOutput as Record<string, unknown>;
  assert.deepEqual(Object.keys(h).sort(), ["additionalContext", "hookEventName"]);
  assert.equal(h.hookEventName, "PreToolUse");
  for (const k of FORBIDDEN_KEYS) assert.equal(Object.hasOwn(out, k), false, k);
  return h.additionalContext as string;
}
const silent = { exitCode: 0, stdout: "" };

test("S4a: a main-thread Edit, Write or NotebookEdit with coordinator mode ON yields one delegation notice", async () => {
  await withDir(async (dir) => {
    for (const tool of ["Edit", "Write", "NotebookEdit"]) {
      const text = advisory(pre(dir, edit(tool)));
      assert.match(text, /Coordinator mode is ON/);
      assert.match(text, /odd-worker/);
      assert.equal(advisory(await preLazy(dir, edit(tool))), text, `${tool}: lazy path matches`);
    }
  });
});

test("S13: agent_type alone (session started with --agent) is the main thread, not a subagent", async () => {
  await withDir(async (dir) => {
    assert.match(advisory(pre(dir, edit("Edit", { agent_type: "odd-worker" }))), /odd-worker/);
  });
});

test("S4a: silent with coordinator mode OFF, from a subagent, for other tools, and for non-object input", async () => {
  await withDir(async (dir) => {
    for (const extra of [{ agent_id: "a1" }, { agent_id: "a1", agent_type: "odd-worker" }]) {
      assert.deepEqual(pre(dir, edit("Edit", extra)), silent);
      assert.deepEqual(await preLazy(dir, edit("Edit", extra)), silent);
    }
    for (const tool of ["Read", "Agent", "edit", ""]) assert.deepEqual(pre(dir, edit(tool)), silent, tool);
    assert.deepEqual(runHook("PreToolUse", "null", { dataDir: dir }), silent);
    writeDelegationMode("organic", { dataDir: dir });
    assert.deepEqual(pre(dir, edit()), silent);
    assert.deepEqual(await preLazy(dir, edit()), silent);
  });
});

test("S4b: a subagent Bash with git commit, git push, gh pr create or gh pr merge yields one parent-owns-git notice", async () => {
  await withDir(async (dir) => {
    for (const cmd of ["git commit -m x", "git push origin main", "git -C /r commit -am y", "gh pr create --fill", "gh pr merge 3", "git add . && git commit -m z"]) {
      const text = advisory(pre(dir, bash(cmd, { agent_id: "a1", agent_type: "odd-worker" })));
      assert.match(text, /parent owns git/);
      assert.equal(advisory(await preLazy(dir, bash(cmd, { agent_id: "a1" }))), text, cmd);
    }
  });
});

test("S4b: silent for the main thread, and for other subagent commands", async () => {
  await withDir(async (dir) => {
    for (const cmd of ["git commit -m x", "git push origin main", "gh pr merge 3"]) {
      assert.deepEqual(pre(dir, bash(cmd)), silent, cmd);
      assert.deepEqual(await preLazy(dir, bash(cmd)), silent, cmd);
    }
    for (const cmd of ["git status", "git diff", "npm test", "gh pr view 3"]) {
      assert.deepEqual(pre(dir, bash(cmd, { agent_id: "a1" })), silent, cmd);
    }
  });
});

test("S4d: a malformed tool_input fails open", () => {
  withDir((dir) => {
    for (const tool_input of [null, 5, "x", [], {}, { command: 5 }]) {
      assert.deepEqual(pre(dir, { tool_name: "Bash", agent_id: "a1", tool_input }), silent);
    }
  });
});

test("PRESERVE: the Bash RDD delivery notice is unchanged (silent with RDD off, for a plain git push from the main thread)", async () => {
  await withDir(async (dir) => {
    const push = ["git", "push", "origin", "main"].join(" ");
    assert.deepEqual(pre(dir, bash(push)), silent);
    assert.deepEqual(await preLazy(dir, bash(push)), silent);
    assert.deepEqual(pre(dir, bash("ls -la")), silent);
  });
});
