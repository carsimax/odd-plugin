// Installs odd-claude into one run's private config dir with the real installer (plugins/odd-claude/dist/installer), the layout that is distributed.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunDirs } from "./isolation.js";

export const INSTALLER_ENTRY = join("dist", "installer", "orchestrate.js");

/** Error text when the installer source is missing; used by the CLI check and by the installer itself. */
export function installerSourceError(sourceDir: string): string | null {
  const missing = ["package.json", INSTALLER_ENTRY].filter((f) => !existsSync(join(sourceDir, f)));
  return missing.length === 0 ? null : `odd-claude installer source not found at ${sourceDir} (missing ${missing.join(", ")}); build it first: cd plugins/odd-claude && npm ci && npm run build`;
}

export interface InstallContext { sourceDir: string; dirs: RunDirs; env: NodeJS.ProcessEnv; claudeBin: string }

interface Step { status: string; label: string; detail: string }
interface Flow {
  runFullInstall(o: Record<string, unknown>): Promise<{ ok: boolean; steps: Step[] }>;
}

/**
 * `runFullInstall` with `source` = the checkout, `CLAUDE_CONFIG_DIR` and `ODD_CLAUDE_HOME` taken from `ctx.env` (the run's private dirs) and HOME = the run's private home.
 * Off: dependencies (no Engram or codegraph in the isolated home), the status line (no effect in `-p`) and the plugin migration (nothing to migrate).
 * Kept at the defaults: claude.ai sync stays disabled (no login in the private config), and the `@builtin` plugins stay enabled so the arm differs from `none` by odd-claude only.
 * The `claude mcp` calls of the installer run through `claudeBin` with the same private env.
 */
export async function installOdd(ctx: InstallContext): Promise<void> {
  const err = installerSourceError(ctx.sourceDir);
  if (err) throw new Error(err);
  const dist = join(resolve(ctx.sourceDir), "dist", "installer");
  const flow = (await import(pathToFileURL(join(dist, "orchestrate.js")).href)) as Flow;
  const { DEFAULT_EXTRAS } = (await import(pathToFileURL(join(dist, "extras.js")).href)) as { DEFAULT_EXTRAS: Record<string, unknown> };
  const runner = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    const r = spawnSync(cmd === "claude" ? ctx.claudeBin : cmd, args, { env: opts.env ?? ctx.env, encoding: "utf8", timeout: 60_000 });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const result = await flow.runFullInstall({
    env: ctx.env, homedir: ctx.dirs.home, runner, source: resolve(ctx.sourceDir), deps: false, migrate: false,
    extras: { ...DEFAULT_EXTRAS, statusLine: false, builtin: { mode: "keep" } },
  });
  if (!result.ok) throw new Error(`odd-claude install failed: ${result.steps.filter((s) => s.status === "failed").map((s) => `${s.label}: ${s.detail}`).join("; ") || "unknown step"}`);
}
