import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultHandlers, runHook } from "./run.js";
import { lazyHandlers, runHookLazy } from "./lazy.js";
import { setReviewMode } from "../review/mode.js";

const cwd = tmpdir();
const base = { session_id: "s1", cwd };
const inputs: [string, object][] = [
  ["SessionStart", { ...base, source: "startup" }],
  ["UserPromptSubmit", { ...base, prompt: "hola, qué tal" }],
  ["UserPromptSubmit", { ...base, prompt: "/odd-claude:status" }],
  ["PreToolUse", { ...base, tool_name: "Bash", tool_input: { command: "ls -la" } }],
  ["PreToolUse", { ...base, tool_name: "Bash", tool_input: { command: "git push origin main" } }],
  ["PreToolUse", { ...base, tool_name: "Read", tool_input: {} }],
  ["PostToolUse", { ...base, tool_name: "Read", tool_input: { file_path: "/x" } }],
  ["Stop", { ...base, stop_hook_active: false }],
  ["Stop", { session_id: "s1" }],
  ["StopFailure", { ...base }],
  ["SubagentStart", { ...base, agent_id: "a1", agent_type: "odd-worker" }],
  ["SubagentStop", { ...base, agent_id: "a1" }],
  ["SessionEnd", { ...base }],
];

test("lazy registry registers exactly the events of the eager registry and hooks.json", () => {
  const raw = JSON.parse(readFileSync(new URL("../../hooks/hooks.json", import.meta.url), "utf8")) as { hooks: Record<string, unknown> };
  assert.deepEqual(Object.keys(lazyHandlers).sort(), Object.keys(defaultHandlers).sort());
  assert.deepEqual(Object.keys(lazyHandlers).sort(), Object.keys(raw.hooks).sort());
});

for (const global of [false, true]) {
  test(`runHookLazy answers byte for byte like runHook (global RDD ${global ? "on" : "off"})`, async () => {
    for (const [event, input] of inputs) {
      const a = mkdtempSync(join(tmpdir(), "odd-lazy-a-"));
      const b = mkdtempSync(join(tmpdir(), "odd-lazy-b-"));
      try {
        if (global) for (const d of [a, b]) setReviewMode("enable", "global", cwd, { dataDir: d });
        const env = { CLAUDE_PLUGIN_ROOT: "/r/odd" };
        const eager = runHook(event, JSON.stringify(input), { dataDir: a, env });
        const lazy = await runHookLazy(event, JSON.stringify(input), { dataDir: b, env });
        // The only legitimate difference is each run's own data dir (SessionStart prints the scratch path under it).
        assert.deepEqual({ ...lazy, stdout: lazy.stdout.replaceAll(b, "<data>") }, { ...eager, stdout: eager.stdout.replaceAll(a, "<data>") }, `${event} ${JSON.stringify(input)}`);
      } finally {
        rmSync(a, { recursive: true, force: true });
        rmSync(b, { recursive: true, force: true });
      }
    }
  });
}

test("runHookLazy fails safe: unknown event, empty stdin and invalid JSON are silent with exit 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-lazy-"));
  try {
    assert.deepEqual(await runHookLazy("Nope", "{}", { dataDir: dir }), { exitCode: 0, stdout: "" });
    assert.deepEqual(await runHookLazy("toString", "{}", { dataDir: dir }), { exitCode: 0, stdout: "" });
    assert.deepEqual(await runHookLazy("PreToolUse", "", { dataDir: dir }), { exitCode: 0, stdout: "" });
    assert.deepEqual(await runHookLazy("PreToolUse", "not json", { dataDir: dir }), { exitCode: 0, stdout: "" });
    assert.deepEqual(await runHookLazy("SessionStart", "{oops", { dataDir: dir }), { exitCode: 0, stdout: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
