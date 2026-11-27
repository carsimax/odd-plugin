// `node dist/cli/status.js [--json] [--session <id>] [--data-dir <dir>]`. Read-only; always exits 0.
import { collectStatus, renderStatus, type StatusDeps } from "../lib/status.js";
import { envWithDataDir, flagValue, realHookEvents, runMain } from "../lib/system.js";
import { pluginVersion } from "../lib/version.js";

export function statusCli(argv: string[], deps: Omit<StatusDeps, "sessionId">): { exitCode: number; stdout: string } {
  const report = collectStatus({ ...deps, env: envWithDataDir(argv, deps.env), sessionId: flagValue(argv, "--session") });
  return { exitCode: 0, stdout: argv.includes("--json") ? JSON.stringify(report, null, 2) : renderStatus(report) };
}

const main = () => statusCli(process.argv.slice(2), { pluginVersion: pluginVersion(), env: process.env, hooks: () => realHookEvents() ?? [] });

runMain(import.meta.url, main);
