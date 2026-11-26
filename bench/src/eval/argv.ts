import { isPluginArm, type Arm } from "./isolation.js";

export const ODD_OUTPUT_STYLE = "odd-claude:odd";
export const DEFAULT_TOOLS = ["Agent", "Read", "Edit", "Write", "Glob", "Grep", "Bash"];

/**
 * Native Bash sandbox (https://code.claude.com/docs/en/sandboxing.md): `sandbox.enabled` confines shell writes to the working directory and the per-user temp dir,
 * `autoAllowBashIfSandboxed` runs sandboxed commands without a permission prompt, `allowUnsandboxedCommands: false` removes the unsandboxed retry and
 * `failIfUnavailable` makes claude exit instead of silently running unsandboxed. Identical for every arm.
 */
export const SANDBOX_SETTINGS = { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true } as const;

export interface ArgvInput { prompt: string; arm: Arm; pluginDir: string; model: string; maxTurns: number; maxBudgetUsd: number; extraTools?: readonly string[] }

/** Argv of one `claude -p` run. Never `--bare` (plugin hooks must run) and never a permission-bypass flag. */
export function buildClaudeArgv(i: ArgvInput): string[] {
  const tools = [...DEFAULT_TOOLS, ...(i.extraTools ?? [])].join(",");
  const argv = [
    "-p", "--output-format", "stream-json", "--verbose", "--model", i.model, "--permission-mode", "dontAsk", "--allowedTools", tools,
    "--max-turns", String(i.maxTurns), "--max-budget-usd", String(i.maxBudgetUsd), "--no-session-persistence", "--setting-sources", i.arm === "skills" ? "user" : "",
  ];
  // One --settings argument for every arm: the sandbox, plus the odd output style for plugin arms (it is not active under --setting-sources "" unless set explicitly).
  const settings: Record<string, unknown> = isPluginArm(i.arm) ? { outputStyle: ODD_OUTPUT_STYLE, sandbox: SANDBOX_SETTINGS } : { sandbox: SANDBOX_SETTINGS };
  if (isPluginArm(i.arm)) argv.push("--plugin-dir", i.pluginDir);
  argv.push("--settings", JSON.stringify(settings));
  argv.push(i.prompt);
  return argv;
}
