// Builds the `additionalContext` injected by the SessionStart / UserPromptSubmit hooks (R01, R02, R72).
// Static protocol lives in the managed CLAUDE.md blocks and the output style; only per-session dynamic lines are built here. Pure: no I/O. Always built by the SessionStart / UserPromptSubmit hooks.
import { readPluginState, writePluginState } from "./state.js";
import { backgroundSubagentsLine } from "./background-subagents.js";
export const DELEGATION_MODES = ["organic", "full"];
/** Coordinator mode ON by default (user decision S4): `full` delegation unless the user switched it off. */
export const DEFAULT_DELEGATION = "full";
/** Plugin-wide state `delegation` ({ mode }); missing, corrupt or unknown reads as the default (full = coordinator ON). */
export function readDelegationMode(opts = {}) {
    try {
        const mode = readPluginState("delegation", opts).mode;
        return DELEGATION_MODES.includes(mode) ? mode : DEFAULT_DELEGATION;
    }
    catch {
        return DEFAULT_DELEGATION;
    }
}
/** Validates then stores; throws on an invalid mode without touching the stored value. */
export function writeDelegationMode(mode, opts = {}) {
    if (!DELEGATION_MODES.includes(mode)) {
        throw new Error(`invalid delegation mode ${JSON.stringify(mode)}; available modes: ${DELEGATION_MODES.join(", ")}`);
    }
    writePluginState("delegation", { mode }, opts);
    return mode;
}
function fullDelegationText() {
    return `Coordinator mode: ON (full delegation). It is a rule you follow; no hook blocks edits. You do not implement: every authorized mutation of repository content (source, tests, docs, fixtures, configuration, a requested deletion) goes to a bounded \`odd-worker\` writer through the Agent tool, whatever its size; with no usable writer, use a general-purpose Agent with the same bounded instructions and report the fallback, never edit yourself. Reads, git state checks and Bash for state stay yours. Full rules: the always-loaded rule \`odd-delegation\` (Coordinator mode ON).`;
}
export function buildSessionContext(i) {
    const parts = [
        "# odd-claude session context",
        i.delegationMode === "full" ? fullDelegationText() : "Coordinator mode: OFF (organic delegation). Work inline and delegate only when a mechanism trigger fires.",
        backgroundSubagentsLine(i.backgroundSubagents ?? "off"),
        ...(i.extraLines ?? []),
    ];
    return parts.filter((p) => p !== "").join("\n\n");
}
const EXCERPT_CHARS = 100;
/** Per-turn anchor quoting the start of the human's own prompt; undefined for prompts that are not human prose. */
export function buildPromptAnchor(prompt) {
    if (typeof prompt !== "string")
        return undefined;
    const collapsed = prompt.replace(/\s+/g, " ").trim();
    if (collapsed === "" || collapsed.startsWith("/") || collapsed.startsWith("!"))
        return undefined;
    const excerpt = collapsed.length <= EXCERPT_CHARS ? collapsed : `${collapsed.slice(0, EXCERPT_CHARS)}…`;
    return `Reply-language anchor: the human's latest message begins "${excerpt}". Reply in the language of that message.`;
}
