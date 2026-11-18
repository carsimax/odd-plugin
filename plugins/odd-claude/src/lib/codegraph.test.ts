import { test } from "node:test";
import assert from "node:assert/strict";
import { planWarmup, runWarmup, type ExecOutcome, type WarmupDeps } from "./codegraph.js";

function deps(over: Partial<WarmupDeps> & { exec?: WarmupDeps["exec"] } = {}): WarmupDeps & { calls: string[][]; logs: string[] } {
  const calls: string[][] = [];
  const logs: string[] = [];
  return {
    env: {},
    hasIndex: () => true,
    isTrusted: () => true,
    isBroadDir: () => false,
    exec: (cmd, args): ExecOutcome => { calls.push([cmd, ...args]); return { kind: "ok" }; },
    log: (m) => logs.push(m),
    timeoutMs: 1000,
    ...over,
    calls,
    logs,
  };
}

test("plan: sync when already initialized; skip when not initialized without opt-in", () => {
  assert.deepEqual(planWarmup("/p", deps()), { action: "sync", reason: "indexed" });
  assert.deepEqual(planWarmup("/p", deps({ hasIndex: () => false })), { action: "skip", reason: "not-initialized" });
});

test("plan: init only with the explicit opt-in env and an unindexed project", () => {
  const d = deps({ hasIndex: () => false, env: { ODD_CLAUDE_CODEGRAPH_INIT: "1" } });
  assert.deepEqual(planWarmup("/p", d), { action: "init", reason: "opt-in" });
  assert.equal(planWarmup("/p", { ...d, hasIndex: () => true }).action, "sync");
});

test("plan: opt-out env and home/broad directories always skip, even with init opt-in", () => {
  assert.deepEqual(planWarmup("/p", deps({ env: { ODD_CLAUDE_NO_CODEGRAPH_WARMUP: "1" } })), { action: "skip", reason: "opt-out" });
  const d = deps({ hasIndex: () => false, isBroadDir: () => true, env: { ODD_CLAUDE_CODEGRAPH_INIT: "1" } });
  assert.deepEqual(planWarmup("/p", d), { action: "skip", reason: "home-or-broad-directory" });
});

test("run: skip never executes anything", () => {
  const d = deps({ hasIndex: () => false });
  assert.deepEqual(runWarmup("/p", d), { outcome: "skipped", action: "skip", reason: "not-initialized" });
  assert.equal(d.calls.length, 0);
});

test("run: sync and init execute codegraph on the project path, bounded, and log the result", () => {
  const a = deps();
  assert.equal(runWarmup("/p", a).outcome, "ok");
  assert.deepEqual(a.calls, [["codegraph", "sync", "/p"]]);
  assert.match(a.logs.join("\n"), /codegraph warm-up sync ok/);
  const b = deps({ hasIndex: () => false, env: { ODD_CLAUDE_CODEGRAPH_INIT: "1" } });
  runWarmup("/p", b);
  assert.deepEqual(b.calls, [["codegraph", "init", "-y", "/p"]]);
});

test("run: missing binary, timeout, failure and a throwing exec are reported and never throw", () => {
  const cases: [ExecOutcome | "throw", string][] = [
    [{ kind: "missing" }, "missing-binary"],
    [{ kind: "timeout" }, "timeout"],
    [{ kind: "failed", detail: "exit 2" }, "failed"],
    ["throw", "failed"],
  ];
  for (const [res, expected] of cases) {
    const d = deps({ exec: () => { if (res === "throw") throw new Error("kaboom"); return res; } });
    const r = runWarmup("/p", d);
    assert.equal(r.outcome, expected);
    assert.match(d.logs.join("\n"), new RegExp(expected));
  }
});

test(".mcp.json ships a `codegraph` stdio server that runs `codegraph serve --mcp`", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = JSON.parse(readFileSync(new URL("../../.mcp.json", import.meta.url), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  assert.deepEqual(Object.keys(raw.mcpServers), ["codegraph"]);
  assert.deepEqual(raw.mcpServers.codegraph, { command: "codegraph", args: ["serve", "--mcp"] });
});

test("plan: a .codegraph index alone never warms up; trust is required (R1-001)", () => {
  assert.deepEqual(planWarmup("/p", deps({ isTrusted: () => false })), { action: "skip", reason: "untrusted" });
  // init opt-in does not bypass trust either
  const d = deps({ isTrusted: () => false, hasIndex: () => false, env: { ODD_CLAUDE_CODEGRAPH_INIT: "1" } });
  assert.deepEqual(planWarmup("/p", d), { action: "skip", reason: "untrusted" });
  const r = runWarmup("/p", deps({ isTrusted: () => false }));
  assert.equal(r.outcome, "skipped");
});
