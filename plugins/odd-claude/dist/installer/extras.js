// Optional settings.json extras: status line, claude.ai sync switches, builtin plugin disabling.
// Everything goes through applyManagedSettings / restoreManagedSettings, so previous values are recorded and
// uninstall restores exactly these paths (absent keys are removed again).
//
// CLI flags (wired by the TUI task):
//   --no-statusline                 -> statusLine: false
//   --keep-claude-ai-connectors     -> claudeAi.connectors: false
//   --keep-claude-ai-skills         -> claudeAi.skills: false
//   --keep-claude-ai-plugins        -> claudeAi.plugins: false
//   --keep-builtin-plugins          -> builtin: { mode: "keep" }
//   --disable-builtin <id> (repeat) -> builtin: { mode: "subset", ids }
import { applyManagedSettings, readOddState, restoreManagedSettings } from "./managed-settings.js";
import { builtinPluginChanges, discoverBuiltinPlugins } from "./builtin-plugins.js";
import { CLAUDE_AI_DEFAULTS, claudeAiChanges } from "./claude-ai.js";
import { statusLineChanges, STATUSLINE_PATH } from "./statusline.js";
export const DEFAULT_EXTRAS = { statusLine: true, claudeAi: { ...CLAUDE_AI_DEFAULTS }, builtin: { mode: "all" } };
export async function planExtras(input) {
    const { options } = input;
    const changes = [];
    const warnings = [];
    if (options.statusLine)
        changes.push(...statusLineChanges(input.oddRoot));
    changes.push(...claudeAiChanges(options.claudeAi));
    let builtin;
    if (options.builtin.mode !== "keep") {
        builtin = await discoverBuiltinPlugins(input.runner, input.env);
        if (!builtin.ok)
            warnings.push(`builtin plugins skipped: ${builtin.error}`);
        else {
            const b = builtinPluginChanges(builtin.plugins, options.builtin);
            changes.push(...b.changes);
            if (b.unknown.length > 0)
                warnings.push(`unknown builtin plugin ids ignored: ${b.unknown.join(", ")}`);
            if (b.protectedSkipped.length > 0)
                warnings.push(`protected builtin plugin ids left untouched: ${b.protectedSkipped.join(", ")}`);
        }
    }
    return { changes, warnings, builtin };
}
export async function applyExtras(input) {
    const plan = await planExtras(input);
    if (plan.changes.length === 0)
        return plan;
    return { ...plan, settings: applyManagedSettings(input.paths, plan.changes) };
}
const OWNED_ROOTS = new Set([STATUSLINE_PATH[0], "disableClaudeAiConnectors", "syncClaudeAiSkills", "syncClaudeAiPlugins", "enabledPlugins"]);
/** Restores every path owned by the extras (never outputStyle or hook paths). */
export function removeExtras(input) {
    const owned = Object.values(readOddState(input.paths.statePath).settings ?? {})
        .map((o) => o.path)
        .filter((p) => OWNED_ROOTS.has(p[0]));
    return restoreManagedSettings(input.paths, owned);
}
