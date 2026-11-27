// The ONLY place that maps ODD_IMPL to entry commands (CLI by name, hook runner, MCP review server, scripts). Contract specs spawn
// products through `entry`/`run` and never build a path to a product file themselves.
//   ODD_IMPL=ts (default): the compiled TypeScript product (`dist/`, and `dist-test/mcp/review-server.js` for the server).
//   ODD_IMPL=py: there is no Python entry yet, so resolving any entry throws a message naming it (Phase 2+ fills this table in).
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const IMPL = process.env.ODD_IMPL ?? "ts";

/** <plugin>/dist-test/contract/impl.testkit.js -> <plugin> */
export const PLUGIN_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const VENDOR_ROOT = join(REPO_ROOT, "test-fixtures", "review", "vendor");
export const INTEGRATION_ROOT = join(VENDOR_ROOT, "review-integration");
export const MIRROR_ROOT = join(VENDOR_ROOT, "provider-mirror", "v1.6.0");

export type EntryName = "coordinator" | "setup" | "status" | "review-mode" | "hook-runner" | "review-server" | "check-naming" | "stats" | "retro" | "statusline" | "release-payload" | "bump-version";

export interface Entry {
  command: string;
  args: string[];
}

const NODE = process.execPath;
// The statusline is a bash script: an absolute shell, so a test may scrub PATH (the missing-jq fallback).
const TS_ENTRIES: Record<EntryName, Entry> = {
  coordinator: { command: NODE, args: [join(PLUGIN_ROOT, "dist", "cli", "coordinator.js")] },
  setup: { command: NODE, args: [join(PLUGIN_ROOT, "dist", "cli", "setup.js")] },
  status: { command: NODE, args: [join(PLUGIN_ROOT, "dist", "cli", "status.js")] },
  "review-mode": { command: NODE, args: [join(PLUGIN_ROOT, "dist", "cli", "review-mode.js")] },
  "hook-runner": { command: NODE, args: [join(PLUGIN_ROOT, "dist", "hooks", "run.js")] },
  "review-server": { command: NODE, args: [join(PLUGIN_ROOT, "dist-test", "mcp", "review-server.js")] },
  "check-naming": { command: NODE, args: [join(PLUGIN_ROOT, "scripts", "check-naming.mjs")] },
  stats: { command: NODE, args: [join(PLUGIN_ROOT, "dist", "cli", "stats.js")] },
  retro: { command: NODE, args: [join(PLUGIN_ROOT, "dist", "cli", "retro.js")] },
  statusline: { command: "/bin/bash", args: [join(PLUGIN_ROOT, "statusline", "statusline.sh")] },
  "release-payload": { command: NODE, args: [join(PLUGIN_ROOT, "scripts", "release-payload.mjs")] },
  "bump-version": { command: NODE, args: [join(PLUGIN_ROOT, "scripts", "bump-version.mjs")] },
};

/**
 * The command that runs entry `name`. `preload` loads the kill -9 injector (crash tests) into the review server; it is a TS-only seam
 * (a Python port injects its crashes its own way), so it is only honoured for `review-server`.
 */
export function entry(name: EntryName, opts: { preload?: boolean } = {}): Entry {
  if (IMPL === "py") throw new Error(`ODD_IMPL=py: no Python entry for "${name}" yet`);
  if (IMPL !== "ts") throw new Error(`ODD_IMPL=${IMPL}: unknown implementation (expected ts or py), cannot resolve entry "${name}"`);
  const args = [...TS_ENTRIES[name].args];
  if (opts.preload === true) {
    if (name !== "review-server") throw new Error(`the kill preload only applies to "review-server", not "${name}"`);
    args.unshift("--import", pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "kill-preload.testkit.js")).href);
  }
  return { command: TS_ENTRIES[name].command, args };
}

/** Runs entry `name` to completion with `args` appended. */
export function run(name: EntryName, args: string[], opts: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {}): SpawnSyncReturns<string> {
  const e = entry(name);
  return spawnSync(e.command, [...e.args, ...args], { encoding: "utf8", ...opts });
}
