import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultHandlers, runHook, type Handlers } from "./run.js";
import { writePersona } from "../lib/persona.js";
import { readSessionState } from "../lib/state.js";

const runJs = new URL("./run.js", import.meta.url).pathname;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-run-"));
}

test("dispatches by event name and serializes handler output", () => {
  const dir = tmp();
  try {
    const handlers: Handlers = { Foo: (input) => ({ echoed: input.session_id }) };
    const r = runHook("Foo", JSON.stringify({ session_id: "s1" }), { handlers, dataDir: dir });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(JSON.parse(r.stdout), { echoed: "s1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handler returning nothing writes no output", () => {
  const dir = tmp();
  try {
    const r = runHook("Foo", "{}", { handlers: { Foo: () => undefined }, dataDir: dir });
    assert.deepEqual(r, { exitCode: 0, stdout: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown event is a silent no-op", () => {
  const dir = tmp();
  try {
    const r = runHook("Nope", "{}", { handlers: {}, dataDir: dir });
    assert.deepEqual(r, { exitCode: 0, stdout: "" });
    assert.equal(existsSync(join(dir, "logs")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("throwing handler fails safe: exit 0, no output, error logged", () => {
  const dir = tmp();
  try {
    const handlers: Handlers = { Foo: () => { throw new Error("kaboom"); } };
    const r = runHook("Foo", "{}", { handlers, dataDir: dir });
    assert.deepEqual(r, { exitCode: 0, stdout: "" });
    assert.match(readFileSync(join(dir, "logs", "hooks.log"), "utf8"), /Foo.*kaboom/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid stdin JSON fails safe and is logged", () => {
  const dir = tmp();
  try {
    const r = runHook("SessionStart", "{oops", { dataDir: dir });
    assert.deepEqual(r, { exitCode: 0, stdout: "" });
    assert.match(readFileSync(join(dir, "logs", "hooks.log"), "utf8"), /SessionStart/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: SessionStart fixture records session start in state and emits context", () => {
  const dir = tmp();
  try {
    const r = spawnSync(process.execPath, [runJs, "SessionStart"], {
      input: JSON.stringify({ session_id: "sess-1", hook_event_name: "SessionStart", source: "startup" }),
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(out.hookSpecificOutput.additionalContext, /Persona mode: mentor/);
    const state = readSessionState("sess-1", { dataDir: dir });
    assert.equal(typeof state.startedAt, "string");
    assert.equal(state.source, "startup");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: unknown event and missing data dir exit 0", () => {
  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_DATA;
  const a = spawnSync(process.execPath, [runJs, "Nope"], { input: "{}", env, encoding: "utf8" });
  assert.equal(a.status, 0);
  assert.equal(a.stdout, "");
  const b = spawnSync(process.execPath, [runJs, "SessionStart"], { input: '{"session_id":"x"}', env, encoding: "utf8" });
  assert.equal(b.status, 0);
  // no data dir: state is skipped, the context still goes out with the default persona
  assert.match(JSON.parse(b.stdout).hookSpecificOutput.additionalContext, /Persona mode: mentor/);
});

test("SessionStart context follows the stored persona and covers every source", () => {
  const dir = tmp();
  try {
    writePersona("neutral", { dataDir: dir });
    for (const source of ["startup", "resume", "clear", "compact", undefined]) {
      const r = runHook("SessionStart", JSON.stringify({ session_id: "s", source }), { dataDir: dir, env: { CLAUDE_PLUGIN_ROOT: "/r/odd" } });
      const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
      assert.match(ctx, /Persona mode: neutral/);
      assert.match(ctx, /\/r\/odd\/cards/);
      assert.ok(ctx.length < 10000);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("UserPromptSubmit emits a bounded language anchor for human prompts only", () => {
  const dir = tmp();
  try {
    const r = runHook("UserPromptSubmit", JSON.stringify({ session_id: "s", prompt: "hola, qué tal" }), { dataDir: dir });
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "UserPromptSubmit");
    assert.match(out.additionalContext, /"hola, qué tal"/);
    assert.deepEqual(runHook("UserPromptSubmit", JSON.stringify({ prompt: "/odd-claude:status" }), { dataDir: dir }), { exitCode: 0, stdout: "" });
    assert.deepEqual(runHook("UserPromptSubmit", "{}", { dataDir: dir }), { exitCode: 0, stdout: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no event emits a decision for a destructive Bash input (PreToolUse, Stop, SubagentStop, PostToolUse)", () => {
  const dir = tmp();
  try {
    const input = JSON.stringify({
      session_id: "s",
      tool_name: "Bash",
      tool_input: { command: "rm -rf / && git reset --hard" },
      agent_type: "odd-claude:odd-worker",
    });
    for (const event of ["PreToolUse", "Stop", "SubagentStop", "PostToolUse"]) {
      assert.deepEqual(runHook(event, input, { dataDir: dir }), { exitCode: 0, stdout: "" }, event);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hooks.json registers exactly the default handlers via the run.js dispatcher", () => {
  const raw = JSON.parse(readFileSync(new URL("../../hooks/hooks.json", import.meta.url), "utf8")) as {
    hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
  };
  assert.deepEqual(Object.keys(raw.hooks).sort(), Object.keys(defaultHandlers).sort());
  for (const [event, groups] of Object.entries(raw.hooks)) {
    const cmds = groups.flatMap((g) => g.hooks.map((h) => h.command));
    assert.deepEqual(cmds, [`node "\${CLAUDE_PLUGIN_ROOT}/dist/hooks/run.js" ${event}`]);
  }
  assert.ok(!JSON.stringify(raw).includes("prompt.compose"));
});
