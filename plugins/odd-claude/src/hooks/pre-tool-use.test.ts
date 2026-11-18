import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runHook, type Handlers } from "./run.js";

const runJs = new URL("./run.js", import.meta.url).pathname;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-pretool-"));
}

function bash(command: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "s",
    tool_name: "Bash",
    tool_input: { command },
    agent_id: null,
    agent_type: null,
    ...extra,
  });
}

function decisionOf(stdout: string): { decision: string; reason: string; event: string } {
  const out = JSON.parse(stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason, event: out.hookEventName };
}

test("main thread: destructive command asks with a reason, hard-deny class denies", () => {
  const dir = tmp();
  try {
    const ask = runHook("PreToolUse", bash("rm -rf ./sacrificial"), { dataDir: dir });
    assert.equal(ask.exitCode, 0);
    const a = decisionOf(ask.stdout);
    assert.deepEqual([a.event, a.decision], ["PreToolUse", "ask"]);
    assert.match(a.reason, /destructive/);
    const deny = runHook("PreToolUse", bash("git reset --hard"), { dataDir: dir });
    assert.equal(decisionOf(deny.stdout).decision, "deny");
    assert.match(decisionOf(deny.stdout).reason, /blocked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("benign Bash commands and other tools produce no output (normal permission flow)", () => {
  const dir = tmp();
  try {
    for (const command of ["ls", "git status", "npm test", "rm file.txt"]) {
      assert.deepEqual(runHook("PreToolUse", bash(command), { dataDir: dir }), { exitCode: 0, stdout: "" }, command);
    }
    const other = JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } });
    assert.deepEqual(runHook("PreToolUse", other, { dataDir: dir }), { exitCode: 0, stdout: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subagents (agent_id or agent_type) get an unoverridable deny for destructive commands", () => {
  const dir = tmp();
  try {
    const typed = runHook("PreToolUse", bash("rm -rf ./sacrificial", { agent_id: "a1", agent_type: "odd-claude:odd-worker" }), { dataDir: dir });
    const t = decisionOf(typed.stdout);
    assert.equal(t.decision, "deny");
    assert.match(t.reason, /child safety/);
    const idOnly = runHook("PreToolUse", bash("git clean -fdx", { agent_id: "a1" }), { dataDir: dir });
    assert.equal(decisionOf(idOnly.stdout).decision, "deny");
    const typeOnly = runHook("PreToolUse", bash("rm -r build", { agent_type: "odd-claude:odd-worker" }), { dataDir: dir });
    assert.equal(decisionOf(typeOnly.stdout).decision, "deny");
    assert.deepEqual(runHook("PreToolUse", bash("npm test", { agent_id: "a1", agent_type: "odd-claude:odd-worker" }), { dataDir: dir }), { exitCode: 0, stdout: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed Bash input fails safe: ask for main thread, deny for subagents", () => {
  const dir = tmp();
  try {
    for (const command of [undefined, null, 42, { cmd: "rm -rf x" }, ["rm", "-rf"]]) {
      const main = runHook("PreToolUse", bash(command), { dataDir: dir });
      assert.equal(decisionOf(main.stdout).decision, "ask", JSON.stringify(command));
      const sub = runHook("PreToolUse", bash(command, { agent_id: "a1" }), { dataDir: dir });
      assert.equal(decisionOf(sub.stdout).decision, "deny", JSON.stringify(command));
    }
    const noInput = JSON.stringify({ tool_name: "Bash" });
    assert.equal(decisionOf(runHook("PreToolUse", noInput, { dataDir: dir }).stdout).decision, "ask");
    const nullInput = JSON.stringify({ tool_name: "Bash", tool_input: null, agent_id: "a" });
    assert.equal(decisionOf(runHook("PreToolUse", nullInput, { dataDir: dir }).stdout).decision, "deny");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing PreToolUse handler fails safe by caller kind and logs the error", () => {
  const dir = tmp();
  try {
    const handlers: Handlers = { PreToolUse: () => { throw new Error("kaboom"); } };
    const main = runHook("PreToolUse", bash("ls"), { handlers, dataDir: dir });
    assert.equal(main.exitCode, 0);
    assert.equal(decisionOf(main.stdout).decision, "ask");
    const sub = runHook("PreToolUse", bash("ls", { agent_id: "a1" }), { handlers, dataDir: dir });
    assert.equal(decisionOf(sub.stdout).decision, "deny");
    assert.match(readFileSync(join(dir, "logs", "hooks.log"), "utf8"), /PreToolUse.*kaboom/);
    // a throw for a tool this guard does not own stays fail-open
    const read = runHook("PreToolUse", JSON.stringify({ tool_name: "Read", tool_input: {} }), { handlers, dataDir: dir });
    assert.deepEqual(read, { exitCode: 0, stdout: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unparseable PreToolUse stdin cannot be attributed to a caller: deny", () => {
  const dir = tmp();
  try {
    const r = runHook("PreToolUse", "{oops", { dataDir: dir });
    assert.equal(r.exitCode, 0);
    assert.equal(decisionOf(r.stdout).decision, "deny");
    assert.match(readFileSync(join(dir, "logs", "hooks.log"), "utf8"), /PreToolUse/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("other events keep failing open when their handler throws", () => {
  const dir = tmp();
  try {
    const handlers: Handlers = { UserPromptSubmit: () => { throw new Error("x"); } };
    assert.deepEqual(runHook("UserPromptSubmit", "{}", { handlers, dataDir: dir }), { exitCode: 0, stdout: "" });
    assert.deepEqual(runHook("SessionStart", "{oops", { dataDir: dir }), { exitCode: 0, stdout: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: the dispatcher prints the decision JSON for a destructive Bash call and never runs it", () => {
  const dir = tmp();
  try {
    const sacrificial = join(dir, "sacrificial");
    writeFileSync(sacrificial, "keep");
    const run = (input: string) => spawnSync(process.execPath, [runJs, "PreToolUse"], {
      input, env: { ...process.env, CLAUDE_PLUGIN_DATA: dir }, encoding: "utf8", cwd: dir,
    });
    const main = run(bash("rm -rf ./sacrificial", { cwd: dir }));
    assert.equal(main.status, 0);
    assert.equal(decisionOf(main.stdout).decision, "ask");
    const sub = run(bash("rm -rf ./sacrificial", { cwd: dir, agent_id: "a1", agent_type: "odd-claude:odd-worker" }));
    assert.equal(sub.status, 0);
    assert.equal(decisionOf(sub.stdout).decision, "deny");
    assert.equal(run("{oops").status, 0);
    assert.equal(decisionOf(run("{oops").stdout).decision, "deny");
    assert.ok(existsSync(sacrificial));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hooks.json wires PreToolUse for Bash through the dispatcher with a short timeout", () => {
  const raw = JSON.parse(readFileSync(new URL("../../hooks/hooks.json", import.meta.url), "utf8")) as {
    hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]>;
  };
  const groups = raw.hooks.PreToolUse;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].matcher, "Bash");
  assert.equal(groups[0].hooks.length, 1);
  const hook = groups[0].hooks[0];
  assert.equal(hook.command, 'node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/run.js" PreToolUse');
  assert.ok(typeof hook.timeout === "number" && hook.timeout <= 10);
});
