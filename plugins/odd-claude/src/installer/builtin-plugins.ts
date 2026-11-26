// Builtin plugins (`<name>@builtin`) differ per account and Claude Code version, so they are discovered at install
// time with `claude plugin list --json`, never hardcoded. Managed-scope entries and the security guard are protected.
import { defaultRunner, type McpRunner } from "./mcp.js";
import type { SettingsChange } from "./managed-settings.js";

export interface BuiltinPlugin {
  id: string;
  scope?: string;
  enabled?: boolean;
  protected: boolean;
}
export type DiscoverResult = { ok: true; plugins: BuiltinPlugin[] } | { ok: false; error: string };
export type BuiltinSelection = { mode: "all" } | { mode: "keep" } | { mode: "subset"; ids: string[] };
export interface BuiltinChanges {
  changes: SettingsChange[];
  /** Requested ids that are not discovered builtins. */
  unknown: string[];
  /** Requested ids that are protected and were left alone. */
  protectedSkipped: string[];
}

export const SECURITY_GUARD_ID = "cc-plugin-sec-default@builtin";

export async function discoverBuiltinPlugins(runner: McpRunner = defaultRunner, env?: NodeJS.ProcessEnv): Promise<DiscoverResult> {
  let r;
  try {
    r = await runner("claude", ["plugin", "list", "--json"], { env });
  } catch (err) {
    return { ok: false, error: `claude plugin list failed: ${(err as Error).message}` };
  }
  if (r.code !== 0) return { ok: false, error: `claude plugin list failed: ${(r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split("\n")[0]}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return { ok: false, error: "claude plugin list --json did not return valid JSON" };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "claude plugin list --json did not return a list" };
  const plugins: BuiltinPlugin[] = [];
  for (const e of parsed) {
    if (typeof e !== "object" || e === null) continue;
    const { id, scope, enabled } = e as Record<string, unknown>;
    if (typeof id !== "string" || !id.endsWith("@builtin")) continue;
    plugins.push({
      id,
      scope: typeof scope === "string" ? scope : undefined,
      enabled: typeof enabled === "boolean" ? enabled : undefined,
      protected: scope === "managed" || id === SECURITY_GUARD_ID,
    });
  }
  return { ok: true, plugins };
}

export function builtinPluginChanges(discovered: BuiltinPlugin[], selection: BuiltinSelection): BuiltinChanges {
  const result: BuiltinChanges = { changes: [], unknown: [], protectedSkipped: [] };
  if (selection.mode === "keep") return result;
  const disable = (p: BuiltinPlugin): void => void result.changes.push({ path: ["enabledPlugins", p.id], value: false });
  if (selection.mode === "all") {
    for (const p of discovered) if (!p.protected) disable(p);
    return result;
  }
  const byId = new Map(discovered.map((p) => [p.id, p]));
  for (const id of new Set(selection.ids)) {
    const p = byId.get(id);
    if (!p) result.unknown.push(id);
    else if (p.protected) result.protectedSkipped.push(id);
    else disable(p);
  }
  return result;
}
