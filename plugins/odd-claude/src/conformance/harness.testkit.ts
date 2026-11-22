// Test-only harness of the U16 conformance layer (excluded from the dist build by tsconfig.json):
//  - real temp git worlds (a bare origin plus a clone on a feature branch) and plugin-data dirs, removed in teardown;
//  - a FAKE `claude` reviewer executable (never the real binary) that answers from the prompt's own echo line;
//  - a stdio MCP client that spawns the REAL server entry (`dist-test/mcp/review-server.js`) with that fake first on PATH.
// Every spawned process gets a scrubbed environment (no GIT_*, no inherited secrets beyond PATH).
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

/** <plugin>/dist-test/conformance/harness.testkit.js -> <plugin> */
export const PLUGIN = fileURLToPath(new URL("../../", import.meta.url));
export const SERVER_ENTRY = join(PLUGIN, "dist-test", "mcp", "review-server.js");

export const CLEAN_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith("GIT_")) env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
})();

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-C", cwd, ...args], { env: CLEAN_ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

// ---- worlds ----

export interface World {
  dir: string;
  data: string;
  origin: string;
  repo: string;
  commonDir: string;
  cleanup: () => void;
}

/** A bare origin and a clone on branch `feature` (base `origin/main`): committed ranges are real deliveries. */
export function makeWorld(): World {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-conf-")));
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  const data = join(dir, "data");
  mkdirSync(repo);
  mkdirSync(data);
  git(repo, "init", "-q", "-b", "main");
  // Persisted in the repo config so copies (and the servers run on them) never spawn a detached auto-gc/maintenance that could prune objects mid-copy.
  git(repo, "config", "gc.auto", "0");
  git(repo, "config", "maintenance.auto", "false");
  writeFileSync(join(repo, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(repo, "README.md"), "# t\n");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "b.txt"), "bee\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(origin, "config", "gc.auto", "0");
  git(origin, "config", "maintenance.auto", "false");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  git(repo, "checkout", "-q", "-b", "feature");
  return { dir, data, origin, repo, commonDir: realpathSync(join(repo, ".git")), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The three tiers of the REAL classifier: dependency change = high, documentation = low, a deletion = medium. */
export const commitHigh = (w: World, v = "1.0.0"): void => {
  writeFileSync(join(w.repo, "package.json"), `{"name":"x","dependencies":{"left-pad":"${v}"}}\n`);
  git(w.repo, "commit", "-q", "-am", `deps ${v}`);
};
export const commitLow = (w: World): void => {
  writeFileSync(join(w.repo, "README.md"), "# t\n\nmore docs\n");
  git(w.repo, "commit", "-q", "-am", "docs");
};
export const commitMedium = (w: World): void => {
  git(w.repo, "rm", "-q", "b.txt");
  git(w.repo, "commit", "-q", "-m", "drop b");
};

/** The target every delivery-bound scenario reviews: the committed range against the pushed base. */
export const RANGE = { target: "base-diff", base_ref: "origin/main", committed_only: true } as const;

/** A byte copy of a world in a new temp dir (the clone keeps pointing at the original bare origin, which must outlive it). */
export function copyWorld(w: World): World {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-conf-")));
  cpSync(w.dir, dir, { recursive: true });
  return { dir, data: join(dir, "data"), origin: join(dir, "origin.git"), repo: join(dir, "repo"), commonDir: join(dir, "repo", ".git"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---- the fake reviewer ----

export const SEVERE = {
  location: "a.txt:1",
  severity: "CRITICAL",
  claim: "a.txt breaks on empty input",
  proof_refs: ["a.txt:1 reads the first line unchecked"],
  evidence_class: "deterministic",
  causal_disposition: "introduced",
};

export interface FakeReviewer {
  dir: string;
  /** Directory to put FIRST on the server's PATH. */
  binDir: string;
  /** One entry per `claude` invocation: the role and lens parsed from its prompt. */
  calls: () => { role: string; lens?: string; args: string[]; pid: number }[];
  cleanup: () => void;
}

/**
 * Writes `<dir>/bin/claude`, a node script that answers like a well-behaved isolated reviewer: it echoes the identity fields the
 * prompt asks for and reports `findings[lens]` (default none); refuters corroborate, validators pass. Each call appends a line
 * to `<dir>/calls.jsonl`. `sleepMs` delays the answer (race tests).
 */
export function makeFakeReviewer(opts: { findings?: Record<string, unknown[]>; sleepMs?: number } = {}): FakeReviewer {
  const dir = mkdtempSync(join(tmpdir(), "odd-conf-claude-"));
  mkdirSync(join(dir, "bin"));
  const log = join(dir, "calls.jsonl");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const cfg = ${JSON.stringify({ findings: opts.findings ?? {}, sleepMs: opts.sleepMs ?? 0, log })};
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  const section = (name) => {
    const m = new RegExp("<<<ODD-DATA-\\\\w+ " + name + ">>>\\\\n([\\\\s\\\\S]*?)\\\\n<<<END-ODD-DATA-\\\\w+ " + name + ">>>").exec(prompt);
    if (!m) throw new Error("no " + name + " section");
    return m[1];
  };
  const head = /Role: (\\w+)(?:, lens: (\\w+))?\\./.exec(prompt);
  const role = head[1];
  const lens = head[2];
  fs.appendFileSync(cfg.log, JSON.stringify({ role, lens, args: process.argv.slice(2), pid: process.pid }) + "\\n");
  const echo = JSON.parse(/Echo these fields verbatim in the result: (\\{.*\\})/.exec(prompt)[1]);
  let result;
  if (role === "lens") {
    result = { ...echo, inspection: { status: "completed", paths: section("changed-path-manifest").split("\\n") }, findings: cfg.findings[lens] || [], evidence: ["reviewed the complete candidate scope"] };
  } else if (role === "refuter") {
    const ids = JSON.parse(section("findings")).map((f) => f.id);
    result = { ...echo, results: ids.map((id) => ({ finding_id: id, outcome: "corroborated", proof_refs: ["a.txt:1 still fails"] })) };
  } else {
    result = { ...echo, original_criteria: { passed: true, evidence: ["a.txt:1 now guards the empty input"] }, correction_regression: { passed: true, evidence: ["the regression test passes"] }, follow_ups: [] };
  }
  const out = "\`\`\`json\\n" + JSON.stringify(result) + "\\n\`\`\`\\n";
  const done = () => { process.stdout.write(out); };
  if (cfg.sleepMs) setTimeout(done, cfg.sleepMs); else done();
});
`;
  const binary = join(dir, "bin", "claude");
  writeFileSync(binary, script);
  chmodSync(binary, 0o755);
  return {
    dir,
    binDir: join(dir, "bin"),
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)) : []),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---- stdio MCP client ----

export interface Called {
  isError: boolean;
  body: any;
}

export interface ServerEnv {
  fake: FakeReviewer;
  world: World;
  /** Extra environment for the server process. */
  env?: Record<string, string>;
  /** Load kill-preload.testkit.js into the server (crash injection; configured through ODD_KILL_* in `env`). */
  preload?: boolean;
}

export class McpClient {
  readonly child: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 0;
  private readonly waiting = new Map<number, (m: any) => void>();
  private exited: Promise<number | null>;

  constructor(se: ServerEnv) {
    const env: NodeJS.ProcessEnv = {
      PATH: [se.fake.binDir, process.env.PATH ?? ""].join(delimiter),
      HOME: se.world.dir,
      CLAUDE_PLUGIN_DATA: se.world.data,
      GIT_CONFIG_NOSYSTEM: "1",
      ...se.env,
    };
    const execArgv = se.preload === true ? ["--import", pathToFileURL(join(PLUGIN, "dist-test", "conformance", "kill-preload.testkit.js")).href] : [];
    this.child = spawn(process.execPath, [...execArgv, SERVER_ENTRY], { stdio: ["pipe", "pipe", "pipe"], env, cwd: se.world.repo });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (c: string) => {
      this.buf += c;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line === "") continue;
        const m = JSON.parse(line);
        this.waiting.get(m.id)?.(m);
        this.waiting.delete(m.id);
      }
    });
    this.child.stderr.on("data", (c: Buffer) => {
      this.stderr += c.toString("utf8");
    });
    this.exited = new Promise((resolve) => this.child.on("close", (code) => resolve(code)));
  }

  stderr = "";

  private rpc(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async initialize(): Promise<void> {
    const r = await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "odd-conformance", version: "1" } });
    assert.equal(r.error, undefined);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  /** Called with every tool result `call` returns (the lifecycle specs plug the envelope conformance check in here). */
  observe?: (tool: string, called: Called) => void;

  async call(name: string, args: Record<string, unknown> = {}): Promise<Called> {
    const res = await this.rpc("tools/call", { name, arguments: args });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    const result = res.result as { content: { type: string; text: string }[]; isError?: boolean };
    assert.equal(result.content.length, 1);
    const called = { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) };
    this.observe?.(name, called);
    return called;
  }

  /** Like `call`, but resolves `"died"` when the server process exits before it answered (kill -9 injection). */
  async callOrDie(name: string, args: Record<string, unknown> = {}): Promise<Called | "died"> {
    const res = await Promise.race([this.rpc("tools/call", { name, arguments: args }), this.exited.then(() => "died" as const)]);
    if (res === "died") return "died";
    const result = res.result as { content: { text: string }[]; isError?: boolean };
    return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) };
  }

  /** Waits for the process to exit and returns its signal and code. */
  async exitInfo(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) resolve({ code: this.child.exitCode, signal: this.child.signalCode });
      else this.child.on("close", (code, signal) => resolve({ code, signal }));
    });
  }

  /** Ends stdin and waits for the server to exit (0 expected). */
  async close(): Promise<number | null> {
    this.child.stdin.end();
    return this.exited;
  }

  /** SIGKILL, then wait. */
  async kill(): Promise<void> {
    this.child.kill("SIGKILL");
    await this.exited;
  }
}

export async function withClient<T>(se: ServerEnv, fn: (c: McpClient) => Promise<T>): Promise<T> {
  const c = new McpClient(se);
  try {
    await c.initialize();
    return await fn(c);
  } finally {
    const code = await c.close();
    assert.equal(code, 0, `server exit code (stderr: ${c.stderr})`);
    assert.equal(c.stderr, "", "the server writes nothing to stderr");
  }
}

export const good = (c: Called): any => {
  assert.equal(c.isError, false, JSON.stringify(c.body).slice(0, 600));
  return c.body;
};
export const errorCode = (c: Called): string => {
  assert.equal(c.isError, true, JSON.stringify(c.body).slice(0, 600));
  return c.body.error.code as string;
};

// ---- consent invocation -> tool arguments ----

/** A consent choice's invocation as the tool call it names: `review_x --a-b v` becomes {a_b: "v"}. */
export function parseInvocation(invocation: string): { tool: string; args: Record<string, string> } {
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
  for (let i = 1; i < tokens.length; i += 2) args[tokens[i]!.slice(2).replace(/-/g, "_")] = tokens[i + 1]!;
  return { tool: tokens[0]!, args };
}

export const consentArgs = (envelope: any, answer: "granted" | "declined"): Record<string, string> => {
  const choice = (envelope.choices as { answer: string; invocation: string }[]).find((x) => x.answer === answer);
  assert.ok(choice, `a ${answer} choice`);
  const p = parseInvocation(choice.invocation);
  assert.equal(p.tool, "review_answer_consent");
  return p.args;
};

/** Literal arguments of a status transition: names snake_cased, values as given. */
export const lit = (args: { name: string; value: string }[]): Record<string, string> => Object.fromEntries(args.map((a) => [a.name.replace(/-/g, "_"), a.value]));

// ---- store inspection (read-only) ----

export function lineageDirs(commonDir: string): string[] {
  const root = join(commonDir, "odd-plugin", "review-transactions", "v2");
  return existsSync(root) ? readdirSync(root).filter((n) => /^review-[0-9a-f]{16}$/.test(n)).sort() : [];
}

/** Every file under <commonDir>/odd-plugin, relative, sorted (temp-file / orphan checks). */
export function storeFiles(commonDir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(commonDir, "odd-plugin", rel), { withFileTypes: true })) {
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  if (existsSync(join(commonDir, "odd-plugin"))) walk("");
  return out.sort();
}
