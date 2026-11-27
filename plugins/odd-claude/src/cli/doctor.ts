// `node dist/cli/doctor.js [--json] [--data-dir <dir>]`. Exit 1 when a required item is missing.
import { collectDoctor, renderDoctor, type DoctorDeps } from "../lib/doctor.js";
import { pluginVersion } from "../lib/version.js";
import { envWithDataDir, realExec, realHooksInstalled, realInstalledPlugins, realInstalledVersion, realIsWritable, runMain } from "../lib/system.js";

export function doctorCli(argv: string[], deps: DoctorDeps): { exitCode: number; stdout: string } {
  const report = collectDoctor({ ...deps, env: envWithDataDir(argv, deps.env) });
  const stdout = argv.includes("--json") ? JSON.stringify(report, null, 2) : renderDoctor(report);
  return { exitCode: report.ok ? 0 : 1, stdout };
}

function main(): { exitCode: number; stdout: string } {
  return doctorCli(process.argv.slice(2), {
    exec: realExec,
    env: process.env,
    nodeVersion: process.version,
    version: pluginVersion(),
    installedPlugins: realInstalledPlugins,
    installedVersion: realInstalledVersion,
    hooksInstalled: realHooksInstalled,
    isWritable: realIsWritable,
  });
}

runMain(import.meta.url, main);
