// Test helpers: a fake `claude` that logs its argv and a selected environment, optionally edits the workspace, and prints canned stream-json. No model runs.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalTask } from "./tasks.js";

/** Overrides for the proof messages the fake emits (init + hook_response); `{}` = behave like the real CLI would for the given argv and seeded state. */
export interface FakeProof { plugins?: { name: string; source: string }[]; output_style?: string; delegation?: string | null }
export interface FakePlan { logFile: string; stdout?: string; exitCode?: number; edits?: Record<string, string>; sleepMs?: number; proof?: FakeProof }

export function installFakeClaude(dir: string, plan: FakePlan): string {
  const file = join(dir, "fake-claude");
  writeFileSync(file, `#!${process.execPath}
const fs = require("node:fs");
const plan = ${JSON.stringify(plan)};
const keys = ["HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_DATA", "ANTHROPIC_API_KEY", "SECRET_PARENT_VAR"];
const env = {}; for (const k of keys) env[k] = process.env[k] === undefined ? null : process.env[k];
let delegation = null;
try { delegation = fs.readFileSync(require("node:path").join(process.env.CLAUDE_CONFIG_DIR, "plugins", "data", "odd-claude-inline", "delegation.json"), "utf8"); } catch {}
const argv = process.argv.slice(2);
let pluginJson = null;
const pdi = argv.indexOf("--plugin-dir");
if (pdi >= 0) { try { pluginJson = fs.readFileSync(require("node:path").join(argv[pdi + 1], ".claude-plugin", "plugin.json"), "utf8"); } catch {} }
fs.appendFileSync(plan.logFile, JSON.stringify({ argv, cwd: process.cwd(), env, delegation, pluginJson }) + "\\n");
let pre = "";
if (plan.proof) {
  const o = plan.proof, hasPlugin = pdi >= 0;
  let style = "default"; const si = argv.indexOf("--settings");
  if (si >= 0) { try { style = JSON.parse(argv[si + 1]).outputStyle || style; } catch {} }
  let mode = null; if (delegation) { try { mode = JSON.parse(delegation).data.mode; } catch {} }
  const init = { type: "system", subtype: "init", plugins: hasPlugin ? [{ name: "odd-claude", path: "/x", source: "odd-claude@inline" }] : [], output_style: style };
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
export function goodStream(cost = 0.5): string {
  const lines = [
    { type: "system", subtype: "init" },
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Agent", input: {} }, { type: "tool_use", id: "t2", name: "Read", input: {} }] } },
    { type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "tool_use", id: "t3", name: "Task", input: {} }] } },
    { type: "result", subtype: "success", is_error: false, num_turns: 7, duration_ms: 1234, total_cost_usd: cost, modelUsage: {
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

/** Minimal plugin dir shaped like plugins/odd-claude: a manifest with a `dependencies` key plus one payload file. */
export const FAKE_PLUGIN_JSON = { name: "odd-claude", version: "0.0.0", dependencies: ["engram@engram"] };
export function makeFakePlugin(dir: string): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(FAKE_PLUGIN_JSON, null, 2) + "\n");
  writeFileSync(join(dir, "payload.txt"), "x\n");
}
