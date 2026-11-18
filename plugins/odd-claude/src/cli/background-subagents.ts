// `node dist/cli/background-subagents.js [--action enable|disable|status] [--data-dir <dir>]`
// Without --action (or `status`): prints the effective policy (read-only).
// Exit codes: 0 ok; 1 invalid action; 2 usage error / no data dir.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveBackgroundSubagents, writeBackgroundSubagents } from "../lib/background-subagents.js";
import { envWithDataDir, flagValue } from "../lib/system.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const USAGE = "usage: background-subagents.js [--action enable|disable|status] [--data-dir <dir>]";
const ACTIONS = ["enable", "disable", "status"];

function usageError(message: string): CliResult {
  return { exitCode: 2, stdout: "", stderr: `error: usage: ${message}\n${USAGE}` };
}

export function backgroundSubagentsCli(argv: string[], env: Record<string, string | undefined>): CliResult {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--action" || a === "--data-dir") {
      const v = argv[i + 1];
      if (v === undefined || v === "" || v.startsWith("--")) return usageError(`${a} needs a value`);
      i++;
    } else return usageError(`unknown argument ${a}`);
  }
  const opts = { env: envWithDataDir(argv, env) };
  const action = flagValue(argv, "--action") ?? "status";
  if (!ACTIONS.includes(action)) {
    return { exitCode: 1, stdout: "", stderr: `error: invalid action ${JSON.stringify(action)}; available actions: ${ACTIONS.join(", ")}` };
  }
  if (action !== "status") {
    if (!opts.env.CLAUDE_PLUGIN_DATA) return usageError("no data dir (pass --data-dir or set CLAUDE_PLUGIN_DATA)");
    const policy = writeBackgroundSubagents(action === "enable" ? "on" : "off", opts);
    return { exitCode: 0, stdout: `background subagents set to: ${policy}\nApplies from the next session start (or /clear).`, stderr: "" };
  }
  const r = resolveBackgroundSubagents(opts);
  const note = r.malformed ? " (stored state is malformed: failing closed to off; run enable or disable to repair)" : "";
  return { exitCode: 0, stdout: `background subagents: ${r.policy} (${r.source})${note}\navailable actions: enable, disable, status`, stderr: "" };
}

function main(): void {
  const res = backgroundSubagentsCli(process.argv.slice(2), process.env);
  if (res.stdout !== "") process.stdout.write(res.stdout + "\n");
  if (res.stderr !== "") process.stderr.write(res.stderr + "\n");
  process.exitCode = res.exitCode;
}

try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
} catch {
  // importing must never throw
}
