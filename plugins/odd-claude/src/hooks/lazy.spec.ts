import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultHandlers, runHook } from "./run.js";
import { lazyHandlers, runHookLazy } from "./lazy.js";
import { setReviewMode } from "../review/mode.js";
import { preToolUse } from "./pre-tool-use.js";

const GIT_ENV = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith("GIT_")) env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
})();

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** The hook log with timestamps removed. */
const logLines = (dataDir: string): string[] => {
  const f = join(dataDir, "logs", "hooks.log");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l !== "").map((l) => l.replace(/^\S+ /, "")) : [];
};

/** Hook payloads for one project dir. Callers pass a private mkdtemp dir: SessionStart refreshes `<cwd>/.atl/skill-registry.md`, so the shared real tmpdir must never be a project cwd. */
const inputsFor = (cwd: string): [string, object][] => {
  const base = { session_id: "s1", cwd };
  return [
  ["SessionStart", { ...base, source: "startup" }],
  ["UserPromptSubmit", { ...base, prompt: "hola, qué tal" }],
  ["UserPromptSubmit", { ...base, prompt: "/odd-status" }],
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
};

test("lazy registry (the single registry) registers exactly the events of hooks.json; the eager twin follows it", () => {
  const raw = JSON.parse(readFileSync(new URL("../../hooks/hooks.json", import.meta.url), "utf8")) as { hooks: Record<string, unknown> };
  assert.deepEqual(Object.keys(lazyHandlers).sort(), Object.keys(defaultHandlers).sort());
  assert.deepEqual(Object.keys(lazyHandlers).sort(), Object.keys(raw.hooks).sort());
});

for (const global of [false, true]) {
  test(`runHookLazy answers byte for byte like runHook (global RDD ${global ? "on" : "off"})`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "odd-lazy-cwd-"));
    try {
    for (const [event, input] of inputsFor(cwd)) {
      const a = mkdtempSync(join(tmpdir(), "odd-lazy-a-"));
      const b = mkdtempSync(join(tmpdir(), "odd-lazy-b-"));
      try {
        if (global) for (const d of [a, b]) setReviewMode("enable", "global", cwd, { dataDir: d });
        // SessionStart launches a detached registry refresh that writes <cwd>/.atl after the hook returns: opt out so nothing outlives the cleanup.
        const env = { CLAUDE_PLUGIN_ROOT: "/r/odd", ODD_CLAUDE_NO_SKILL_REGISTRY: "1" };
        const eager = runHook(event, JSON.stringify(input), { dataDir: a, env });
        const lazy = await runHookLazy(event, JSON.stringify(input), { dataDir: b, env });
        // The only legitimate difference is each run's own data dir (SessionStart prints the scratch path under it).
        assert.deepEqual({ ...lazy, stdout: lazy.stdout.replaceAll(b, "<data>") }, { ...eager, stdout: eager.stdout.replaceAll(a, "<data>") }, `${event} ${JSON.stringify(input)}`);
      } finally {
        rmSync(a, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        rmSync(b, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    }
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("runHookLazy matches the eager path for the delivery notice and a real Stop block (global RDD on, high-risk committed range)", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-lazy-rdd-")));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "package.json"), '{"name":"x"}\n');
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    // origin is a bare clone (no push): origin/main comes from a fetch, origin/HEAD from set-head.
    const origin = join(dir, "origin.git");
    git(dir, "clone", "-q", "--bare", repo, origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "fetch", "-q", "origin");
    git(repo, "remote", "set-head", "origin", "main");
    git(repo, "checkout", "-q", "-b", "feat");
    writeFileSync(join(repo, "package.json"), '{"name":"x","dependencies":{"left-pad":"1.0.0"}}\n');
    git(repo, "commit", "-q", "-am", "deps");

    const a = join(dir, "data-a"), b = join(dir, "data-b");
    for (const d of [a, b]) setReviewMode("enable", "global", repo, { dataDir: d });
    const env = { CLAUDE_PLUGIN_ROOT: "/r/odd" };
    const delivery = ["git", "push", "origin", "feat"].join(" ");
    const cases: [string, object, string][] = [
      ["PreToolUse", { session_id: "s1", cwd: repo, tool_name: "Bash", tool_input: { command: delivery } }, "unreviewed candidate"],
      ["Stop", { session_id: "s1", cwd: repo, stop_hook_active: false }, "block"],
    ];
    for (const [event, input, word] of cases) {
      const eager = runHook(event, JSON.stringify(input), { dataDir: a, env });
      const lazy = await runHookLazy(event, JSON.stringify(input), { dataDir: b, env });
      assert.ok(eager.stdout.includes(word), `${event}: the eager path must show ${word}: ${eager.stdout}`);
      assert.doesNotMatch(eager.stdout, /permissionDecision|deny/, event);
      assert.deepEqual({ ...lazy, stdout: lazy.stdout.replaceAll(b, "<data>") }, { ...eager, stdout: eager.stdout.replaceAll(a, "<data>") }, event);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("runHookLazy logs the same handler error as runHook for a non-object stdin with RDD off (PreToolUse, Stop)", async () => {
  for (const event of ["PreToolUse", "Stop"]) {
    for (const stdin of ["null", "5", '"x"', "[]"]) {
      const a = mkdtempSync(join(tmpdir(), "odd-lazy-a-"));
      const b = mkdtempSync(join(tmpdir(), "odd-lazy-b-"));
      try {
        const eager = runHook(event, stdin, { dataDir: a });
        const lazy = await runHookLazy(event, stdin, { dataDir: b });
        assert.deepEqual(lazy, eager, `${event} ${stdin}`);
        assert.deepEqual(logLines(b), logLines(a), `${event} ${stdin} log`);
        if (stdin === "null" && event === "PreToolUse") assert.equal(logLines(b).length, 1, "the handler error is logged");
      } finally {
        rmSync(a, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        rmSync(b, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    }
  }
});

test("PreToolUse with RDD off still answers the advisory notices; the Bash delivery notice needs RDD on", () => {
  const raw = JSON.parse(readFileSync(new URL("../../hooks/hooks.json", import.meta.url), "utf8")) as { hooks: Record<string, { matcher?: string }[]> };
  assert.deepEqual(raw.hooks.PreToolUse!.map((e) => e.matcher), ["Bash|Edit|Write|NotebookEdit"]);
  const dir = mkdtempSync(join(tmpdir(), "odd-lazy-"));
  const cwd = join(dir, "project");
  try {
    for (const tool_name of ["Read", "Agent", "mcp__x__y", "bash", ""]) {
      assert.equal(preToolUse({ session_id: "s1", cwd, tool_name, tool_input: { command: ["git", "push", "origin", "main"].join(" ") } }, { dataDir: dir }), undefined, tool_name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
