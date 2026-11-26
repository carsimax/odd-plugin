// Test helpers: a fake `claude` that logs its argv and a selected environment, optionally edits the workspace, and prints canned stream-json. No model runs.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalTask } from "./tasks.js";

/** Overrides for the proof messages the fake emits (init + hook_response); `{}` = behave like the real CLI would for the given argv and seeded state. */
export interface FakeProof { plugins?: { name: string; source: string }[]; output_style?: string; delegation?: string | null; agents?: string[] }
export interface FakePlan { logFile: string; stdout?: string; exitCode?: number; edits?: Record<string, string>; sleepMs?: number; proof?: FakeProof }

export function installFakeClaude(dir: string, plan: FakePlan): string {
  const file = join(dir, "fake-claude");
  writeFileSync(file, `#!${process.execPath}
const fs = require("node:fs");
const plan = ${JSON.stringify(plan)};
const keys = ["HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_DATA", "ODD_CLAUDE_HOME", "ANTHROPIC_API_KEY", "SECRET_PARENT_VAR"];
const env = {}; for (const k of keys) env[k] = process.env[k] === undefined ? null : process.env[k];
const argv = process.argv.slice(2);
// The installer's \`claude mcp\` calls: logged apart (with the env they ran in), never counted as a session.
if (argv[0] === "mcp") {
  fs.appendFileSync(plan.logFile + ".mcp", JSON.stringify({ argv, env }) + "\\n");
  if (argv[1] === "get") { process.stderr.write("No MCP server found with name: " + argv[2] + "\\n"); process.exit(1); }
  process.exit(0);
}
let delegation = null;
try { delegation = fs.readFileSync(require("node:path").join(process.env.ODD_CLAUDE_HOME || "/nonexistent", "data", "delegation.json"), "utf8"); } catch {}
const cfg = process.env.CLAUDE_CONFIG_DIR, P = require("node:path");
let settings = null; try { settings = JSON.parse(fs.readFileSync(P.join(cfg, "settings.json"), "utf8")); } catch {}
const ls = (d) => { try { return fs.readdirSync(P.join(cfg, d)).sort(); } catch { return null; } };
const installed = { agents: ls("agents"), skills: ls("skills"), claudeMd: fs.existsSync(P.join(cfg, "CLAUDE.md")), settings: settings !== null, outputStyle: settings && settings.outputStyle ? settings.outputStyle : null };
fs.appendFileSync(plan.logFile, JSON.stringify({ argv, cwd: process.cwd(), env, delegation, installed }) + "\\n");
let pre = "";
if (plan.proof) {
  const o = plan.proof;
  // A user-level settings.json is only read under --setting-sources user.
  let style = "default"; if (argv[argv.indexOf("--setting-sources") + 1] === "user" && installed.outputStyle) style = installed.outputStyle;
  let mode = null; if (delegation) { try { mode = JSON.parse(delegation).data.mode; } catch {} }
  const init = { type: "system", subtype: "init", plugins: [], output_style: style };
  init.agents = installed.agents ? installed.agents.map((f) => f.replace(/\\.md$/, "")) : [];
  if (installed.skills) init.skills = installed.skills;
  if ("agents" in o) init.agents = o.agents;
  if ("plugins" in o) init.plugins = o.plugins;
  if ("output_style" in o) init.output_style = o.output_style;
  const lines = [init];
  const dm = "delegation" in o ? o.delegation : mode;
  if (dm) lines.push({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", output: "odd-claude session context\\nDelegation mode: " + dm + "\\nmore", exit_code: 0 });
  pre = lines.map((l) => JSON.stringify(l)).join("\\n") + "\\n";
}
for (const [f, c] of Object.entries(plan.edits || {})) { fs.mkdirSync(require("node:path").dirname(f), { recursive: true }); fs.writeFileSync(f, c); }
const go = () => { process.stdout.write(pre + (plan.stdout || "")); process.exit(plan.exitCode || 0); };
if (plan.sleepMs) setTimeout(go, plan.sleepMs); else go();
`);
  chmodSync(file, 0o755);
  return file;
}

