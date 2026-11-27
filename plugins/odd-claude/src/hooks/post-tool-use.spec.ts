import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "./run.js";
import { writeDelegationMode } from "../lib/context.js";
import { readSessionState } from "../lib/state.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-post-"));
}

function post(dir: string, input: Record<string, unknown>, env: Record<string, string | undefined> = {}) {
  return runHook("PostToolUse", JSON.stringify({ session_id: "s1", hook_event_name: "PostToolUse", ...input }), { dataDir: dir, env });
}

const read = (extra: Record<string, unknown> = {}) => ({ tool_name: "Read", tool_input: { file_path: "/x" }, tool_response: "small", ...extra });
const ctxOf = (r: { stdout: string }): string => JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

test("counter increments per exploration call and stays silent up to 3 small lookups", () => {
  const dir = tmp();
  try {
    for (let i = 1; i <= 3; i++) {
      assert.deepEqual(post(dir, read()), { exitCode: 0, stdout: "" });
      assert.equal((readSessionState("s1", { dataDir: dir }).exploration as { lookups: number }).lookups, i);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("4th lookup emits one PostToolUse additionalContext notice, then stays silent in the turn", () => {
  const dir = tmp();
  try {
    for (let i = 0; i < 3; i++) post(dir, read());
    const r = post(dir, read());
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
    assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(out.hookSpecificOutput.additionalContext, /Exploration budget: 4 tracked lookups/);
    assert.match(out.hookSpecificOutput.additionalContext, /parallel odd-explore subagents/);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /odd-claude:/);
    assert.deepEqual(post(dir, read()), { exitCode: 0, stdout: "" });
    assert.deepEqual(post(dir, read()), { exitCode: 0, stdout: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bytes threshold (>40000) fires on a single big result", () => {
  const dir = tmp();
  try {
    assert.deepEqual(post(dir, read({ tool_response: { file: { content: "a".repeat(40_000) } } })), { exitCode: 0, stdout: "" });
    const r = post(dir, read({ tool_response: [{ type: "text", text: "é".repeat(10) }] }));
    assert.match(ctxOf(r), /Exploration budget: 2 tracked lookups and 40,020 UTF-8 text bytes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("UserPromptSubmit resets the counters so the notice can fire again next turn", () => {
  const dir = tmp();
  try {
    for (let i = 0; i < 4; i++) post(dir, read());
    runHook("UserPromptSubmit", JSON.stringify({ session_id: "s1", prompt: "/odd-status" }), { dataDir: dir });
    assert.deepEqual(readSessionState("s1", { dataDir: dir }).exploration, { lookups: 0, bytes: 0, notified: false });
    for (let i = 0; i < 3; i++) assert.equal(post(dir, read()).stdout, "");
    assert.match(ctxOf(post(dir, read())), /Exploration budget/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tracks Read/Grep/Glob/WebFetch/WebSearch and the global codegraph MCP name; ignores other tools", () => {
  const dir = tmp();
  try {
    const names = ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "mcp__codegraph__codegraph_explore"];
    for (const tool_name of names) post(dir, { tool_name, tool_response: "x" });
    for (const tool_name of ["Bash", "Edit", "Agent", "mcp__other__thing", "mcp__codegraphx__a", "mcp__plugin_odd-claude_codegraph__codegraph_query"]) post(dir, { tool_name, tool_response: "x" });
    assert.equal((readSessionState("s1", { dataDir: dir }).exploration as { lookups: number }).lookups, names.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main thread only: agent_id calls neither count nor notify; agent_type alone is the main thread", () => {
  const dir = tmp();
  try {
    for (let i = 0; i < 6; i++) assert.equal(post(dir, read({ agent_id: "a1", agent_type: "odd-explore" })).stdout, "");
    assert.equal(readSessionState("s1", { dataDir: dir }).exploration, undefined);
    post(dir, read({ agent_type: "odd-explore" }));
    assert.equal((readSessionState("s1", { dataDir: dir }).exploration as { lookups: number }).lookups, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coordinator OFF (organic) emits no exploration notice", () => {
  const dir = tmp();
  try {
    writeDelegationMode("organic", { dataDir: dir });
    for (let i = 0; i < 8; i++) assert.equal(post(dir, read()).stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed or incomplete input yields no output and exit 0", () => {
  const dir = tmp();
  try {
    for (const stdin of ["{oops", "", "[]", "null", '{"session_id":"s1"}', '{"tool_name":"Read"}', '{"session_id":"s1","tool_name":5}']) {
      assert.deepEqual(runHook("PostToolUse", stdin, { dataDir: dir }), { exitCode: 0, stdout: "" });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function transcript(dir: string, lines: unknown[], name = "t.jsonl"): string {
  const p = join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}
const usageLine = (n: number) => ({ type: "assistant", message: { usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: n - 2, output_tokens: 5 } } });

test("context backstop: real usage from the transcript past 150k emits one advisory per session", () => {
  const dir = tmp();
  try {
    const t = transcript(dir, [usageLine(10_000), usageLine(160_000)]);
    const r = post(dir, { tool_name: "Bash", tool_response: "x", transcript_path: t });
    assert.match(ctxOf(r), /Context backstop: .*160,000 tokens.*150,000-token backstop.*delegate the next bounded unit/);
    assert.equal(post(dir, { tool_name: "Bash", tool_response: "x", transcript_path: t }).stdout, "");
    assert.equal(post(dir, read({ transcript_path: t })).stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("context backstop: below threshold is silent and re-arms after a drop (compaction)", () => {
  const dir = tmp();
  try {
    const hi = transcript(dir, [usageLine(160_000)]);
    assert.match(post(dir, { tool_name: "Bash", transcript_path: hi }).stdout, /Context backstop/);
    const lo = transcript(dir, [usageLine(160_000), usageLine(20_000)], "lo.jsonl");
    assert.equal(post(dir, { tool_name: "Bash", transcript_path: lo }).stdout, "");
    assert.match(post(dir, { tool_name: "Bash", transcript_path: hi }).stdout, /Context backstop/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("context backstop: threshold is overridable by env, missing transcript is silent", () => {
  const dir = tmp();
  try {
    const t = transcript(dir, [usageLine(5_000)]);
    assert.equal(post(dir, { tool_name: "Bash", transcript_path: t }).stdout, "");
    assert.match(ctxOf(post(dir, { tool_name: "Bash", transcript_path: t }, { ODD_CLAUDE_CONTEXT_BACKSTOP_TOKENS: "1000" })), /5,000 tokens/);
    assert.equal(post(tmp(), { tool_name: "Bash", transcript_path: join(dir, "nope.jsonl") }).stdout, "");
    assert.equal(post(dir, { tool_name: "Bash", transcript_path: 5 }).stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("context backstop: without usage lines nothing is estimated and nothing fires", () => {
  const dir = tmp();
  try {
    const p = join(dir, "big.jsonl");
    writeFileSync(p, '{"type":"user","message":"' + "a".repeat(700_000) + '"}\n');
    assert.equal(post(dir, { tool_name: "Bash", transcript_path: p }).stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backstop and exploration notices combine in one additionalContext; organic mode keeps only the backstop", () => {
  const dir = tmp();
  try {
    const t = transcript(dir, [usageLine(200_000)]);
    for (let i = 0; i < 3; i++) post(dir, read());
    const both = ctxOf(post(dir, read({ transcript_path: t })));
    assert.match(both, /Exploration budget/);
    assert.match(both, /Context backstop/);
    const d2 = tmp();
    try {
      writeDelegationMode("organic", { dataDir: d2 });
      const only = ctxOf(post(d2, read({ transcript_path: t })));
      assert.doesNotMatch(only, /Exploration budget/);
      assert.match(only, /single small edits and state checks stay inline/);
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backstop reads only the transcript tail: an old usage line is not used", () => {
  const dir = tmp();
  try {
    const p = join(dir, "big.jsonl");
    writeFileSync(p, JSON.stringify(usageLine(999_999)) + "\n" + "p".repeat(640_000) + "\n");
    assert.equal(post(dir, { tool_name: "Bash", tool_response: "x", transcript_path: p }).stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backstop never leaks transcript content into the notice", () => {
  const dir = tmp();
  try {
    const t = transcript(dir, [
      { type: "user", message: { role: "user", content: "SECRET_X" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "SECRET_X" }], usage: usageLine(160_000).message.usage } },
    ]);
    const r = post(dir, { tool_name: "Bash", tool_response: "x", transcript_path: t });
    assert.match(ctxOf(r), /Context backstop/);
    assert.ok(!r.stdout.includes("SECRET_X"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

