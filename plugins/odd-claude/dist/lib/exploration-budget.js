// R14 exploration budget, ported from upstream lib/exploration-budget.ts. Upstream keeps the counters in
// memory per request; a Claude Code hook is a fresh process per call, so they live in session state
// (key `exploration`) and UserPromptSubmit resets them per turn. Advisory only: it returns a notice.
import { updateSessionState } from "./state.js";
/** Upstream thresholds: the notice fires once lookups > 3 or text bytes > 40,000. */
export const EXPLORATION_MAX_LOOKUPS = 3;
export const EXPLORATION_MAX_BYTES = 40_000;
const BUILTIN = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
// Both MCP name forms: user-level `codegraph` server and the plugin-bundled one.
const CODEGRAPH = /^mcp__(?:plugin_odd-claude_)?codegraph__/;
export function isExplorationTool(name) {
    return BUILTIN.has(name) || CODEGRAPH.test(name);
}
/** UTF-8 bytes of every string inside a tool response (upstream counts text parts only). */
export function responseTextBytes(value, depth = 0) {
    if (typeof value === "string")
        return Buffer.byteLength(value, "utf8");
    if (depth > 8 || value === null || typeof value !== "object")
        return 0;
    let total = 0;
    // The `type` discriminator ("text", "file") is protocol, not content.
    for (const [k, v] of Object.entries(value))
        if (k !== "type")
            total += responseTextBytes(v, depth + 1);
    return total;
}
function counters(state) {
    const e = state.exploration;
    return {
        lookups: typeof e?.lookups === "number" ? e.lookups : 0,
        bytes: typeof e?.bytes === "number" ? e.bytes : 0,
        notified: e?.notified === true,
    };
}
const n = (v) => v.toLocaleString("en-US");
export function explorationNotice(lookups, bytes) {
    return `Exploration budget: ${n(lookups)} tracked lookups and ${n(bytes)} UTF-8 text bytes (an approximate evidence budget). Ongoing discovery needs one odd-claude:odd-explore subagent (delegate discovery to one odd-explore), even if read-only or initially small. Reading that prepares a writer belongs in that writer's prompt. This is advisory runtime context for the original task, not a new user request; it blocks nothing and grants no mutation authority.`;
}
/** Counts one exploration result; returns the notice once per turn when a threshold is crossed. */
export function recordExploration(sessionId, toolResponse, notify, opts) {
    let notice;
    updateSessionState(sessionId, (s) => {
        const c = counters(s);
        c.lookups++;
        c.bytes += responseTextBytes(toolResponse);
        if (notify && !c.notified && (c.lookups > EXPLORATION_MAX_LOOKUPS || c.bytes > EXPLORATION_MAX_BYTES)) {
            c.notified = true;
            notice = explorationNotice(c.lookups, c.bytes);
        }
        return { ...s, exploration: c };
    }, opts);
    return notice;
}
/** Per-turn reset (UserPromptSubmit). */
export function resetExploration(sessionId, opts) {
    updateSessionState(sessionId, (s) => ({ ...s, exploration: { lookups: 0, bytes: 0, notified: false } }), opts);
}
