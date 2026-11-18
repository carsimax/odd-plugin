// `node dist/cli/status.js [--json] [--session <id>] [--data-dir <dir>]`. Read-only; always exits 0.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectStatus, renderStatus, type StatusDeps } from "../lib/status.js";
import { envWithDataDir, flagValue } from "../lib/system.js";
import { pluginVersion } from "../lib/version.js";

export function statusCli(argv: string[], deps: Omit<StatusDeps, "sessionId">): { exitCode: number; stdout: string } {
  const report = collectStatus({ ...deps, env: envWithDataDir(argv, deps.env), sessionId: flagValue(argv, "--session") });
  return { exitCode: 0, stdout: argv.includes("--json") ? JSON.stringify(report, null, 2) : renderStatus(report) };
}

function registeredHooks(): string[] {
  try {
    const raw = JSON.parse(readFileSync(new URL("../../hooks/hooks.json", import.meta.url), "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    return Object.keys(raw.hooks ?? {});
  } catch {
    return [];
  }
}

function main(): void {
  const res = statusCli(process.argv.slice(2), { pluginVersion: pluginVersion(), env: process.env, hooks: registeredHooks });
  process.stdout.write(res.stdout + "\n");
}

try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
} catch {
  // fall through: importing must never throw
}
