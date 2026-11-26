// `odd-claude [command] [flags]`: the non-interactive front end over the orchestrator. The TUI is injected
// (`startTui`) so this module stays free of React and the plain compiled CLI works without it.
import { backupsOf, applyModels, detect, restoreBackupFlow, runFullInstall, runFullUninstall, runRollback, runUpdateFlow, type FullResult, type StepResult } from "./orchestrate.js";
import { extrasFromArgs, parseArgs, selectionFromArgs, usage, type ParsedArgs } from "./args.js";
import type { McpRunner } from "./mcp.js";

export interface CliIo {
  env: Record<string, string | undefined>;
  homedir: string;
  runner: McpRunner;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** stdin and stdout are both terminals. */
  isTty: boolean;
  version: string;
  startTui?: (init: { args: ParsedArgs; io: CliIo }) => Promise<number>;
}

const MARK: Record<StepResult["status"], string> = { ok: "[ok]", skipped: "[skip]", warning: "[warn]", failed: "[FAIL]" };
export const formatStep = (s: StepResult): string => `${MARK[s.status]} ${s.label}${s.detail ? `: ${s.detail}` : ""}`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.stderr(`odd-claude: ${parsed.error}\n\n${usage()}`);
    return 2;
  }
  const a = parsed.args;
  if (a.help) {
    io.stdout(usage());
    return 0;
  }
  if (a.version) {
    io.stdout(`${io.version}\n`);
    return 0;
  }
  if (a.command === undefined) {
    if (io.isTty && io.startTui) return io.startTui({ args: a, io });
    io.stderr(usage());
    return 2;
  }
  let selection;
  try {
    selection = selectionFromArgs(a);
  } catch (e) {
    io.stderr(`odd-claude: ${(e as Error).message}\n`);
    return 2;
  }
  try {
    return await dispatch(a, selection, io);
  } catch (e) {
    io.stderr(`odd-claude: ${(e as Error).message}\n`);
    return 1;
  }
}

function finish(command: string, r: FullResult, a: ParsedArgs, io: CliIo, extra: Record<string, unknown> = {}): number {
  if (a.json) io.stdout(JSON.stringify({ ok: r.ok, command, dryRun: r.dryRun, version: r.version, steps: r.steps, ...(r.summary ? { summary: r.summary } : {}), ...extra }, null, 2) + "\n");
  return r.ok ? 0 : 1;
}

async function dispatch(a: ParsedArgs, selection: ReturnType<typeof selectionFromArgs>, io: CliIo): Promise<number> {
  const base = { env: io.env, homedir: io.homedir, runner: io.runner, dryRun: a.dryRun };
  const print = (s: StepResult): void => {
    if (!a.json) io.stdout(`${formatStep(s)}\n`);
  };
  switch (a.command!) {
    case "install": {
      const r = await runFullInstall({ ...base, source: a.source, selection, extras: extrasFromArgs(a), deps: a.deps, confirmDep: () => a.yes, force: a.force }, print);
      if (!a.json && r.summary) io.stdout(`\n${r.summary}\n`);
      return finish("install", r, a, io);
    }
    case "update":
      return finish("update", await runUpdateFlow({ ...base, force: a.force, selection }, print), a, io);
    case "uninstall":
      return finish("uninstall", await runFullUninstall({ ...base, purge: a.purge }, print), a, io);
    case "rollback":
      return finish("rollback", runRollback({ env: io.env, homedir: io.homedir, to: a.to, selection }, print), a, io);
    case "models": {
      if (!selection) {
        io.stderr("odd-claude: models needs --profile or --model\n");
        return 2;
      }
      return finish("models", applyModels({ env: io.env, homedir: io.homedir, selection }, print), a, io);
    }
    case "backups": {
      if (a.restore !== undefined) return finish("backups", restoreBackupFlow({ env: io.env, homedir: io.homedir, id: a.restore }, print), a, io);
      const backups = backupsOf({ env: io.env, homedir: io.homedir });
      if (a.json) io.stdout(JSON.stringify({ ok: true, command: "backups", backups: backups.map((b) => ({ id: b.id, files: b.files })) }, null, 2) + "\n");
      else io.stdout(backups.length === 0 ? "no backups\n" : backups.map((b) => `${b.id}  ${b.files.length} files`).join("\n") + "\n");
      return 0;
    }
    case "status": {
      const d = await detect({ env: io.env, homedir: io.homedir, runner: io.runner });
      if (a.json) io.stdout(JSON.stringify({ ok: true, command: "status", ...d }, null, 2) + "\n");
      else {
        io.stdout(
          [
            `odd-claude: ${d.installedVersion ? `v${d.installedVersion}` : "not installed"}${d.updateAvailable ? ` (update available: v${d.updateAvailable})` : ""}`,
            `node ${d.node.version}${d.node.ok ? "" : " (needs >= 22)"}`,
            `claude: ${d.claude.present ? d.claude.version ?? "found" : "not found"}`,
            `gh: ${d.gh.present ? (d.gh.authenticated ? "authenticated" : "not authenticated") : "not found"}`,
            `engram: ${d.deps.engram ? "found" : "missing"}, codegraph: ${d.deps.codegraph ? "found" : "missing"}`,
            `profile: ${d.selection.profile}`,
            d.pluginIds && d.pluginIds.length > 0 ? `plugin install found: ${d.pluginIds.join(", ")} (install migrates it)` : "no plugin install found",
          ].join("\n") + "\n",
        );
      }
      return 0;
    }
  }
}
