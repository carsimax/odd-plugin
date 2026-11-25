import type { Arm } from "./isolation.js";

export const DEFAULT_TOOLS = ["Agent", "Read", "Edit", "Write", "Glob", "Grep", "Bash(node *)", "Bash(npm *)", "Bash(git *)"];

export interface ArgvInput { prompt: string; arm: Arm; pluginDir: string; model: string; maxTurns: number; maxBudgetUsd: number; extraTools?: readonly string[] }

/** Argv of one `claude -p` run. Never `--bare` (plugin hooks must run) and never a permission-bypass flag. */
export function buildClaudeArgv(i: ArgvInput): string[] {
  const tools = [...DEFAULT_TOOLS, ...(i.extraTools ?? [])].join(",");
  const argv = [
    "-p", "--output-format", "stream-json", "--verbose", "--model", i.model, "--permission-mode", "dontAsk", "--allowedTools", tools,
    "--max-turns", String(i.maxTurns), "--max-budget-usd", String(i.maxBudgetUsd), "--no-session-persistence", "--setting-sources", "",
  ];
  if (i.arm !== "none") argv.push("--plugin-dir", i.pluginDir);
  argv.push(i.prompt);
  return argv;
}