/** stream-json of a successful run: one Agent launch, one subagent-internal launch (ignored), a result with two models. */
export function goodStream(cost = 0.5, denials?: unknown[]): string {
  const lines = [
    { type: "system", subtype: "init" },
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Agent", input: {} }, { type: "tool_use", id: "t2", name: "Read", input: {} }] } },
    { type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "tool_use", id: "t3", name: "Task", input: {} }] } },
    { type: "result", subtype: "success", is_error: false, num_turns: 7, duration_ms: 1234, total_cost_usd: cost, ...(denials ? { permission_denials: denials } : {}), modelUsage: {
      "claude-opus": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 0.4 },
      "claude-haiku": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 0.1 } } },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** Synthetic task in a fresh temp dir: shipped visible test + a hidden test; `grade` passes iff `src/value.txt` says "fixed". */
export function makeTask(tasksDir: string, id: string, over: Partial<EvalTask> = {}): void {
  const dir = join(tasksDir, id);
  mkdirSync(join(dir, "repo", "test"), { recursive: true });
  mkdirSync(join(dir, "hidden"), { recursive: true });
  writeFileSync(join(dir, "repo", "test", "visible.test.js"), "// visible\n");
  writeFileSync(join(dir, "repo", "README.md"), "# t\n");
  writeFileSync(join(dir, "hidden", "check.sh"), `grep -q fixed src/value.txt\n`);
  const t = { id, kind: "bugfix", size: "small", prompt: `do ${id}`, grade: "sh hidden/check.sh", timeout_s: 30, ...over };
  writeFileSync(join(dir, "task.json"), JSON.stringify(t));
}

export const scratch = (): string => mkdtempSync(join(tmpdir(), "odd-eval-spec-"));

/** Where the fake installer records the options it was called with. */
export const FAKE_INSTALL_LOG = "install-calls.jsonl";

/**
 * Minimal installer source shaped like plugins/odd-claude: package.json plus dist/installer/{orchestrate,extras}.js.
 * The fake `runFullInstall` records its options (env subset, homedir, source, flags) in <dir>/install-calls.jsonl and writes the installed layout into
 * CLAUDE_CONFIG_DIR only (agents/odd-worker.md, settings.json with outputStyle "odd"), so a spec can tell where it ran.
 */
export function makeFakeInstallerSource(dir: string, opts: { fail?: boolean } = {}): void {
  const inst = join(dir, "dist", "installer");
  mkdirSync(inst, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "odd-claude", version: "0.0.0", type: "module" }));
  writeFileSync(join(inst, "extras.js"), `export const DEFAULT_EXTRAS = { statusLine: true, claudeAi: { connectors: true, skills: true, plugins: true }, builtin: { mode: "all" } };\n`);
  writeFileSync(join(inst, "orchestrate.js"), `import fs from "node:fs";
import path from "node:path";
export async function runFullInstall(o) {
  const e = o.env;
  fs.appendFileSync(path.join(${JSON.stringify(dir)}, ${JSON.stringify(FAKE_INSTALL_LOG)}), JSON.stringify({
    CLAUDE_CONFIG_DIR: e.CLAUDE_CONFIG_DIR, ODD_CLAUDE_HOME: e.ODD_CLAUDE_HOME, HOME: e.HOME, homedir: o.homedir, source: o.source, deps: o.deps, migrate: o.migrate, extras: o.extras,
  }) + "\\n");
  ${opts.fail ? 'return { ok: false, steps: [{ status: "failed", label: "Install files", detail: "boom" }] };' : `
  fs.mkdirSync(path.join(e.CLAUDE_CONFIG_DIR, "agents"), { recursive: true });
  fs.writeFileSync(path.join(e.CLAUDE_CONFIG_DIR, "agents", "odd-worker.md"), "x\\n");
  fs.writeFileSync(path.join(e.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ outputStyle: "odd" }));
  await o.runner("claude", ["mcp", "add", "-s", "user", "odd-review", "--", "node", "x"], { env: e });
  return { ok: true, steps: [] };`}
}
`);
}
