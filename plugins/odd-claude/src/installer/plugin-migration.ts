// Migration from the Claude Code plugin install: detect it, uninstall it through the `claude` CLI (injected runner),
// and carry the persisted state files over to the new data dir without overwriting anything already there.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../lib/state.js";
import type { McpRunner, RunResult } from "./mcp.js";

export type DetectResult = { ok: true; ids: string[] } | { ok: false; error: string };
export interface MigrateResult {
  uninstalled: string[];
  failed: { id: string; error: string }[];
  /** removed | absent (not registered) | skipped (an uninstall failed) | unsupported (list failed) | failed */
  marketplace: "removed" | "absent" | "skipped" | "unsupported" | "failed";
  marketplaceError?: string;
}

const MARKETPLACE = "odd-claude";
export const STATE_FILES = ["profiles.json", "persona.json", "delegation.json", "background-subagents.json", "codegraph-trust.json"];

async function run(runner: McpRunner, args: string[], env: NodeJS.ProcessEnv | undefined): Promise<RunResult> {
  try {
    return await runner("claude", args, { env });
  } catch (err) {
    return { code: null, stdout: "", stderr: (err as Error).message };
  }
}

const firstLine = (r: RunResult): string => (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split("\n")[0];

function entries(json: string): Record<string, unknown>[] | undefined {
  try {
    const v: unknown = JSON.parse(json);
    const list = Array.isArray(v) ? v : v && typeof v === "object" ? ((v as Record<string, unknown>).plugins ?? (v as Record<string, unknown>).marketplaces) : undefined;
    return Array.isArray(list) ? (list.filter((e) => typeof e === "object" && e !== null) as Record<string, unknown>[]) : undefined;
  } catch {
    return undefined;
  }
}

export async function detectOddPlugin(runner: McpRunner, env?: NodeJS.ProcessEnv): Promise<DetectResult> {
  const r = await run(runner, ["plugin", "list", "--json"], env);
  if (r.code !== 0) return { ok: false, error: `claude plugin list --json failed: ${firstLine(r)}` };
  const list = entries(r.stdout);
  if (!list) return { ok: false, error: "claude plugin list --json returned output that is not a JSON list" };
  const ids = list.map((e) => e.id).filter((id): id is string => typeof id === "string" && id.startsWith("odd-claude@"));
  return { ok: true, ids };
}

export async function migrateFromPlugin(runner: McpRunner, ids: string[], env?: NodeJS.ProcessEnv): Promise<MigrateResult> {
  const uninstalled: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of ids) {
    const r = await run(runner, ["plugin", "uninstall", id], env);
    if (r.code === 0) uninstalled.push(id);
    else failed.push({ id, error: firstLine(r) });
  }
  if (failed.length > 0) return { uninstalled, failed, marketplace: "skipped" };
  const list = await run(runner, ["plugin", "marketplace", "list", "--json"], env);
  const known = list.code === 0 ? entries(list.stdout) : undefined;
  if (!known) return { uninstalled, failed, marketplace: "unsupported", marketplaceError: list.code === 0 ? "unparseable marketplace list" : firstLine(list) };
  if (!known.some((e) => e.name === MARKETPLACE || e.id === MARKETPLACE)) return { uninstalled, failed, marketplace: "absent" };
  const rm = await run(runner, ["plugin", "marketplace", "remove", MARKETPLACE], env);
  return rm.code === 0 ? { uninstalled, failed, marketplace: "removed" } : { uninstalled, failed, marketplace: "failed", marketplaceError: firstLine(rm) };
}

/** Candidate plugin data dirs: <home>/.claude/plugins/data/odd-claude-*, sorted. */
export function pluginDataDir(home: string): string[] {
  const base = join(home, ".claude", "plugins", "data");
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("odd-claude-"))
      .map((d) => join(base, d.name))
      .sort();
  } catch {
    return [];
  }
}

/** Copies the persisted state files that are missing in `dataDir`; existing files are never overwritten. */
export function migratePluginState(fromDir: string, dataDir: string): { copied: string[]; skipped: string[] } {
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const name of STATE_FILES) {
    const src = join(fromDir, name);
    if (!existsSync(src)) continue;
    const dest = join(dataDir, name);
    if (existsSync(dest)) {
      skipped.push(name);
      continue;
    }
    atomicWriteFile(dest, readFileSync(src));
    copied.push(name);
  }
  return { copied, skipped };
}
