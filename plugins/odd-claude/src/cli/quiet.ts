// `node dist/cli/quiet.js [--action on|off|status] [--data-dir <dir>]`
// Without --action (or `status`): prints the quiet-rendering state (read-only).
// Exit codes: 0 ok; 1 invalid action; 2 usage error / no data dir.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QUIET_MODS_NOTE, quietEnabled, setQuietEnabled } from "../lib/quiet.js";
import { envWithDataDir, flagValue } from "../lib/system.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const USAGE = "usage: quiet.js [--action on|off|status] [--data-dir <dir>]";
const ACTIONS = ["on", "off", "status"];

function usageError(message: string): CliResult {
  return { exitCode: 2, stdout: "", stderr: `error: usage: ${message}\n${USAGE}` };
}

export function quietCli(argv: string[], env: Record<string, string | undefined>): CliResult {
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
    setQuietEnabled(action === "on", opts);
    return { exitCode: 0, stdout: `quiet set to: ${action}\n${QUIET_MODS_NOTE}`, stderr: "" };
  }
  return {
    exitCode: 0,
    stdout: `quiet: ${quietEnabled(opts) ? "on" : "off"}\n${QUIET_MODS_NOTE}\navailable actions: ${ACTIONS.join(", ")}`,
    stderr: "",
  };
}

function main(): void {
  const r = quietCli(process.argv.slice(2), process.env);
  if (r.stdout !== "") process.stdout.write(r.stdout + "\n");
  if (r.stderr !== "") process.stderr.write(r.stderr + "\n");
  process.exitCode = r.exitCode;
}

try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
} catch {
  // importing must never throw
}
