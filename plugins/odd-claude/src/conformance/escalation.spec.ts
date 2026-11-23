// S4 (refine-v5): the agent escalation is removed; the tier and the review-due decision come from assess alone. Everything goes
// through the public interface: the review MCP tools (ReviewServer) and the hooks (runHook), over a real temp repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../hooks/run.js";
import { ReviewServer, type Response } from "../mcp/review-server.js";
import { TOOLS, type ToolDeps } from "../mcp/tools.js";
import { setReviewMode } from "../review/mode.js";
import { UNREVIEWED_DELIVERY_NOTICE } from "../review/gate.js";

const ENV = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith("GIT_")) env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
})();

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

interface Fx {
  dir: string;
  repo: string;
  data: string;
  commonDir: string;
  cleanup: () => void;
}

/** A repository with one commit and a LOW-risk workspace change (README only) or a HIGH-risk one (package.json dependency). */
function fx(dirty: "low" | "high" = "low"): Fx {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-no-escalation-")));
  const repo = join(dir, "repo");
  const data = join(dir, "data");
  mkdirSync(repo);
  mkdirSync(data);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(repo, "README.md"), "# t\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  if (dirty === "low") writeFileSync(join(repo, "README.md"), "# t\n\nmore docs\n");
  else writeFileSync(join(repo, "package.json"), '{"name":"x","dependencies":{"left-pad":"1.0.0"}}\n');
  return { dir, repo, data, commonDir: realpathSync(join(repo, ".git")), cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

interface Called {
  isError: boolean;
  body: any;
}

function server(f: Fx): (name: string, args?: Record<string, unknown>) => Promise<Called> {
  const deps: ToolDeps = { modeOptions: { dataDir: f.data } };
  const s = new ReviewServer({ deps, cwd: f.repo });
  let id = 0;
  return async (name, args = {}) => {
    const res = (await s.handle({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })) as Response;
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    const result = res.result as { content: { text: string }[]; isError?: boolean };
    return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) };
  };
}

const on = (f: Fx): void => void setReviewMode("enable", "global", f.repo, { dataDir: f.data });
const stop = (f: Fx, session = "s1"): { exitCode: number; stdout: string } =>
  runHook("Stop", JSON.stringify({ session_id: session, cwd: f.repo, stop_hook_active: false }), { dataDir: f.data });
const push = (f: Fx): { exitCode: number; stdout: string } =>
  runHook("PreToolUse", JSON.stringify({ session_id: "s1", cwd: f.repo, tool_name: "Bash", tool_input: { command: "git push" } }), { dataDir: f.data });
const SILENT = { exitCode: 0, stdout: "" };
const ESC = { item: 3, reason: "touches the dependency policy" };
const STORE = (f: Fx): string => join(f.commonDir, "odd-plugin", "review-escalations.json");

test("no review tool declares or accepts an escalate argument", async () => {
  for (const t of TOOLS) assert.equal(Object.keys(t.inputSchema.properties ?? {}).includes("escalate"), false, t.name);
  assert.doesNotMatch(JSON.stringify(TOOLS), /agent escalation|review-escalations/i);
  const f = fx();
  try {
    on(f);
    const call = server(f);
    for (const tool of ["review_assess", "review_start", "review_run"]) {
      const r = await call(tool, { escalate: ESC });
      assert.equal(r.isError, true, tool);
      assert.equal(r.body.error.code, "invalid_input", tool);
    }
    assert.equal(existsSync(join(f.commonDir, "odd-plugin")), false, "nothing was written");
  } finally {
    f.cleanup();
  }
});

test("assess alone decides: a low-risk candidate is not due and silent, a high-risk one is due", async () => {
  const low = fx();
  try {
    on(low);
    const a = await server(low)("review_assess", {});
    assert.equal(a.isError, false);
    assert.equal(a.body.risk_level, "low");
    assert.equal(a.body.review_due, false);
    assert.deepEqual(stop(low), SILENT);
    assert.deepEqual(push(low), SILENT);
    assert.equal(existsSync(join(low.commonDir, "odd-plugin", "review-escalations.json")), false, "review_assess writes nothing");
  } finally {
    low.cleanup();
  }
  const high = fx("high");
  try {
    on(high);
    const a = await server(high)("review_assess", {});
    assert.equal(a.body.risk_level, "high");
    assert.equal(a.body.review_due, true);
    assert.equal(JSON.parse(stop(high).stdout).decision, "block");
    assert.deepEqual(JSON.parse(push(high).stdout), { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: UNREVIEWED_DELIVERY_NOTICE } });
  } finally {
    high.cleanup();
  }
});

test("a 4.x escalation store on disk is ignored without error and left untouched", async () => {
  const f = fx();
  try {
    on(f);
    const call = server(f);
    const a = await call("review_assess", {});
    const store = JSON.stringify({ schema: "odd-claude.review-escalations/v1", entries: [{ target_identity: a.body.target_identity, item: 3, reason: ESC.reason }] }) + "\n";
    mkdirSync(join(f.commonDir, "odd-plugin"), { recursive: true });
    writeFileSync(STORE(f), store);
    const again = await call("review_assess", {});
    assert.equal(again.isError, false);
    assert.equal(again.body.review_due, false);
    assert.equal(again.body.risk_level, "low");
    assert.deepEqual(stop(f), SILENT);
    assert.deepEqual(push(f), SILENT);
    const started = await call("review_start", {});
    assert.equal(started.isError, false, "a low-risk START is approved at once, as without a store");
    assert.equal(readFileSync(STORE(f), "utf8"), store);
  } finally {
    f.cleanup();
  }
});
