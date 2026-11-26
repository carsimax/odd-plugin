// Real implementations of the injected probes (exec, filesystem). Kept apart from the
// pure logic so tests never touch the machine.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
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

/** Version of the global install behind `<ODD_CLAUDE_HOME or ~/.odd-claude>/current`; undefined when absent or unreadable. */
export function realInstalledVersion(env: Record<string, string | undefined> = process.env): string | undefined {
  try {
    const current = join(env.ODD_CLAUDE_HOME || join(homedir(), ".odd-claude"), "current");
    const v = (JSON.parse(readFileSync(join(realpathSync(current), "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** True when `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json` has a hook command running odd-claude's `dist/hooks/run.js`; undefined when unreadable. */
export function realHooksInstalled(env: Record<string, string | undefined> = process.env): boolean | undefined {
  try {
    const raw = readFileSync(join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json"), "utf8");
    const hooks = (JSON.parse(raw) as { hooks?: Record<string, unknown> }).hooks ?? {};
    return /\/dist\/hooks\/run\.js/.test(JSON.stringify(hooks));
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
