// `node dist/cli/background-subagents.js [--action enable|disable|status] [--data-dir <dir>]`
// Without --action (or `status`): prints the effective policy (read-only).
// Exit codes: 0 ok; 1 invalid action; 2 usage error / no data dir.
import { resolveBackgroundSubagents, writeBackgroundSubagents } from "../lib/background-subagents.js";
import { type CliResult, envWithDataDir, flagValue, runMain } from "../lib/system.js";

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
    const policy = writeBackgroundSubagents(action === "enable" ? "on" : "off", opts);
    return { exitCode: 0, stdout: `background subagents set to: ${policy}\nApplies from the next session start (or /clear).`, stderr: "" };
  }
  const r = resolveBackgroundSubagents(opts);
  const note = r.malformed ? " (stored state is malformed: failing closed to off; run enable or disable to repair)" : "";
  return { exitCode: 0, stdout: `background subagents: ${r.policy} (${r.source})${note}\navailable actions: enable, disable, status`, stderr: "" };
}

const main = (): CliResult => backgroundSubagentsCli(process.argv.slice(2), process.env);

runMain(import.meta.url, main);
