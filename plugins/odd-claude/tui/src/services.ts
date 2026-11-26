// What the TUI needs from the installer, behind one interface so the tests drive the screens with fakes.
import type { CliIo } from "../../src/installer/cli.js";
import type { ParsedArgs } from "../../src/installer/args.js";
import { listBackups, type BackupInfo } from "../../src/installer/backup.js";
import { discoverBuiltinPlugins, type DiscoverResult } from "../../src/installer/builtin-plugins.js";
import type { ExtrasOptions } from "../../src/installer/extras.js";
import type { ModelSelection } from "../../src/installer/models.js";
import { applyModels, detect, flowContext, planFullInstall, restoreBackupFlow, runFullInstall, runFullUninstall, runUpdateFlow, type Detection, type FullResult, type OnStep } from "../../src/installer/orchestrate.js";
import type { Flow } from "./router.js";

export interface RunRequest {
  flow: Flow;
  selection: ModelSelection;
  extras: ExtrasOptions;
  /** Install the missing dependencies (the user confirmed on the Dependencies screen). */
  deps: boolean;
  purge: boolean;
  backupId?: string;
}

export interface Services {
  detect(): Promise<Detection>;
  builtins(): Promise<DiscoverResult>;
  /** Dry run for the Review screen: nothing is written. */
  plan(req: RunRequest): Promise<FullResult>;
  run(req: RunRequest, onStep: OnStep): Promise<FullResult>;
  backups(): BackupInfo[];
}

export function createServices(io: CliIo, args: ParsedArgs): Services {
  const base = { env: io.env, homedir: io.homedir, runner: io.runner };
  const install = (req: RunRequest) => ({ ...base, source: args.source, selection: req.selection, extras: req.extras, deps: req.deps, confirmDep: () => req.deps });
  return {
    detect: () => detect(base),
    builtins: () => discoverBuiltinPlugins(io.runner, io.env as NodeJS.ProcessEnv),
    async plan(req) {
      switch (req.flow) {
        case "install":
          return planFullInstall(install(req));
        case "update":
          return runUpdateFlow({ ...base, dryRun: true, force: args.force });
        case "uninstall":
          return runFullUninstall({ ...base, dryRun: true, purge: req.purge });
        default:
          return { ok: true, dryRun: true, version: null, steps: [] };
      }
    },
    async run(req, onStep) {
      switch (req.flow) {
        case "install":
          return runFullInstall(install(req), onStep);
        case "update":
          return runUpdateFlow({ ...base, force: args.force, reapplyInNewVersion: true }, onStep);
        case "models":
          return applyModels({ env: io.env, homedir: io.homedir, selection: req.selection }, onStep);
        case "uninstall":
          return runFullUninstall({ ...base, purge: req.purge }, onStep);
        case "backups":
          return restoreBackupFlow({ env: io.env, homedir: io.homedir, id: req.backupId ?? "" }, onStep);
      }
    },
    backups: () => listBackups(flowContext(base).paths),
  };
}
