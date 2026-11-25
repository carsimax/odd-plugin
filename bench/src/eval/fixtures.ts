// Test helpers: a fake `claude` that logs its argv and a selected environment, optionally edits the workspace, and prints canned stream-json. No model runs.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalTask } from "./tasks.js";

export interface FakePlan { logFile: string; stdout?: string; exitCode?: number; edits?: Record<string, string>; sleepMs?: number }

export function installFakeClaude(dir: string, plan: FakePlan): string {
  const file = join(dir, "fake-claude");
  writeFileSync(file, `#!${process.execPath}
const fs = require("node:fs");
const plan = ${JSON.stringify(plan)};
const keys = ["HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_DATA", "ANTHROPIC_API_KEY", "SECRET_PARENT_VAR"];
const env = {}; for (const k of keys) env[k] = process.env[k] === undefined ? null : process.env[k];
let delegation = null;
try { delegation = fs.readFileSync(require("node:path").join(process.env.CLAUDE_CONFIG_DIR, "plugins", "data", "odd-claude-inline", "delegation.json"), "utf8"); } catch {}
fs.appendFileSync(plan.logFile, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env, delegation }) + "\\n");
for (const [f, c] of Object.entries(plan.edits || {})) { fs.mkdirSync(require("node:path").dirname(f), { recursive: true }); fs.writeFileSync(f, c); }
const go = () => { process.stdout.write(plan.stdout || ""); process.exit(plan.exitCode || 0); };
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
  mkdirSync(join(dir, "hidden", "hidden"), { recursive: true });
  writeFileSync(join(dir, "repo", "test", "visible.test.js"), "// visible\n");
  writeFileSync(join(dir, "repo", "README.md"), "# t\n");
  writeFileSync(join(dir, "hidden", "hidden", "check.sh"), `grep -q fixed src/value.txt\n`);
  const t = { id, kind: "bugfix", size: "small", prompt: `do ${id}`, grade: "sh hidden/check.sh", timeout_s: 30, ...over };
  writeFileSync(join(dir, "task.json"), JSON.stringify(t));
}

export const scratch = (): string => mkdtempSync(join(tmpdir(), "odd-eval-spec-"));
