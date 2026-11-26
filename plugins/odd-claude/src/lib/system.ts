// Real implementations of the injected probes (exec, filesystem). Kept apart from the
// pure logic so tests never touch the machine.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function realExec(cmd: string, args: string[]): string | undefined {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || r.status !== 0) return undefined;
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
}

/** Read-only: checks the dir, or its nearest existing ancestor when it does not exist yet. */
export function realIsWritable(dir: string): boolean {
  let cur = dir;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
  try {
    accessSync(cur, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Keys of ~/.claude/plugins/installed_plugins.json, or undefined when unreadable. */
export function realInstalledPlugins(): string[] | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8")) as {
      plugins?: Record<string, unknown>;
    };
    return raw.plugins ? Object.keys(raw.plugins) : undefined;
  } catch {
    return undefined;
  }
}

/** Value of `--name <value>` in argv; undefined when absent or empty. */
export function flagValue(argv: string[], name: string): string | undefined {
  const v = argv[argv.indexOf(name) + 1];
  return argv.includes(name) && v !== undefined && v !== "" && !v.startsWith("--") ? v : undefined;
}

/** env with the data dir pinned to `--data-dir` when given (ODD_CLAUDE_DATA wins over every other source; skills pass the substituted path). */
export function envWithDataDir(argv: string[], env: Record<string, string | undefined>): Record<string, string | undefined> {
  const dir = flagValue(argv, "--data-dir");
  return dir === undefined ? env : { ...env, ODD_CLAUDE_DATA: dir };
}
