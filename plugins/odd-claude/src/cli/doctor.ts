// `node dist/cli/doctor.js [--json] [--data-dir <dir>]`. Exit 1 when a required item is missing.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectDoctor, renderDoctor, type DoctorDeps } from "../lib/doctor.js";
import { pluginVersion } from "../lib/version.js";
import { envWithDataDir, realExec, realHooksInstalled, realInstalledPlugins, realInstalledVersion, realIsWritable } from "../lib/system.js";

export function doctorCli(argv: string[], deps: DoctorDeps): { exitCode: number; stdout: string } {
  const report = collectDoctor({ ...deps, env: envWithDataDir(argv, deps.env) });
  const stdout = argv.includes("--json") ? JSON.stringify(report, null, 2) : renderDoctor(report);
  return { exitCode: report.ok ? 0 : 1, stdout };
}

function main(): void {
  const res = doctorCli(process.argv.slice(2), {
    exec: realExec,
    env: process.env,
    nodeVersion: process.version,
    version: pluginVersion(),
    installedPlugins: realInstalledPlugins,
    installedVersion: realInstalledVersion,
    hooksInstalled: realHooksInstalled,
    isWritable: realIsWritable,
  });
  process.stdout.write(res.stdout + "\n");
  process.exitCode = res.exitCode;
}

try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
} catch {
  // fall through: importing must never throw
}
