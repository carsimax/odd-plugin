import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { consentBinding, offPathCommand, REVIEW_CONTRACT, REVIEW_TOOL_NAMES } from "../review/consent.js";
import { pendingCorrectionLineage, snapshotTargetFor, type RunDeps } from "../review/run.js";
import type { RiskAssessment, RiskAssessor } from "../review/start.js";
import { listLineages, readState } from "../review/store.js";
import { readDecline } from "../review/consent.js";
import { SUPPORTED_KEYWORDS, validateSchema, type JsonSchema } from "./jsonschema.js";
import { MAX_LINE_BYTES, ReviewServer, serve, SUPPORTED_PROTOCOLS, type Response } from "./review-server.js";
import { coerceArguments, MAX_OUTPUT_BYTES, TOOLS, TOOL_BY_NAME, type ToolDeps } from "./tools.js";

const PLUGIN_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");

// ---- helpers: real temp git repos and plugin-data dirs, removed in teardown; the runner is always injected ----

const ENV = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith("GIT_")) env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
})();

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

interface Fx {
  dir: string;
  repo: string;
  commonDir: string;
  data: string;
  cleanup: () => void;
}

function makeFx(opts: { dirty?: boolean } = {}): Fx {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-mcp-")));
  const repo = join(dir, "repo");
  const data = join(dir, "data");
  mkdirSync(repo);
  mkdirSync(data);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "b.txt"), "bee\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  if (opts.dirty !== false) writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\nfour\nfive\n");
  return { dir, repo, commonDir: realpathSync(join(repo, ".git")), data, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withFx(fn: (f: Fx) => Promise<void>, opts: { dirty?: boolean } = {}): Promise<void> {
  const f = makeFx(opts);
  try {
    await fn(f);
  } finally {
    f.cleanup();
  }
}

const assess = (level: RiskAssessment["level"]): RiskAssessor => () => ({
  level,
  reasons: [{ code: level === "low" ? "non_executable_only" : "shell_source", ...(level === "low" ? {} : { signal: "shell_process", path: "a.txt" }) }],
  evidence: level === "low" ? [] : ["shell scripting in a.txt"],
});

const SEVERE = {
  location: "a.txt:1",
  severity: "CRITICAL",
  claim: "a.txt breaks on empty input",
  proof_refs: ["a.txt:1 reads the first line unchecked"],
  evidence_class: "deterministic",
  causal_disposition: "introduced",
};

function section(prompt: string, name: string): string {
  const m = new RegExp(`<<<ODD-DATA-\\w+ ${name}>>>\\n([\\s\\S]*?)\\n<<<END-ODD-DATA-\\w+ ${name}>>>`).exec(prompt);
  assert.ok(m, `prompt has a ${name} section`);
  return m[1]!;
}

/** A fake reviewer (never the real claude): answers from the prompt's own echo line and records every call. */
function fakeRunner(findings: Record<string, unknown[]> = {}): { prompts: string[]; runner: NonNullable<RunDeps["runner"]> } {
  const prompts: string[] = [];
  const runner: NonNullable<RunDeps["runner"]> = async (prompt) => {
    prompts.push(prompt);
    const head = /Role: (\w+)(?:, lens: (\w+))?\./.exec(prompt)!;
    const role = head[1]!;
    const lens = head[2];
    const echo = JSON.parse(/Echo these fields verbatim in the result: (\{.*\})/.exec(prompt)![1]!) as Record<string, unknown>;
    let result: Record<string, unknown>;
    if (role === "lens") {
      result = { ...echo, inspection: { status: "completed", paths: section(prompt, "changed-path-manifest").split("\n") }, findings: findings[lens!] ?? [], evidence: ["reviewed the complete candidate scope"] };
    } else if (role === "refuter") {
      const ids = (JSON.parse(section(prompt, "findings")) as Array<{ id: string }>).map((f) => f.id);
      result = { ...echo, results: ids.map((id) => ({ finding_id: id, outcome: "corroborated", proof_refs: ["a.txt:1 still fails"] })) };
    } else {
      result = { ...echo, original_criteria: { passed: true, evidence: ["a.txt:1 now guards the empty input"] }, correction_regression: { passed: true, evidence: ["the regression test passes"] }, follow_ups: [] };
    }
    return { ok: true, stdout: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n`, elapsedMs: 1 };
  };
  return { prompts, runner };
}

interface Called {
  isError: boolean;
  body: any;
}

function makeServer(f: Fx, level: RiskAssessment["level"] = "medium", runner?: RunDeps["runner"]): { call: (name: string, args?: Record<string, unknown>) => Promise<Called>; deps: ToolDeps } {
  const deps: ToolDeps = { riskAssessor: assess(level), modeOptions: { dataDir: f.data }, ...(runner !== undefined ? { runner } : {}) };
  const server = new ReviewServer({ deps, cwd: f.repo });
  let id = 0;
  return {
    deps,
    async call(name, args = {}) {
      const res = (await server.handle({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })) as Response;
      assert.equal(res.error, undefined, JSON.stringify(res.error));
      const result = res.result as { content: { type: string; text: string }[]; isError?: boolean };
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0]!.type, "text");
      assert.ok(Buffer.byteLength(result.content[0]!.text) <= MAX_OUTPUT_BYTES);
      return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) };
    },
  };
}

/** A consent choice's invocation as the tool call it names: `review_x --a-b v` becomes {a_b: "v"} (every value a string, quotes undone). */
function parseInvocation(invocation: string): { tool: string; args: Record<string, string> } {
  const tokens: string[] = [];
  let cur = "";
  let quoted = false;
  let any = false;
  for (let i = 0; i < invocation.length; i++) {
    const ch = invocation[i]!;
    if (quoted) {
      if (ch === "'") quoted = false;
      else cur += ch;
    } else if (ch === "'") {
      quoted = true;
      any = true;
    } else if (ch === "\\" && invocation[i + 1] !== undefined) cur += invocation[++i];
    else if (ch === " ") {
      if (cur !== "" || any) tokens.push(cur);
      cur = "";
      any = false;
    } else cur += ch;
  }
  if (cur !== "" || any) tokens.push(cur);
  const args: Record<string, string> = {};
  for (let i = 1; i < tokens.length; i += 2) {
    assert.match(tokens[i]!, /^--[a-z-]+$/, `flag ${tokens[i]}`);
    assert.notEqual(tokens[i + 1], undefined, `flag ${tokens[i]} has a value`);
    args[tokens[i]!.slice(2).replace(/-/g, "_")] = tokens[i + 1]!;
  }
  return { tool: tokens[0]!, args };
}
/** The literal arguments of a status transition: names snake_cased, values as given (strings). */
const lit = (args: { name: string; value: string }[]): Record<string, string> => Object.fromEntries(args.map((a) => [a.name.replace(/-/g, "_"), a.value]));
const choiceArgs = (env: any, answer: "granted" | "declined"): Record<string, string> => {
  const c = (env.choices as { answer: string; invocation: string }[]).find((x) => x.answer === answer)!;
  const p = parseInvocation(c.invocation);
  assert.equal(p.tool, "review_answer_consent");
  return p.args;
};

const errorCode = (c: Called): string => {
  assert.equal(c.isError, true, JSON.stringify(c.body).slice(0, 500));
  return c.body.error.code as string;
};
const good = (c: Called): any => {
  assert.equal(c.isError, false, JSON.stringify(c.body).slice(0, 500));
  return c.body;
};

// ---- protocol ----

const rpc = (server: ReviewServer, message: unknown): Promise<Response | undefined> => server.handle(message);

test("initialize negotiates the protocol version and advertises only tools; initialized gets no reply", async () => {
  const s = new ReviewServer();
  for (const v of SUPPORTED_PROTOCOLS) {
    const r = (await rpc(s, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v, capabilities: {}, clientInfo: { name: "t", version: "1" } } }))!;
    const result = r.result as any;
    assert.equal(result.protocolVersion, v);
    assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
    assert.equal(result.serverInfo.name, "odd-claude-review");
    assert.match(result.serverInfo.version, /^\d+\.\d+\.\d+/);
  }
  const unknown = (await rpc(s, { jsonrpc: "2.0", id: "x", method: "initialize", params: { protocolVersion: "1999-01-01" } }))!;
  assert.equal(unknown.id, "x");
  assert.equal((unknown.result as any).protocolVersion, SUPPORTED_PROTOCOLS[0]);
  assert.equal(await rpc(s, { jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  assert.deepEqual((await rpc(s, { jsonrpc: "2.0", id: 2, method: "ping" }))!.result, {});
});

test("tools/list names exactly the final review tools, with strict schemas, annotations and no forbidden literal", async () => {
  const s = new ReviewServer();
  const r = (await rpc(s, { jsonrpc: "2.0", id: 1, method: "tools/list" }))!;
  const tools = (r.result as any).tools as { name: string; description: string; inputSchema: JsonSchema; annotations: Record<string, unknown> }[];
  assert.deepEqual(tools.map((t) => t.name), [...REVIEW_TOOL_NAMES]);
  const walk = (schema: JsonSchema, where: string): void => {
    for (const k of Object.keys(schema)) assert.ok(SUPPORTED_KEYWORDS.includes(k), `${where}: unsupported keyword ${k}`);
    for (const [k, v] of Object.entries(schema.properties ?? {})) walk(v, `${where}.${k}`);
    if (schema.items) walk(schema.items, `${where}[]`);
    if (schema.type === "object") assert.equal(schema.additionalProperties, false, `${where}: closed object`);
  };
  for (const t of tools) {
    assert.ok(t.description.length > 20 && t.description.length < 2000, t.name);
    assert.equal(t.inputSchema.type, "object");
    walk(t.inputSchema, t.name);
    assert.equal(typeof t.annotations.readOnlyHint, "boolean");
    assert.doesNotMatch(JSON.stringify(t), new RegExp(["odd", "_review|gen", "tle|tele", "metry"].join(""), "i"));
  }
  const readOnly = tools.filter((t) => t.annotations.readOnlyHint === true).map((t) => t.name);
  // review_assess records an `escalate`, so it is no longer read-only
  assert.deepEqual(readOnly, ["review_inspect", "review_status"]);
  assert.deepEqual(TOOLS.map((t) => t.name), tools.map((t) => t.name));
});

test("protocol errors: unknown method, unknown tool, bad params, bad request, batch", async () => {
  const s = new ReviewServer();
  const code = async (m: unknown): Promise<number | undefined> => (await rpc(s, m))?.error?.code;
  assert.equal(await code({ jsonrpc: "2.0", id: 1, method: "resources/list" }), -32601);
  assert.equal(await code({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "odd_nothing" } }), -32602);
  assert.equal(await code({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {} }), -32602);
  assert.equal(await code({ jsonrpc: "2.0", id: 4, method: "tools/call" }), -32602);
  assert.equal(await code({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "review_status", arguments: [] } }), -32602);
  assert.equal(await code({ id: 6, method: "ping" }), -32600);
  assert.equal(await code({ jsonrpc: "2.0", id: {}, method: "ping" }), -32600);
  assert.equal(await code([{ jsonrpc: "2.0", id: 7, method: "ping" }]), -32600);
  assert.equal(await code("nope"), -32600);
  assert.equal(await rpc(s, { jsonrpc: "2.0", method: "resources/list" }), undefined, "an unknown notification is ignored");
});

test("tools/call: invalid arguments are a typed tool error that changes nothing", async () => {
  await withFx(async (f) => {
    const { call } = makeServer(f);
    const bad: [string, Record<string, unknown>][] = [
      ["review_start", { target: "everything" }],
      ["review_start", { surprise: 1 }],
      ["review_start", { cwd: "" }],
      ["review_start", { lenses: ["risk"] }], // reason missing
      ["review_start", { lenses_reason: "x" }],
      ["review_start", { target: "base-diff" }],
      ["review_start", { base_ref: "main" }],
      ["review_start", { target: "base-diff", base_ref: "main", projection: "staged" }],
      ["review_answer_consent", {}],
      ["review_answer_consent", { target_identity: "sha256:abc", consent: "granted", consent_binding: `sha256:${"a".repeat(64)}` }],
      ["review_answer_consent", { target_identity: `sha256:${"a".repeat(64)}`, consent: "relay", consent_binding: `sha256:${"a".repeat(64)}` }],
      ["review_status", { acknowledgement: { lineage_id: "x" } }],
      ["review_run", { model: "gpt" }],
      ["review_run", { effort: "high" }], // effort needs a model
      ["review_run", { model: "haiku", effort: "high" }],
      ["review_run", { timeout_ms: 5 }],
      ["review_capture", { lineage_id: "x" }],
      ["review_capture_group", { lineage_id: "x", bindings: [] }],
      ["review_capture_group", { lineage_id: "x", bindings: ["a", "a"] }],
      ["review_acknowledge_approved", { lineage_id: "x" }],
      ["review_complete", { lineage_id: "x", expected_revision: 5 }],
      ["review_inspect", { limit: 0 }],
      ["review_assess", { escalate: "yes" }],
    ];
    for (const [name, args] of bad) assert.equal(errorCode(await call(name, args)), "invalid_input", `${name} ${JSON.stringify(args)}`);
    const c = await call("review_start", { target: "everything" });
    assert.ok(Array.isArray(c.body.error.errors) && c.body.error.errors.length > 0);
    assert.deepEqual(listLineages(f.commonDir).lineages, []);
    assert.equal(existsSync(join(f.commonDir, "odd-plugin")), false, "nothing was written");
  });
});

test("validateSchema: types, bounds, patterns, nesting, unknown properties", () => {
  const schema: JsonSchema = {
    type: "object", additionalProperties: false, required: ["a"],
    properties: { a: { type: "integer", minimum: 1, maximum: 3 }, s: { type: "string", pattern: "^x+$", maxLength: 3 }, l: { type: "array", items: { type: "string" }, maxItems: 2 }, c: { type: "string", const: "k" } },
  };
  assert.deepEqual(validateSchema(schema, { a: 2, s: "xx", l: ["q"], c: "k" }), []);
  assert.match(validateSchema(schema, {})[0]!, /missing required property a/);
  assert.match(validateSchema(schema, { a: 1.5 })[0]!, /expected integer/);
  assert.match(validateSchema(schema, { a: 4 })[0]!, /at most 3/);
  assert.equal(validateSchema(schema, { a: 1, s: "xxxy" }).length, 2);
  assert.match(validateSchema(schema, { a: 1, l: [1] })[0]!, /\$\.l\[0\]: expected string/);
  assert.match(validateSchema(schema, { a: 1, z: 1 })[0]!, /unknown property z/);
  assert.match(validateSchema(schema, { a: 1, c: "z" })[0]!, /must be "k"/);
  assert.match(validateSchema(schema, [])[0]!, /expected object, got array/);
  assert.ok(validateSchema({ type: "array", items: { type: "integer" } }, Array.from({ length: 50 }, () => "x")).length <= 10);
});

test("serve: newline-delimited framing, parse errors, oversize lines, ordering of replies per request", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: any[] = [];
  let acc = "";
  output.on("data", (c: Buffer) => { acc += c.toString(); });
  const done = serve(input, output, { cwd: tmpdir() });
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0",');
  input.write('"id":2,"method":"tools/list"}\r\nnot json\n\n');
  input.write(`${"x".repeat(MAX_LINE_BYTES + 10)}\n`);
  input.write('{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
  input.end('{"jsonrpc":"2.0","id":4,"method":"ping"}');
  await done;
  for (const l of acc.split("\n")) if (l !== "") lines.push(JSON.parse(l));
  const byId = new Map(lines.filter((l) => l.id !== null).map((l) => [l.id, l]));
  assert.deepEqual([...byId.keys()].sort(), [1, 2, 3, 4]);
  assert.equal(byId.get(2).result.tools.length, REVIEW_TOOL_NAMES.length);
  const errs = lines.filter((l) => l.id === null).map((l) => l.error.code).sort();
  assert.deepEqual(errs, [-32700, -32600].sort());
  for (const l of lines) assert.equal(l.jsonrpc, "2.0");
});

test("the compiled server speaks MCP over stdio: only protocol on stdout, nothing on stderr, exits when stdin closes", async () => {
  const entry = join(PLUGIN_ROOT, "dist-test", "mcp", "review-server.js");
  assert.ok(existsSync(entry), entry);
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: tmpdir() } });
  let out = "";
  let err = "";
  child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
  child.stderr.on("data", (c: Buffer) => { err += c.toString(); });
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  child.stdin.end();
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.equal(err, "");
  const msgs = out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].result.protocolVersion, "2025-06-18");
  assert.deepEqual(msgs[1].result.tools.map((t: { name: string }) => t.name), [...REVIEW_TOOL_NAMES]);
});

// ---- review_assess / review_inspect / review_status (read-only) ----

test("review_assess: classifies a change, bounds the paths, writes nothing; a clean tree is not due", async () => {
  await withFx(async (f) => {
    const { call } = makeServer(f);
    const a = good(await call("review_assess"));
    assert.equal(a.outcome, "assessed");
    assert.match(a.target_identity, /^sha256:[0-9a-f]{64}$/);
    assert.ok(["low", "medium", "high"].includes(a.risk_level));
    assert.deepEqual(a.changed_paths, ["a.txt"]);
    assert.equal(a.changed_paths_truncated, false);
    assert.equal(existsSync(join(f.commonDir, "odd-plugin")), false, "no review state written");
    const staged = good(await call("review_assess", { projection: "staged" }));
    assert.equal(staged.outcome, "not_due");
  });
  await withFx(async (f) => {
    const { call } = makeServer(f);
    assert.equal(good(await call("review_assess")).outcome, "not_due");
  }, { dirty: false });
});

test("review_assess: a target that cannot be frozen is a typed snapshot error", async () => {
  await withFx(async (f) => {
    const { call } = makeServer(f);
    assert.equal(errorCode(await call("review_assess", { target: "base-diff", base_ref: "no-such-ref", committed_only: true })), "snapshot_error");
    assert.equal(errorCode(await call("review_assess", { cwd: f.dir })), "snapshot_error");
  });
});

test("review_inspect: lists lineages and the RDD mode; an unreadable lineage is reported", async () => {
  await withFx(async (f) => {
    const { call } = makeServer(f, "low");
    const empty = good(await call("review_inspect"));
    assert.deepEqual(empty.lineages, []);
    assert.equal(empty.rdd_mode.effective, "off", "RDD is off by default");
    assert.equal(empty.truncated, false);
    const started = good(await call("review_start"));
    const one = good(await call("review_inspect"));
    assert.equal(one.lineages.length, 1);
    assert.equal(one.lineages[0].lineage_id, started.lineage_id);
    assert.equal(one.lineages[0].state, "approved");
    assert.equal(one.lineages[0].burned, false);
    writeFileSync(join(f.commonDir, "odd-plugin", "review-transactions", "v2", started.lineage_id, "review-state.json"), "garbage");
    const broken = good(await call("review_inspect"));
    assert.deepEqual(broken.lineages, []);
    assert.equal(broken.unreadable.length, 1);
    assert.equal(broken.unreadable[0].lineage_id, started.lineage_id);
  });
});

test("review_status follows status: a fresh candidate offers review_start; its command names a registered tool", async () => {
  await withFx(async (f) => {
    const { call } = makeServer(f);
    const s = good(await call("review_status"));
    assert.equal(s.next_transition.kind, "execute");
    assert.equal(s.next_transition.execute.operation, "review.start");
    assert.equal(s.next_transition.execute.command, "review_start");
    assert.ok((REVIEW_TOOL_NAMES as readonly string[]).includes(s.next_transition.execute.command));
    assert.deepEqual(listLineages(f.commonDir).lineages, []);
  });
});

// ---- review_start / review_answer_consent: consent is never answered by the server ----

test("review_start always relays: medium risk returns the untouched consent envelope and creates nothing", async () => {
  await withFx(async (f) => {
    const { call } = makeServer(f, "medium");
    const env = good(await call("review_start"));
    assert.equal(env.action, "consent_required");
    assert.equal(env.contract, REVIEW_CONTRACT);
    assert.equal(env.choices.length, 2);
    for (const c of env.choices) assert.ok(c.invocation.startsWith("review_answer_consent --contract "), c.invocation);
    assert.equal(env.off_path.command, offPathCommand());
    assert.deepEqual(listLineages(f.commonDir).lineages, []);
    assert.equal(readDecline(f.commonDir, env.target_identity), undefined);
    // the same through the run loop: it returns the envelope, never answers it
    const run = good(await call("review_run"));
    assert.equal(run.outcome, "consent-required");
    assert.deepEqual(run.envelope, env);
    assert.deepEqual(listLineages(f.commonDir).lineages, []);
    assert.equal(readDecline(f.commonDir, env.target_identity), undefined);
  });
});

test("review_start: low risk is approved at once with its one-shot acknowledgement; a repeat is replayed, never duplicated", async () => {
  await withFx(async (f) => {
    const { call } = makeServer(f, "low");
    const r = good(await call("review_start"));
    assert.equal(r.action, "closed");
    assert.equal(r.state, "approved");
    assert.equal(r.risk_level, "low");
    assert.equal(r.acknowledgement.lineage_id, r.lineage_id);
    assert.equal(typeof r.acknowledgement.token, "string");
    const again = good(await call("review_start"));
    assert.equal(again.action, "replayed");
    assert.equal(again.lineage_id, r.lineage_id);
    assert.equal(listLineages(f.commonDir).lineages.length, 1);
  });
});

test("review_start: refusals are typed (explicit lenses on a low-risk review; clean tree is not due)", async () => {
  await withFx(async (f) => {
    const { call } = makeServer(f, "low");
    assert.equal(errorCode(await call("review_start", { lenses: ["risk"], lenses_reason: "touched shell" })), "invalid_lenses");
    assert.deepEqual(listLineages(f.commonDir).lineages, []);
  });
  await withFx(async (f) => {
    const { call } = makeServer(f, "high");
    const r = good(await call("review_start"));
    assert.equal(r.outcome, "not_due");
  }, { dirty: false });
});

test("review_answer_consent: the human's explicit grant starts the review; only for the exact candidate asked", async () => {
  await withFx(async (f) => {
    const { call } = makeServer(f, "medium");
    const env = good(await call("review_start"));
    // a moved candidate: nothing is recorded
    const Z = `sha256:${"0".repeat(64)}`;
    const moved = await call("review_answer_consent", { ...choiceArgs(env, "granted"), target_identity: Z, consent_binding: consentBinding(Z) });
    assert.equal(errorCode(moved), "binding_drift");
    assert.deepEqual(listLineages(f.commonDir).lineages, []);
    const declinedWrong = await call("review_answer_consent", { ...choiceArgs(env, "declined"), target_identity: Z, consent_binding: consentBinding(Z) });
    assert.equal(errorCode(declinedWrong), "binding_drift");
    assert.equal(readDecline(f.commonDir, env.target_identity), undefined);
    const ok = good(await call("review_answer_consent", choiceArgs(env, "granted")));
    assert.equal(ok.action, "created");
    assert.equal(ok.state, "reviewing");
    assert.equal(ok.target_identity, env.target_identity);
    assert.equal(listLineages(f.commonDir).lineages.length, 1);
  });
});

test("review_answer_consent: declined records a candidate-scoped decline and creates no lineage", async () => {
  await withFx(async (f) => {
    const { call } = makeServer(f, "medium");
    const env = good(await call("review_start"));
    const d = good(await call("review_answer_consent", choiceArgs(env, "declined")));
    assert.equal(d.outcome, "declined");
    assert.equal(d.reason_code, "consent_declined");
    assert.ok(readDecline(f.commonDir, env.target_identity));
    assert.deepEqual(listLineages(f.commonDir).lineages, []);
  });
});

test("consent is never answered without the human's explicit input: omitted/relay answers are refused and nothing changes", async () => {
  await withFx(async (f) => {
    const { call } = makeServer(f, "medium");
    const env = good(await call("review_start"));
    const before = JSON.stringify(listLineages(f.commonDir));
    const B = choiceArgs(env, "granted").consent_binding;
    for (const args of [
      { target_identity: env.target_identity, consent_binding: B },
      { consent: "granted", consent_binding: B },
      { target_identity: env.target_identity, consent: "granted" },
      { target_identity: env.target_identity, consent: "relay", consent_binding: B },
      { target_identity: env.target_identity, consent: true, consent_binding: B },
      { target_identity: env.target_identity, consent: "", consent_binding: B },
    ]) assert.equal(errorCode(await call("review_answer_consent", args)), "invalid_input", JSON.stringify(args));
    for (const name of ["review_start", "review_run", "review_status", "review_assess", "review_inspect"]) await call(name);
    assert.equal(JSON.stringify(listLineages(f.commonDir)), before);
    assert.equal(readDecline(f.commonDir, env.target_identity), undefined);
    assert.equal(existsSync(join(f.commonDir, "odd-plugin", "declines")), false);
  });
});

// ---- review_run / capture / acknowledge ----

async function consented(f: Fx, call: (n: string, a?: Record<string, unknown>) => Promise<Called>): Promise<string> {
  const env = good(await call("review_start"));
  return good(await call("review_answer_consent", choiceArgs(env, "granted"))).lineage_id as string;
}

test("review_run: acknowledged without the forecast binding is refused; with it the review closes and the receipt exists", async () => {
  await withFx(async (f) => {
    const { prompts, runner } = fakeRunner();
    const { call } = makeServer(f, "medium", runner);
    const lineage = await consented(f, call);
    const fc = good(await call("review_run", { lineage_id: lineage }));
    assert.equal(errorCode(await call("review_run", { lineage_id: lineage, reviewer_run_acknowledged: true })), "invalid_input");
    assert.equal(errorCode(await call("review_run", { lineage_id: lineage, reviewer_run_acknowledged: true, reviewer_run_binding: "nope" })), "binding_drift");
    assert.equal(prompts.length, 0, "no reviewer ran on a missing or wrong binding");
    const done = good(await call("review_run", { lineage_id: lineage, reviewer_run_acknowledged: true, reviewer_run_binding: fc.reviewer_run_binding }));
    assert.equal(done.outcome, "closed");
    assert.equal(prompts.length, 1);
    assert.equal(done.acknowledgement.outcome, "acknowledged");
    assert.equal(readState(f.commonDir, lineage).burned, true);
  });
});

test("review_run: an unknown lineage and a candidate that moved are typed", async () => {
  await withFx(async (f) => {
    const { runner } = fakeRunner();
    const { call } = makeServer(f, "medium", runner);
    assert.equal(errorCode(await call("review_run", { lineage_id: "review-0123456789abcdef" })), "unknown_lineage");
    const lineage = await consented(f, call);
    writeFileSync(join(f.repo, "a.txt"), "completely\ndifferent\n");
    assert.equal(errorCode(await call("review_run", { lineage_id: lineage })), "binding_drift");
  });
});

test("review_capture / review_acknowledge_approved: one slot, forecast, acknowledged capture returns the token, explicit acknowledge burns once", async () => {
  await withFx(async (f) => {
    const { prompts, runner } = fakeRunner();
    const { call } = makeServer(f, "medium", runner);
    const lineage = await consented(f, call);
    const st = good(await call("review_status"));
    assert.equal(st.next_transition.kind, "collect");
    const binding = st.next_transition.collect.inputs[0].arguments.find((a: any) => a.name === "binding").value as string;
    // wrong binding: nothing runs
    assert.equal(errorCode(await call("review_capture", { lineage_id: lineage, binding: `${binding}x` })), "binding_mismatch");
    const fc = good(await call("review_capture", { lineage_id: lineage, binding: binding }));
    assert.equal(fc.outcome, "forecast");
    assert.equal(prompts.length, 0);
    const cap = good(await call("review_capture", { lineage_id: lineage, binding: binding, reviewer_run_acknowledged: true, reviewer_run_binding: fc.reviewer_run_binding }));
    assert.equal(cap.outcome, "captured");
    assert.equal(cap.capture.outcome, "captured");
    assert.equal(cap.capture.next, "approved");
    assert.equal(prompts.length, 1);
    const rec = readState(f.commonDir, lineage);
    assert.equal(rec.state, "approved");
    assert.equal(rec.burned, false, "capture never acknowledges");
    const ack = cap.capture.acknowledgement;
    assert.equal(errorCode(await call("review_acknowledge_approved", { lineage_id: lineage, target_identity: ack.target_identity, expected_revision: ack.expected_revision, token: "wrong-token" })), "wrong_token");
    assert.equal(readState(f.commonDir, lineage).burned, false);
    const done = good(await call("review_acknowledge_approved", ack));
    assert.equal(done.outcome, "acknowledged");
    assert.equal(done.burned, true);
    assert.ok(existsSync(join(f.commonDir, "odd-plugin", "review-transactions", "v2", lineage, "receipt.json")) || done.receipt.lineage_id === lineage);
    const again = await call("review_acknowledge_approved", ack);
    assert.equal(again.isError, true, "a token is one-shot");
  });
});

test("review_capture vs review_capture_group: a multi-slot collect needs the whole ordered group; partial, reordered and stale bindings run nothing", async () => {
  await withFx(async (f) => {
    const { prompts, runner } = fakeRunner();
    const { call } = makeServer(f, "high", runner);
    const lineage = await consented(f, call);
    const st = good(await call("review_status"));
    const bindings = (st.next_transition.collect.inputs as any[]).map((i) => i.arguments.find((a: any) => a.name === "binding").value as string);
    assert.equal(bindings.length, 4);
    assert.equal(errorCode(await call("review_capture", { lineage_id: lineage, binding: bindings[0] })), "group_required");
    assert.equal(errorCode(await call("review_capture_group", { lineage_id: lineage, bindings: bindings.slice(0, 2) })), "binding_mismatch");
    assert.equal(errorCode(await call("review_capture_group", { lineage_id: lineage, bindings: [...bindings].reverse() })), "binding_mismatch");
    const fc = good(await call("review_capture_group", { lineage_id: lineage, bindings: bindings }));
    assert.equal(fc.outcome, "forecast");
    assert.equal(fc.reviewers.length, 4);
    assert.equal(prompts.length, 0);
    const cap = good(await call("review_capture_group", { lineage_id: lineage, bindings: bindings, reviewer_run_acknowledged: true, reviewer_run_binding: fc.reviewer_run_binding }));
    assert.equal(cap.outcome, "captured");
    assert.equal(cap.capture.next, "approved");
    assert.equal(prompts.length, 4);
    // nothing pending any more
    assert.equal(errorCode(await call("review_capture_group", { lineage_id: lineage, bindings: bindings })), "no_collect_pending");
  });
});

test("review_capture: an unknown lineage is typed; review_complete refuses a lineage that is not reviewing", async () => {
  await withFx(async (f) => {
    const { runner } = fakeRunner();
    const { call } = makeServer(f, "low", runner);
    assert.equal(errorCode(await call("review_capture", { lineage_id: "review-0123456789abcdef", binding: "x" })), "unknown_lineage");
    const started = good(await call("review_start"));
    const c = await call("review_complete", { lineage_id: started.lineage_id, expected_revision: started.acknowledgement.expected_revision });
    assert.equal(errorCode(c), "illegal_state");
    const stale = await call("review_complete", { lineage_id: started.lineage_id, expected_revision: "stale" });
    assert.equal(stale.isError, true);
  });
});

// ---- duplicate-lineage guard ----

/** A high-risk review whose only lens finds a severe issue: the lineage ends in correction_required. */
async function toCorrection(f: Fx): Promise<{ call: (n: string, a?: Record<string, unknown>) => Promise<Called>; lineage: string; prompts: string[] }> {
  const { prompts, runner } = fakeRunner({ risk: [SEVERE] });
  const { call } = makeServer(f, "high", runner);
  const lineage = await consented(f, call);
  const st = good(await call("review_status"));
  const bindings = (st.next_transition.collect.inputs as any[]).map((i) => i.arguments.find((a: any) => a.name === "binding").value as string);
  const fc = good(await call("review_capture_group", { lineage_id: lineage, bindings: bindings }));
  good(await call("review_capture_group", { lineage_id: lineage, bindings: bindings, reviewer_run_acknowledged: true, reviewer_run_binding: fc.reviewer_run_binding }));
  let rec = readState(f.commonDir, lineage);
  for (let i = 0; i < 3 && rec.state === "reviewing"; i++) {
    const s = good(await call("review_status"));
    const t = s.next_transition;
    if (t.kind === "execute" && t.execute.operation === "review.validate") {
      assert.equal(t.execute.command, "review_complete");
      good(await call("review_complete", lit(t.execute.arguments)));
    } else {
      const b = (t.collect.inputs as any[]).map((x) => x.arguments.find((a: any) => a.name === "binding").value as string);
      const f2 = good(await call("review_capture_group", { lineage_id: lineage, bindings: b }));
      good(await call("review_capture_group", { lineage_id: lineage, bindings: b, reviewer_run_acknowledged: true, reviewer_run_binding: f2.reviewer_run_binding }));
    }
    rec = readState(f.commonDir, lineage);
  }
  assert.equal(rec.state, "correction_required", `reached ${rec.state}`);
  return { call, lineage, prompts };
}

test("duplicate-lineage guard: a direct review_start / review_answer_consent while the lineage waits for its correction returns the pending lineage", async () => {
  await withFx(async (f) => {
    const { call, lineage } = await toCorrection(f);
    // the human corrects the code: the corrected candidate has another identity than the lineage's target
    writeFileSync(join(f.repo, "a.txt"), "one\nTWO\nthree\nfour\nfive\nsix\n");
    const before = listLineages(f.commonDir).lineages;
    assert.equal(before.length, 1);
    const pending = await call("review_start");
    assert.equal(errorCode(pending), "correction_lineage_pending");
    assert.equal(pending.body.error.lineage.lineage_id, lineage);
    assert.equal(pending.body.error.lineage.state, "correction_required");
    assert.match(pending.body.error.message, /review_run/);
    const I1 = `sha256:${"1".repeat(64)}`;
    const consent = await call("review_answer_consent", { target_identity: I1, consent: "granted", consent_binding: consentBinding(I1) });
    assert.equal(errorCode(consent), "correction_lineage_pending");
    assert.equal(consent.body.error.lineage.lineage_id, lineage);
    const declined = await call("review_answer_consent", { target_identity: I1, consent: "declined", consent_binding: consentBinding(I1) });
    assert.equal(errorCode(declined), "correction_lineage_pending");
    assert.deepEqual(listLineages(f.commonDir).lineages, before, "no second lineage");
    assert.equal(existsSync(join(f.commonDir, "odd-plugin", "declines")), false);
    // the exported helper agrees, and run.ts resumes the same lineage
    const p = pendingCorrectionLineage(f.repo, snapshotTargetFor({ target: { kind: "current-changes" } }));
    assert.ok(p && "rec" in p && p.rec.lineage_id === lineage);
    const run = good(await call("review_run", { lineage_id: lineage }));
    assert.equal(run.lineage_id, lineage);
  });
});

test("review_capture on the correction path: the validator binding comes from the run forecast; capture stops after the batch with the acknowledgement", async () => {
  await withFx(async (f) => {
    const { call, lineage, prompts } = await toCorrection(f);
    const plan = good(await call("review_run", { lineage_id: lineage }));
    assert.equal(plan.outcome, "input-required");
    writeFileSync(join(f.repo, "a.txt"), "one\nTWO\nthree\nfour\nfive\nsix\n");
    const fc = good(await call("review_run", { lineage_id: lineage }));
    assert.equal(fc.outcome, "forecast");
    assert.deepEqual(fc.reviewers.map((r: any) => r.role), ["validator"]);
    const binding = fc.reviewers[0].binding as string;
    assert.equal(errorCode(await call("review_capture", { lineage_id: lineage, binding: "garbage" })), "binding_mismatch");
    const before = prompts.length;
    const cap = good(await call("review_capture", { lineage_id: lineage, binding: binding, reviewer_run_acknowledged: true, reviewer_run_binding: fc.reviewer_run_binding }));
    assert.equal(cap.outcome, "captured");
    assert.equal(cap.capture.next, "approved");
    assert.equal(prompts.length, before + 1);
    assert.equal(readState(f.commonDir, lineage).burned, false, "capture does not acknowledge");
    const done = good(await call("review_acknowledge_approved", cap.capture.acknowledgement));
    assert.equal(done.outcome, "acknowledged");
  });
});

test("duplicate-lineage guard: an unreadable correction lineage blocks a direct start (fails closed) and nothing is created", async () => {
  await withFx(async (f) => {
    const { call, lineage } = await toCorrection(f);
    writeFileSync(join(f.repo, "a.txt"), "one\nTWO\nthree\nfour\nfive\nsix\n");
    const statePath = join(f.commonDir, "odd-plugin", "review-transactions", "v2", lineage, "review-state.json");
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    raw.revision = "sha256:tampered";
    writeFileSync(statePath, JSON.stringify(raw));
    const c = await call("review_start");
    assert.equal(errorCode(c), "authority_error");
    assert.equal(c.body.error.lineage_id, lineage);
    assert.equal(listLineages(f.commonDir).lineages.length, 1);
  });
});

test("without a pending correction a direct start is unaffected by the guard", async () => {
  await withFx(async (f) => {
    const { call } = makeServer(f, "medium");
    assert.equal(good(await call("review_start")).action, "consent_required");
    assert.equal(pendingCorrectionLineage(f.repo, snapshotTargetFor({ target: { kind: "current-changes" } })), undefined);
  });
});

// ---- every invocation string names something that exists ----

test("every invocation the plugin hands out names a registered tool or an existing dist/cli file", async () => {
  const tools = new Set<string>(TOOLS.map((t) => t.name));
  const cliExists = (text: string): void => {
    const named = [...text.matchAll(/dist[\\/]cli[\\/]([\w-]+\.js)/g)].map((m) => m[1]!);
    for (const n of named) assert.ok(existsSync(join(PLUGIN_ROOT, "dist", "cli", n)), `dist/cli/${n} exists`);
  };
  await withFx(async (f) => {
    const { call } = makeServer(f, "medium");
    const env = good(await call("review_start"));
    for (const c of env.choices) {
      const tool = c.invocation.split(" ")[0] as string;
      assert.ok(tools.has(tool), `${tool} is registered`);
      // its flags are properties of that tool's schema
      const props = Object.keys((TOOLS.find((t) => t.name === tool)!.inputSchema.properties ?? {}));
      for (const flag of c.invocation.matchAll(/ --([a-z-]+)/g)) assert.ok(props.includes(flag[1]!.replace(/-/g, "_")), `${tool} accepts --${flag[1]}`);
    }
    assert.ok(env.off_path.command.startsWith("node "));
    cliExists(env.off_path.command);
    cliExists(env.off_path.note);
    assert.equal(JSON.stringify(env).includes("<plugin>"), false);
  });
  // the commands of every status transition
  await withFx(async (f) => {
    const { runner } = fakeRunner();
    const { call } = makeServer(f, "low", runner);
    const startCmd = good(await call("review_status")).next_transition.execute.command as string;
    assert.ok(tools.has(startCmd), startCmd);
    const s = good(await call("review_start"));
    const ackCmd = good(await call("review_status", { acknowledgement: s.acknowledgement })).next_transition;
    assert.equal(ackCmd.execute.operation, "review.acknowledge-approved");
    assert.ok(tools.has(ackCmd.execute.command), ackCmd.execute.command);
  });
  for (const t of REVIEW_TOOL_NAMES) assert.ok(tools.has(t));
});

test("the plugin manifest registers the review server at an existing build output, next to codegraph", () => {
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
  assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ["codegraph", "peers", "review"]);
  const review = cfg.mcpServers.review!;
  assert.equal(review.command, "node");
  assert.deepEqual(review.args, ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/review-server.js"]);
  assert.ok(existsSync(join(PLUGIN_ROOT, "dist", "mcp", "review-server.js")));
  const plugin = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")) as Record<string, unknown>;
  assert.equal(plugin.mcpServers, undefined, "declared once, in .mcp.json");
});

// ---- S1: the contract texts an agent follows are accepted literally ----

/** Calls the tool a transition names with its arguments exactly as given; the tool must exist and the arguments must validate. */
async function literal(call: (n: string, a?: Record<string, unknown>) => Promise<Called>, command: string, args: { name: string; value: string }[]): Promise<Called> {
  const tool = TOOL_BY_NAME.get(command);
  assert.ok(tool, `${command} is a registered tool`);
  const given = lit(args);
  assert.deepEqual(validateSchema(tool.inputSchema, coerceArguments(tool.inputSchema, given)), [], `${command} ${JSON.stringify(given)}`);
  return call(command, given);
}

test("B1/M1 (S1): status transitions taken literally are accepted by the named tool", async () => {
  // low risk: start, then the acknowledgement transition
  await withFx(async (f) => {
    const { call } = makeServer(f, "low");
    const t = good(await call("review_status")).next_transition;
    assert.equal(t.execute.command, "review_start");
    const started = good(await literal(call, t.execute.command, t.execute.arguments));
    assert.equal(started.action, "closed");
    const ack = good(await call("review_status", { acknowledgement: started.acknowledgement })).next_transition;
    assert.equal(ack.execute.command, "review_acknowledge_approved");
    const done = good(await literal(call, ack.execute.command, ack.execute.arguments));
    assert.equal(done.outcome, "acknowledged");
  });
  // medium: the offered start relays; then one reviewer slot through the collect's own command, and per input
  await withFx(async (f) => {
    const { prompts, runner } = fakeRunner();
    const { call } = makeServer(f, "medium", runner);
    const t = good(await call("review_status")).next_transition;
    const env = good(await literal(call, t.execute.command, t.execute.arguments));
    assert.equal(env.action, "consent_required");
    good(await call("review_answer_consent", choiceArgs(env, "granted")));
    const c = good(await call("review_status")).next_transition;
    assert.equal(c.kind, "collect");
    assert.equal(c.collect.command, "review_capture");
    assert.equal(c.collect.inputs.length, 1);
    assert.equal(c.collect.inputs[0].command, "review_capture");
    assert.equal(good(await literal(call, c.collect.command, c.collect.arguments)).outcome, "forecast");
    assert.equal(good(await literal(call, c.collect.inputs[0].command, c.collect.inputs[0].arguments)).outcome, "forecast");
    assert.equal(prompts.length, 0);
  });
  // high: a group through review_capture_group with the bindings array; one slot of a group is a typed refusal
  await withFx(async (f) => {
    const { runner } = fakeRunner();
    const { call } = makeServer(f, "high", runner);
    await consented(f, call);
    const c = good(await call("review_status")).next_transition;
    assert.equal(c.collect.command, "review_capture_group");
    assert.equal(c.collect.inputs.length, 4);
    assert.equal(good(await literal(call, c.collect.command, c.collect.arguments)).outcome, "forecast");
    assert.equal(errorCode(await literal(call, c.collect.inputs[0].command, c.collect.inputs[0].arguments)), "group_required");
  });
  // a committed range (the gate's path): the start status offers for base-diff carries base_ref and committed_only
  await withFx(async (f) => {
    git(f.repo, "checkout", "-q", "-b", "feat");
    git(f.repo, "commit", "-q", "-am", "work");
    const { call } = makeServer(f, "medium");
    const t = good(await call("review_status", { target: "base-diff", base_ref: "main", committed_only: true })).next_transition;
    assert.ok(t.execute.arguments.some((a: any) => a.name === "committed_only" && a.value === "true"));
    assert.equal(good(await literal(call, t.execute.command, t.execute.arguments)).action, "consent_required");
  });
  // the correction and validator steps go through review_run; review_complete is literal inside toCorrection
  await withFx(async (f) => {
    const { call, lineage } = await toCorrection(f);
    const c = good(await call("review_status")).next_transition;
    assert.equal(c.reason_code, "correction_required");
    assert.equal(c.collect.command, "review_run");
    const run = good(await literal(call, c.collect.command, c.collect.arguments));
    assert.equal(run.outcome, "input-required");
    assert.equal(run.lineage_id, lineage);
  });
});

test("B2/m1 (S1): every consent choice, incl. base-diff and lenses, is accepted literally; declined works too", async () => {
  type Case = { name: string; level: RiskAssessment["level"]; start: Record<string, unknown>; committed?: boolean; lenses?: string[] };
  const cases: Case[] = [
    { name: "current-changes", level: "high", start: {} },
    { name: "staged lens subset with a quoted reason", level: "high", start: { lenses: ["risk", "reliability"], lenses_reason: "it's a retry loop" }, lenses: ["risk", "reliability"] },
    { name: "medium single lens", level: "medium", start: { lenses: ["reliability"], lenses_reason: "touched retries" }, lenses: ["reliability"] },
    { name: "base-diff committed-only", level: "medium", start: { target: "base-diff", base_ref: "main", committed_only: true }, committed: true },
  ];
  for (const c of cases) {
    for (const answer of ["granted", "declined"] as const) {
      await withFx(async (f) => {
        if (c.committed) {
          git(f.repo, "checkout", "-q", "-b", "feat");
          git(f.repo, "commit", "-q", "-am", "work");
        }
        const { call } = makeServer(f, c.level);
        const env = good(await call("review_start", c.start));
        const inv = env.choices.find((x: any) => x.answer === answer).invocation as string;
        if (c.committed) {
          assert.doesNotMatch(inv, /--projection/, "a base-diff candidate has no projection");
          assert.match(inv, /--committed-only true/);
        } else assert.match(inv, /--projection workspace/);
        const args = choiceArgs(env, answer);
        const tool = TOOL_BY_NAME.get("review_answer_consent")!;
        assert.deepEqual(validateSchema(tool.inputSchema, coerceArguments(tool.inputSchema, args)), [], `${c.name}: ${inv}`);
        const r = good(await call("review_answer_consent", args));
        if (answer === "granted") {
          assert.equal(r.state, "reviewing", c.name);
          if (c.lenses) assert.deepEqual(r.selected_lenses, c.lenses.map((l) => `review-${l}`), c.name);
          assert.equal(listLineages(f.commonDir).lineages.length, 1);
        } else {
          assert.equal(r.outcome, "declined", c.name);
          assert.deepEqual(listLineages(f.commonDir).lineages, []);
        }
      });
    }
  }
});

test("advisory: an answer for another lens selection than the envelope's is refused and nothing is recorded", async () => {
  await withFx(async (f) => {
    const { call } = makeServer(f, "high");
    const env = good(await call("review_start", { lenses: ["risk"], lenses_reason: "only risk" }));
    const args = choiceArgs(env, "granted");
    for (const bad of [{ ...args, lenses: "risk,reliability" }, { ...args, lenses: "resilience" }, { ...args, lenses_reason: "different" }]) {
      assert.equal(errorCode(await call("review_answer_consent", bad)), "binding_drift");
    }
    const noLenses = { ...args } as Record<string, string>;
    delete noLenses.lenses;
    delete noLenses.lenses_reason;
    assert.equal(errorCode(await call("review_answer_consent", noLenses)), "binding_drift");
    assert.deepEqual(listLineages(f.commonDir).lineages, []);
    assert.equal(good(await call("review_answer_consent", args)).selected_lenses.length, 1);
  });
});

test("advisory: a duplicate in-flight JSON-RPC id is rejected, the first call is unaffected", async () => {
  await withFx(async (f) => {
    const server = new ReviewServer({ deps: { riskAssessor: assess("low"), modeOptions: { dataDir: f.data } }, cwd: f.repo });
    const msg = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "review_assess", arguments: {} } };
    const first = server.handle(msg);
    const second = await server.handle(msg);
    assert.equal(second?.error?.code, -32600);
    assert.match(second!.error!.message, /already in flight/);
    const done = (await first)!;
    assert.equal(done.error, undefined);
    assert.equal(((done.result as any).content[0].text as string).includes("assessed"), true);
    // once settled the id may be reused
    assert.equal((await server.handle(msg))?.error, undefined);
  });
});

test("m2: a large reply is complete when stdin closes right after the request", async () => {
  await withFx(async (f) => {
    const long = (c: string): string => c.repeat(200);
    for (let i = 0; i < 200; i++) {
      const dir = join(f.repo, `d${i}${long("x")}`, long("y"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${long("f")}.txt`), `${i}\n`);
    }
    git(f.repo, "add", "-A");
    const entry = join(PLUGIN_ROOT, "dist-test", "mcp", "review-server.js");
    const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: tmpdir() } });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "review_assess", arguments: { cwd: f.repo, projection: "staged" } } })}\n`);
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
    const out = Buffer.concat(chunks).toString("utf8");
    assert.ok(out.length > 65536 * 1.5, `the reply is larger than one pipe buffer (${out.length})`);
    assert.ok(out.endsWith("\n"), "the reply ends with a newline");
    const msg = JSON.parse(out) as { id: number; result: { content: { text: string }[] } };
    assert.equal(msg.id, 1);
    const body = JSON.parse(msg.result.content[0]!.text);
    assert.equal(body.outcome, "assessed");
    assert.equal(body.changed_paths_total, 201, "200 new files plus a.txt");
    assert.equal(body.changed_paths.length, 200, "bounded");
  });
});

test("S1/A1: a __proto__ argument is an unknown property, never a schema bypass", async () => {
  await withFx(async (f) => {
    const server = new ReviewServer({ deps: { riskAssessor: assess("low"), modeOptions: { dataDir: f.data } }, cwd: f.repo });
    let id = 0;
    // JSON.parse makes "__proto__" an OWN property, exactly what a client can send over the wire
    const send = async (name: string, argsJson: string): Promise<{ isError?: boolean; text: string }> => {
      const msg = JSON.parse(`{"jsonrpc":"2.0","id":${++id},"method":"tools/call","params":{"name":${JSON.stringify(name)},"arguments":${argsJson}}}`);
      const res = (await server.handle(msg))!;
      assert.equal(res.error, undefined);
      const r = res.result as { content: { text: string }[]; isError?: boolean };
      return { isError: r.isError, text: r.content[0]!.text };
    };
    for (const [name, args] of [
      ["review_inspect", '{"__proto__":{"limit":0}}'],
      ["review_status", '{"__proto__":{"projection":"staged"}}'],
      ["review_status", '{"constructor":{"x":1}}'],
      ["review_inspect", '{"prototype":1}'],
      ["review_inspect", '{"limit":"3","__proto__":{"limit":0}}'],
    ] as const) {
      const r = await send(name, args);
      assert.equal(r.isError, true, `${name} ${args}: ${r.text}`);
      const body = JSON.parse(r.text);
      assert.equal(body.error.code, "invalid_input", `${name} ${args}`);
      assert.match(JSON.stringify(body.error.errors), /unknown property (__proto__|constructor|prototype)/, `${name} ${args}`);
    }
    // the polluted value never reached the tool: nothing was written, and a clean call still works
    assert.equal(existsSync(join(f.commonDir, "odd-plugin")), false);
    assert.equal(JSON.parse((await send("review_inspect", '{"limit":"3"}')).text).lineages.length, 0);
    assert.equal(({} as Record<string, unknown>).limit, undefined, "Object.prototype was not polluted");
  });
});

test("S1/A2: numeric and string ids are distinct in-flight requests", async () => {
  await withFx(async (f) => {
    const server = new ReviewServer({ deps: { riskAssessor: assess("low"), modeOptions: { dataDir: f.data } }, cwd: f.repo });
    const call = (id: string | number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "review_assess", arguments: {} } });
    // all four are started before anything settles (the tools run on microtasks), so 6 and "6" are in flight together
    const [ra, rb, dup, dupStr] = await Promise.all([server.handle(call(6)), server.handle(call("6")), server.handle(call(6)), server.handle(call("6"))]) as Response[];
    assert.equal(dup.error?.code, -32600, "the same id of the same type is still a duplicate");
    assert.equal(dupStr.error?.code, -32600);
    assert.equal(ra.error, undefined);
    assert.equal(rb.error, undefined);
    assert.equal(ra.id, 6);
    assert.equal(rb.id, "6");
  });
});

test("S1/T1: coercion only applies to the declared type; string properties keep their text", async () => {
  const ack = TOOL_BY_NAME.get("review_acknowledge_approved")!.inputSchema;
  const given = { lineage_id: "[1]", target_identity: `sha256:${"a".repeat(64)}`, expected_revision: "12345", token: "true" };
  assert.deepEqual({ ...(coerceArguments(ack, given) as object) }, given, "string properties are untouched");
  const run = TOOL_BY_NAME.get("review_run")!.inputSchema;
  const out = coerceArguments(run, { lenses_reason: "true", timeout_ms: "1e3", reviewer_run_acknowledged: "TRUE", reviewer_run_binding: "12" }) as Record<string, unknown>;
  assert.deepEqual({ ...out }, { lenses_reason: "true", timeout_ms: "1e3", reviewer_run_acknowledged: "TRUE", reviewer_run_binding: "12" });
  // declared types still coerce (the other side of the rule)
  assert.deepEqual({ ...(coerceArguments(run, { timeout_ms: "5000", reviewer_run_acknowledged: "true", lenses: "risk,reliability" }) as object) }, { timeout_ms: 5000, reviewer_run_acknowledged: true, lenses: ["risk", "reliability"] });
  // the wrong-shaped values are then rejected by the schema, with nothing run
  await withFx(async (f) => {
    const { call } = makeServer(f);
    for (const args of [{ timeout_ms: "1e3" }, { reviewer_run_acknowledged: "TRUE" }, { lenses_reason: "true" }]) {
      assert.equal(errorCode(await call("review_run", args)), "invalid_input", JSON.stringify(args));
    }
    assert.deepEqual(listLineages(f.commonDir).lineages, []);
  });
});

test("S1/A2: notifications/cancelled aborts only the request with the same id type", async () => {
  const tools = TOOL_BY_NAME as Map<string, unknown>;
  // A probe tool that waits on the request's abort signal (the only way to observe which request a cancellation reached).
  tools.set("review_probe", {
    name: "review_probe",
    description: "test probe",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (_args: unknown, ctx: { signal?: AbortSignal }) =>
      new Promise((resolve) => {
        const text = (t: string) => resolve({ content: [{ type: "text", text: t }] });
        const timer = setTimeout(() => text("timeout"), 5000);
        ctx.signal?.addEventListener("abort", () => { clearTimeout(timer); text("aborted"); }, { once: true });
      }),
  });
  try {
    const server = new ReviewServer({ cwd: tmpdir() });
    const call = (id: string | number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "review_probe", arguments: {} } });
    const cancel = (requestId: string | number) => server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } });
    const text = async (p: Promise<Response | undefined>): Promise<string> => ((await p)!.result as { content: { text: string }[] }).content[0]!.text;
    /** "pending" when the request has not settled after a short wait. */
    const state = (p: Promise<string>): Promise<string> => Promise.race([p, new Promise<string>((r) => setTimeout(() => r("pending"), 150))]);
    const numeric = text(server.handle(call(6)));
    const string = text(server.handle(call("6")));
    assert.equal(await cancel("6"), undefined, "a notification gets no reply");
    assert.equal(await state(string), "aborted", 'cancelling "6" reaches the string id');
    assert.equal(await state(numeric), "pending", "and not the numeric id 6");
    await cancel("7");
    assert.equal(await state(numeric), "pending", "an unknown id cancels nothing");
    await cancel(6);
    assert.equal(await state(numeric), "aborted", "cancelling 6 reaches the numeric id");
  } finally {
    tools.delete("review_probe");
  }
  assert.equal(TOOL_BY_NAME.has("review_probe"), false);
});

test("S1/A1: every tool rejects __proto__/constructor/prototype, top level and nested, writing nothing", async () => {
  await withFx(async (f) => {
    const server = new ReviewServer({ deps: { riskAssessor: assess("low"), modeOptions: { dataDir: f.data } }, cwd: f.repo });
    let id = 0;
    const send = async (name: string, argsJson: string): Promise<any> => {
      // JSON.parse makes the reserved names OWN properties, as a client sends them
      const msg = JSON.parse(`{"jsonrpc":"2.0","id":${++id},"method":"tools/call","params":{"name":${JSON.stringify(name)},"arguments":${argsJson}}}`);
      const res = (await server.handle(msg))!;
      assert.equal(res.error, undefined);
      const r = res.result as { content: { text: string }[]; isError?: boolean };
      assert.equal(r.isError, true, `${name} ${argsJson}: ${r.content[0]!.text.slice(0, 200)}`);
      return JSON.parse(r.content[0]!.text);
    };
    const payloads = ['{"__proto__":{"limit":0}}', '{"constructor":{"x":1}}', '{"prototype":1}', '{"cwd":"/x","__proto__":{"cwd":"/y"}}'];
    for (const tool of TOOLS) {
      for (const payload of payloads) {
        const body = await send(tool.name, payload);
        assert.equal(body.error.code, "invalid_input", `${tool.name} ${payload}`);
        assert.match(JSON.stringify(body.error.errors), /unknown property (__proto__|constructor|prototype)/, `${tool.name} ${payload}`);
      }
    }
    // nested: the acknowledgement object of review_status
    const ack = '"lineage_id":"review-0123456789abcdef","target_identity":"sha256:' + "a".repeat(64) + '","expected_revision":"r","token":"t"';
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const body = await send("review_status", `{"acknowledgement":{${ack},"${key}":{"token":"x"}}}`);
      assert.equal(body.error.code, "invalid_input", key);
      assert.match(JSON.stringify(body.error.errors), new RegExp(`\\$\\.acknowledgement: unknown property ${key}`), key);
    }
    const body = await send("review_status", `{"acknowledgement":{"__proto__":{"token":"x"}}}`);
    assert.match(JSON.stringify(body.error.errors), /missing required property|unknown property __proto__/);
    assert.equal(existsSync(join(f.commonDir, "odd-plugin")), false, "nothing was written");
    assert.equal(({} as Record<string, unknown>).limit, undefined, "Object.prototype was not polluted");
  });
});
