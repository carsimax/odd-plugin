// `node dist/cli/skill-registry.js [--cwd <dir>] [--force]`: refresh of <cwd>/.atl/skill-registry.md.
// Without --force the Git-tracked guard and the opt-out apply (same as the hook). Exit codes: 0 written/unchanged; 1 skipped; 2 usage error.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { realGitTracked, realPluginRoots, refreshRegistry, type RefreshDeps } from "../lib/skill-registry.js";
import { lockPath, releaseLock } from "../lib/lock.js";
import { flagValue } from "../lib/system.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const USAGE = "usage: skill-registry.js [--cwd <dir>] [--force]";

export function skillRegistryCli(argv: string[], base: Omit<RefreshDeps, "cwd" | "force"> & { cwd?: string }): CliResult {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd") {
      const v = argv[i + 1];
      if (v === undefined || v === "" || v.startsWith("--")) return { exitCode: 2, stdout: "", stderr: `error: usage: --cwd needs a value\n${USAGE}` };
      i++;
    } else if (argv[i] === "--force") continue;
    else return { exitCode: 2, stdout: "", stderr: `error: usage: unknown argument ${argv[i]}\n${USAGE}` };
  }
  const cwd = flagValue(argv, "--cwd") ?? base.cwd ?? process.cwd();
  const r = refreshRegistry({ ...base, cwd, force: argv.includes("--force") });
  if (r.status === "skipped") {
    return { exitCode: 1, stdout: "", stderr: `skill registry skipped: ${r.reason}${r.warning ? ` (${r.warning})` : ""}` };
  }
  const noun = `${r.skillCount} skill${r.skillCount === 1 ? "" : "s"}`;
  return {
    exitCode: 0,
    stdout: r.status === "written" ? `skill registry: ${noun} written to ${r.registryPath}` : `skill registry: ${noun} unchanged in ${r.registryPath}`,
    stderr: "",
  };
}

function main(): void {
  const home = homedir();
  const res = skillRegistryCli(process.argv.slice(2), {
    home,
    plugins: realPluginRoots(process.env, home),
    env: process.env,
    gitTracked: realGitTracked,
  });
  if (res.stdout !== "") process.stdout.write(res.stdout + "\n");
  if (res.stderr !== "") process.stderr.write(res.stderr + "\n");
  process.exitCode = res.exitCode;
  // Detached SessionStart refreshes hold an in-flight lock (see session-integrations.ts); free it when done.
  const dir = process.env.CLAUDE_PLUGIN_DATA;
  if (dir) releaseLock(lockPath(dir, "registry", flagValue(process.argv.slice(2), "--cwd") ?? process.cwd()), process.pid);
}

try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
} catch {
  // importing must never throw
}
