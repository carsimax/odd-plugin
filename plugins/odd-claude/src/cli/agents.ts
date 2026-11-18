// `node dist/cli/agents.js [--json] [--session <id>] [--data-dir <dir>]`. Read-only; always exits 0.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENTS_SCHEMA, readSubagents, renderSubagents } from "../lib/subagents.js";
import { envWithDataDir, flagValue } from "../lib/system.js";

export function agentsCli(argv: string[], env: Record<string, string | undefined> = process.env): { exitCode: number; stdout: string } {
  const session = flagValue(argv, "--session");
  if (session === undefined) return { exitCode: 0, stdout: "No session id (pass --session <id>); nothing to list." };
  const e = envWithDataDir(argv, env);
  if (!e.CLAUDE_PLUGIN_DATA) return { exitCode: 0, stdout: "No data dir (pass --data-dir <dir> or set CLAUDE_PLUGIN_DATA); nothing to list." };
  const records = readSubagents(session, { env: e });
  const stdout = argv.includes("--json") ? JSON.stringify({ schema: AGENTS_SCHEMA, session, subagents: records }, null, 2) : renderSubagents(records);
  return { exitCode: 0, stdout };
}

function main(): void {
  process.stdout.write(agentsCli(process.argv.slice(2)).stdout + "\n");
}

try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
} catch {
  // importing must never throw
}
