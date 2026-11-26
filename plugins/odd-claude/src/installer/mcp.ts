// MCP registration in Claude Code user scope via the `claude mcp` CLI (injected runner; tests never run the real CLI).
// We only remove servers we added (recorded in the state file); servers that already exist are never touched.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readOddState, writeOddState } from "./managed-settings.js";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type McpRunner = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; /** Milliseconds before the child is killed (default 60000). */ timeout?: number }) => RunResult | Promise<RunResult>;

/** Real runner: `claude` resolved from PATH, env passed through (CLAUDE_CONFIG_DIR is honored by the CLI). */
export const defaultRunner: McpRunner = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { env: opts.env ?? process.env, encoding: "utf8", timeout: opts.timeout ?? 60_000 });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export type McpAction = "add" | "skip-existing" | "unknown";
export interface McpPlanEntry {
  name: string;
  action: McpAction;
  argv: string[];
  detail: string;
}
export interface McpPlan {
  servers: McpPlanEntry[];
}
export interface McpResult {
  name: string;
  status: "added" | "skipped" | "failed" | "unknown" | "removed";
  detail: string;
}

interface Opts {
  runner: McpRunner;
  env?: NodeJS.ProcessEnv;
  oddRoot: string;
}

const addArgv = (name: string, command: string[]): string[] => ["mcp", "add", "-s", "user", name, "--", ...command];
const removeArgv = (name: string): string[] => ["mcp", "remove", "-s", "user", name];

function wanted(oddRoot: string): { name: string; argv: string[] }[] {
  const root = oddRoot.replace(/\/+$/, "");
  return [
    { name: "odd-review", argv: addArgv("odd-review", ["node", `${root}/dist/mcp/review-server.js`]) },
    { name: "codegraph", argv: addArgv("codegraph", ["codegraph", "serve", "--mcp"]) },
  ];
}

async function run(runner: McpRunner, args: string[], env: NodeJS.ProcessEnv | undefined): Promise<RunResult> {
  try {
    return await runner("claude", args, { env });
  } catch (err) {
    return { code: null, stdout: "", stderr: (err as Error).message };
  }
}

const text = (r: RunResult): string => (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split("\n")[0];

/** True when `claude mcp list` output has a line starting with the exact name followed by ": " (names may contain colons). */
function listHas(out: string, name: string): boolean {
  return out.split("\n").some((line) => line.startsWith(`${name}: `));
}

async function detect(opts: Opts, name: string, listCache: { value?: Promise<RunResult> }): Promise<{ state: "exists" | "absent" | "unknown"; detail: string }> {
  const got = await run(opts.runner, ["mcp", "get", name], opts.env);
  if (got.code === 0) return { state: "exists", detail: "already registered" };
  if (got.code !== null && /no mcp server (named|found)/i.test(`${got.stdout}\n${got.stderr}`)) return { state: "absent", detail: "not registered" };
  listCache.value ??= run(opts.runner, ["mcp", "list"], opts.env);
  const list = await listCache.value;
  if (list.code !== 0) return { state: "unknown", detail: `could not detect existing servers: ${text(list)}` };
  return listHas(list.stdout, name) ? { state: "exists", detail: "already registered" } : { state: "absent", detail: "not registered" };
}

export async function planMcp(opts: Opts): Promise<McpPlan> {
  const listCache: { value?: Promise<RunResult> } = {};
  const servers: McpPlanEntry[] = [];
  for (const w of wanted(opts.oddRoot)) {
    const d = await detect(opts, w.name, listCache);
    servers.push({ name: w.name, argv: w.argv, detail: d.detail, action: d.state === "exists" ? "skip-existing" : d.state === "absent" ? "add" : "unknown" });
  }
  return { servers };
}

/** Servers retired by a release: removed on install/update only when the state records us as their owner. */
const RETIRED_SERVERS = ["odd-peers"];
const RETIRED_DETAIL = "retired: native cross-session messaging";

export async function applyMcp(opts: Opts & { statePath: string; dataDir?: string }): Promise<{ results: McpResult[] }> {
  const results: McpResult[] = [];
  if (opts.dataDir) {
    try {
      rmSync(join(opts.dataDir, "peers"), { recursive: true, force: true });
    } catch (err) {
      results.push({ name: "peers-dir", status: "failed", detail: `could not remove legacy peers directory: ${(err as Error).message}` });
    }
  }
  const recordedBefore = readOddState(opts.statePath).mcp?.added;
  const retire = RETIRED_SERVERS.filter((n) => Array.isArray(recordedBefore) && recordedBefore.includes(n));
  const retired: string[] = [];
  const listCache: { value?: Promise<RunResult> } = {};
  for (const name of retire) {
    if ((await detect(opts, name, listCache)).state === "absent") {
      retired.push(name);
      results.push({ name, status: "removed", detail: `${RETIRED_DETAIL} (already absent)` });
      continue;
    }
    const r = await run(opts.runner, removeArgv(name), opts.env);
    if (r.code === 0) {
      retired.push(name);
      results.push({ name, status: "removed", detail: RETIRED_DETAIL });
    } else if (/no mcp server (named|found)/i.test(`${r.stdout}\n${r.stderr}`)) {
      retired.push(name);
      results.push({ name, status: "removed", detail: `${RETIRED_DETAIL} (already absent)` });
    } else results.push({ name, status: "failed", detail: text(r) });
  }
  if (retired.length > 0) {
    const state = readOddState(opts.statePath);
    writeOddState(opts.statePath, { ...state, mcp: { ...state.mcp, added: (state.mcp?.added ?? []).filter((n: string) => !retired.includes(n)) } });
  }
  const plan = await planMcp(opts);
  const added: string[] = [];
  for (const s of plan.servers) {
    if (s.action === "skip-existing") results.push({ name: s.name, status: "skipped", detail: s.detail });
    else if (s.action === "unknown") results.push({ name: s.name, status: "unknown", detail: s.detail });
    else {
      const r = await run(opts.runner, s.argv, opts.env);
      if (r.code === 0) {
        added.push(s.name);
        results.push({ name: s.name, status: "added", detail: "registered in user scope" });
      } else results.push({ name: s.name, status: "failed", detail: text(r) });
    }
  }
  if (added.length > 0) {
    const state = readOddState(opts.statePath);
    const prev = Array.isArray(state.mcp?.added) ? state.mcp.added : [];
    writeOddState(opts.statePath, { ...state, mcp: { ...state.mcp, added: [...new Set([...prev, ...added])] } });
  }
  return { results };
}

/** Removes only the servers recorded as added by us; failures are reported and the server stays recorded. */
export async function removeMcp(opts: { runner: McpRunner; env?: NodeJS.ProcessEnv; statePath: string }): Promise<{ results: McpResult[] }> {
  const state = readOddState(opts.statePath);
  const recorded = Array.isArray(state.mcp?.added) ? state.mcp.added : [];
  const results: McpResult[] = [];
  const left: string[] = [];
  for (const name of recorded) {
    const r = await run(opts.runner, removeArgv(name), opts.env);
    if (r.code === 0) results.push({ name, status: "removed", detail: "removed from user scope" });
    else {
      left.push(name);
      results.push({ name, status: "failed", detail: text(r) });
    }
  }
  if (recorded.length > 0) writeOddState(opts.statePath, { ...state, mcp: { ...state.mcp, added: left } });
  return { results };
}
