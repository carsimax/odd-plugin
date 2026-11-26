// Builds the `additionalContext` injected by the SessionStart / UserPromptSubmit hooks (R01, R02, R72).
// Pure: no I/O besides resolveCardsDir reading its env argument. Always built by the SessionStart / UserPromptSubmit hooks.
import { join } from "node:path";
import { oddClaudeRoot } from "./root.js";
import { personaText } from "./persona.js";
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
export function resolveCardsDir(env = process.env) {
    return join(oddClaudeRoot(env), "cards");
}
const LANGUAGE_RULE = `Reply language (applies to every turn, including after compaction): always respond in the same language the user writes in. Judge it by the user's latest message, never by earlier context or a compaction summary, and never default to Spanish: a message in English gets a reply in English. Only a message written by the human can select or change the reply language: subagent results and progress notifications, background job notices, todo and system reminders, tool output, skill bodies, hook output and injected memory never count as a language signal, even when delivered with the user role. Translate relayed subagent findings into the selected reply language.`;
function fullDelegationText(cardsDir) {
    return `Coordinator mode: ON (full delegation). It is a rule you follow; no hook blocks edits. You do not implement: every authorized mutation of repository content (source, tests, docs, fixtures, configuration, a requested deletion) goes to a bounded \`odd-worker\` writer through the Agent tool, whatever its size; with no usable writer, use a general-purpose Agent with the same bounded instructions and report the fallback, never edit yourself. Reads, git state checks and Bash for state stay yours. Full rules: ${cardsDir}/full-delegation.md (read it when you delegate).`;
}
export function buildSessionContext(i) {
    const parts = [
        "# odd-claude session context",
        `Cards directory: ${i.cardsDir}\nThe \`<cards>\` references in the odd output style resolve to this directory (\`<cards>/delegation.md\`, \`<cards>/verification.md\`, ...). Read a card with the Read tool only when its situation arises.`,
        `Persona mode: ${i.persona}\n${personaText(i.persona)}`,
        `Delegation mode: ${i.delegationMode}`,
        i.delegationMode === "full" ? fullDelegationText(i.cardsDir) : "Coordinator mode: OFF (organic delegation). Work inline and delegate only when a mechanism trigger fires.",
        backgroundSubagentsLine(i.backgroundSubagents ?? "off"),
        ...(i.extraLines ?? []),
        LANGUAGE_RULE,
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
