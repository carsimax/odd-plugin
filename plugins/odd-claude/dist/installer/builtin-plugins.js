// Builtin plugins (`<name>@builtin`) differ per account and Claude Code version, so they are discovered at install
// time with `claude plugin list --json`, never hardcoded. Managed-scope entries and the security guard are protected.
import { defaultRunner } from "./mcp.js";
export const SECURITY_GUARD_ID = "cc-plugin-sec-default@builtin";
export async function discoverBuiltinPlugins(runner = defaultRunner, env) {
    let r;
    try {
        r = await runner("claude", ["plugin", "list", "--json"], { env });
    }
    catch (err) {
        return { ok: false, error: `claude plugin list failed: ${err.message}` };
    }
    if (r.code !== 0)
        return { ok: false, error: `claude plugin list failed: ${(r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split("\n")[0]}` };
    let parsed;
    try {
        parsed = JSON.parse(r.stdout);
    }
    catch {
        return { ok: false, error: "claude plugin list --json did not return valid JSON" };
    }
    if (!Array.isArray(parsed))
        return { ok: false, error: "claude plugin list --json did not return a list" };
    const plugins = [];
    for (const e of parsed) {
        if (typeof e !== "object" || e === null)
            continue;
        const { id, scope, enabled } = e;
        if (typeof id !== "string" || !id.endsWith("@builtin"))
            continue;
        plugins.push({
            id,
            scope: typeof scope === "string" ? scope : undefined,
            enabled: typeof enabled === "boolean" ? enabled : undefined,
            protected: scope === "managed" || id === SECURITY_GUARD_ID,
        });
    }
    return { ok: true, plugins };
}
export function builtinPluginChanges(discovered, selection) {
    const result = { changes: [], unknown: [], protectedSkipped: [] };
    if (selection.mode === "keep")
        return result;
    const disable = (p) => void result.changes.push({ path: ["enabledPlugins", p.id], value: false });
    if (selection.mode === "all") {
        for (const p of discovered)
            if (!p.protected)
                disable(p);
        return result;
    }
    const byId = new Map(discovered.map((p) => [p.id, p]));
    for (const id of new Set(selection.ids)) {
        const p = byId.get(id);
        if (!p)
            result.unknown.push(id);
        else if (p.protected)
            result.protectedSkipped.push(id);
        else
            disable(p);
    }
    return result;
}
