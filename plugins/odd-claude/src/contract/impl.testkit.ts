// The ONLY place that maps ODD_IMPL to entry commands (CLI by name, hook runner, MCP review server, scripts). Contract specs spawn
// products through `entry`/`run` and never build a path to a product file themselves.
//   ODD_IMPL=ts (default): the compiled TypeScript product (`dist/`, and `dist-test/mcp/review-server.js` for the server).
//   ODD_IMPL=py: the Python product runs from the repo venv (`.venv/bin/python -m <module>`, the absolute-interpreter shape of the phase 0
//   command-shape spike). Only the entries ported so far are in PY_ENTRIES (phase 3: review-mode, review-server); resolving any other entry
//   throws a message naming it, so a test that needs a later phase's entry fails on exactly that (each later phase adds its rows).
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

export type EntryName = "coordinator" | "setup" | "status" | "review-mode" | "hook-runner" | "review-server" | "check-naming" | "stats" | "retro" | "statusline" | "release-payload" | "bump-version" | "tasks" | "installer";

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
  tasks: { command: NODE, args: [join(PLUGIN_ROOT, "dist", "cli", "tasks.js")] },
  installer: { command: NODE, args: [join(PLUGIN_ROOT, "dist", "installer", "bin.js")] },
};

const PYTHON = join(REPO_ROOT, ".venv", "bin", "python");
const PY_ENTRIES: Partial<Record<EntryName, Entry>> = {
  "review-mode": { command: PYTHON, args: ["-m", "odd_claude.cli.review_mode"] },
  "review-server": { command: PYTHON, args: [join(REPO_ROOT, "src", "odd_claude", "mcp", "__main__.py")] }, // a file path: the contract spec asserts args[0] exists
};

/**
 * The command that runs entry `name`. `preload` loads the kill -9 injector (crash tests) into the review server; it is a TS-only seam
 * (a Python port injects its crashes its own way: tests/mcp/kill_preload.py), so it is only honoured for `review-server`.
 */
export function entry(name: EntryName, opts: { preload?: boolean } = {}): Entry {
  if (IMPL === "py") {
    const py = PY_ENTRIES[name];
    if (py === undefined) throw new Error(`ODD_IMPL=py: no Python entry for "${name}" yet`);
    if (opts.preload === true && name !== "review-server") throw new Error(`the kill preload only applies to "review-server", not "${name}"`);
    // The Python twin of kill-preload.testkit.ts (same ODD_KILL_* contract): a launcher that patches os/shutil in the server process only.
    if (opts.preload === true) return { command: py.command, args: ["-P", join(REPO_ROOT, "tests", "mcp", "kill_preload.py")] };
    return { command: py.command, args: [...py.args] };
  }
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
