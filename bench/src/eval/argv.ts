import { isInstalledArm, type Arm } from "./isolation.js";

/** Output style the installer sets in the private settings.json (the installed arms load it through `--setting-sources user`). */
export const ODD_OUTPUT_STYLE = "odd";
export const DEFAULT_TOOLS = ["Agent", "Read", "Edit", "Write", "Glob", "Grep", "Bash"];

/**
 * Native Bash sandbox (https://code.claude.com/docs/en/sandboxing.md): `sandbox.enabled` confines shell writes to the working directory and the per-user temp dir,
 * `autoAllowBashIfSandboxed` runs sandboxed commands without a permission prompt, `allowUnsandboxedCommands: false` removes the unsandboxed retry and
 * `failIfUnavailable` makes claude exit instead of silently running unsandboxed. Identical for every arm.
 */
export const SANDBOX_SETTINGS = { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true } as const;

export interface ArgvInput { prompt: string; arm: Arm; model: string; maxTurns: number; maxBudgetUsd: number; extraTools?: readonly string[] }

/** Argv of one `claude -p` run. Never `--bare` (the installed hooks must run) and never a permission-bypass flag. */
export function buildClaudeArgv(i: ArgvInput): string[] {
  const tools = [...DEFAULT_TOOLS, ...(i.extraTools ?? [])].join(",");
  const argv = [
    "-p", "--output-format", "stream-json", "--verbose", "--model", i.model, "--permission-mode", "dontAsk", "--allowedTools", tools,
    "--max-turns", String(i.maxTurns), "--max-budget-usd", String(i.maxBudgetUsd), "--no-session-persistence", "--setting-sources", i.arm === "skills" || isInstalledArm(i.arm) ? "user" : "",
  ];
  // One --settings argument, the sandbox, for every arm. The installed arms read the rest (hooks, output style) from the private settings.json the installer wrote.
  argv.push("--settings", JSON.stringify({ sandbox: SANDBOX_SETTINGS }));
  argv.push(i.prompt);
  return argv;
}
