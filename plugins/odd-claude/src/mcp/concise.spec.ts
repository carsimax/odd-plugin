import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RiskAssessment, RiskAssessor } from "../review/start.js";
import { ReviewServer, type Response } from "./review-server.js";
import { TOOL_BY_NAME, type ToolDeps } from "./tools.js";

// M8 (S7): review_status is the only review/peers tool whose typical response exceeds ~2 KB and that is not a consent
// envelope or a cost forecast; it gets `detail: "concise" | "full"` (default "full", byte-identical to the old output).

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

const assess = (level: RiskAssessment["level"]): RiskAssessor => () => ({
  level,
  reasons: [{ code: "shell_source", signal: "shell_process", path: "a.txt" }],
  evidence: ["shell scripting in a.txt"],
});

async function withServer(fn: (call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string; body: any }>) => Promise<void>): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-concise-")));
  const repo = join(dir, "repo");
  const data = join(dir, "data");
  mkdirSync(repo);
  mkdirSync(data);
  try {
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\nfour\n");
    const deps: ToolDeps = { riskAssessor: assess("high"), modeOptions: { dataDir: data } };
    const server = new ReviewServer({ deps, cwd: repo });
    let id = 0;
    await fn(async (name, args = {}) => {
      const res = (await server.handle({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })) as Response;
      assert.equal(res.error, undefined);
      const result = res.result as { content: { text: string }[]; isError?: boolean };
      const text = result.content[0]!.text;
      return { isError: result.isError === true, text, body: JSON.parse(text) };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The granted consent choice as the arguments of review_answer_consent. */
function grantedArgs(env: any): Record<string, string> {
  const inv = (env.choices as { answer: string; invocation: string }[]).find((c) => c.answer === "granted")!.invocation;
  const toks = inv.match(/'[^']*'|\S+/g)!;
  const args: Record<string, string> = {};
  for (let i = 1; i < toks.length; i += 2) args[toks[i]!.slice(2).replace(/-/g, "_")] = toks[i + 1]!.replace(/^'|'$/g, "");
  return args;
}

const bytes = (s: string): number => Buffer.byteLength(s);

test("review_status: the input schema and description declare detail concise|full", () => {
  const t = TOOL_BY_NAME.get("review_status")!;
  const d = (t.inputSchema.properties as any).detail;
  assert.deepEqual(d.enum, ["concise", "full"]);
  assert.equal(t.inputSchema.additionalProperties, false);
  assert.match(t.description, /detail/);
  assert.match(t.description, /concise/);
  assert.ok(t.description.length < 2000);
});

test("review_status: detail full and the omitted argument are byte-identical, fresh and reviewing states", async () => {
  await withServer(async (call) => {
    const none = await call("review_status");
    assert.equal(none.isError, false);
    const full = await call("review_status", { detail: "full" });
    assert.equal(full.text, none.text);
    assert.deepEqual(full.body, none.body);
    const env = (await call("review_start")).body;
    assert.equal((await call("review_answer_consent", grantedArgs(env))).isError, false);
    const none2 = await call("review_status");
    const full2 = await call("review_status", { detail: "full" });
    assert.equal(none2.body.next_transition.kind, "collect");
    assert.equal(full2.text, none2.text);
  });
});

test("review_status: concise is smaller and keeps every next-call field (fresh state)", async () => {
  await withServer(async (call) => {
    const full = (await call("review_status")).body;
    const c = await call("review_status", { detail: "concise" });
    assert.equal(c.isError, false);
    assert.ok(bytes(c.text) < bytes(JSON.stringify(full)), `${bytes(c.text)} < ${bytes(JSON.stringify(full))}`);
    assert.ok(full.forecast !== undefined && full.repair !== undefined, "the full status carries forecast and repair");
    for (const k of ["schema", "contract", "operation", "action", "target_identity", "next_transition", "consumed", "forecast", "repair"]) assert.deepEqual(c.body[k], full[k], k);
    assert.deepEqual(c.body.next_transition, full.next_transition);
  });
});

test("review_status: concise keeps every collect input's command, arguments, binding and the authority", async () => {
  await withServer(async (call) => {
    const env = (await call("review_start")).body;
    await call("review_answer_consent", grantedArgs(env));
    const full = (await call("review_status")).body;
    const c = await call("review_status", { detail: "concise" });
    assert.equal(c.isError, false);
    assert.ok(bytes(c.text) < bytes(JSON.stringify(full)) - 1500, "high-risk collect shrinks by at least 1.5 KB");
    assert.deepEqual(c.body.authority, full.authority);
    assert.ok(full.forecast !== undefined && full.repair !== undefined);
    assert.deepEqual(c.body.forecast, full.forecast);
    assert.deepEqual(c.body.repair, full.repair);
    assert.equal(c.body.projection, undefined, "projection is the only dropped top-level field");
    assert.deepEqual(c.body.target_identity, full.target_identity);
    const nt = c.body.next_transition;
    assert.equal(nt.kind, full.next_transition.kind);
    assert.equal(nt.reason_code, full.next_transition.reason_code);
    assert.equal(nt.collect.command, full.next_transition.collect.command);
    assert.deepEqual(nt.collect.arguments, full.next_transition.collect.arguments);
    assert.equal(nt.collect.inputs.length, full.next_transition.collect.inputs.length);
    nt.collect.inputs.forEach((i: any, n: number) => {
      const f = full.next_transition.collect.inputs[n];
      for (const k of ["name", "command", "arguments"]) assert.deepEqual(i[k], f[k], `${f.name}.${k}`);
      assert.ok(i.arguments.some((a: any) => a.name === "binding" && /^odd1\./.test(a.value)));
    });
  });
});

test("review_status: an invalid detail is rejected by schema validation and nothing runs", async () => {
  await withServer(async (call) => {
    for (const detail of ["verbose", "", "FULL", 1, null, true]) {
      const r = await call("review_status", { detail });
      assert.equal(r.isError, true, JSON.stringify(detail));
      assert.equal(r.body.error.code, "invalid_input");
      assert.ok(r.body.error.errors.length > 0);
    }
  });
});

test("the transition-arguments note is stated once, on review_status only", () => {
  const marker = "The `arguments` of a review_status transition";
  const holders = [...TOOL_BY_NAME.values()].filter((t) => t.description.includes(marker)).map((t) => t.name);
  assert.deepEqual(holders, ["review_status"]);
});
