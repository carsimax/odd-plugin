// Subagent log (R09): SubagentStart/SubagentStop hook events are recorded in the session state under
// `subagents` (advisory, no output) so `/odd-stats` can count them.
// Claude Code gives the plugin no runner, so this event log is the only source of truth.
import { logError, readSessionState, updateSessionState } from "./state.js";
export const MAX_SUBAGENTS = 50;
function valid(input) {
    return typeof input.session_id === "string" && input.session_id !== "" && typeof input.agent_id === "string" && input.agent_id !== "";
}
function typeOf(input) {
    return typeof input.agent_type === "string" && input.agent_type !== "" ? input.agent_type : "unknown";
}
function isRecord(v) {
    return typeof v === "object" && v !== null && typeof v.id === "string" && typeof v.type === "string";
}
export function readSubagents(sessionId, opts = {}) {
    const raw = readSessionState(sessionId, opts).subagents;
    return Array.isArray(raw) ? raw.filter(isRecord) : [];
}
function update(input, opts, label, change) {
    if (!valid(input))
        return;
    try {
        updateSessionState(input.session_id, (s) => ({ ...s, subagents: change(Array.isArray(s.subagents) ? s.subagents.filter(isRecord) : []).slice(-MAX_SUBAGENTS) }), opts);
    }
    catch (err) {
        logError(`${label}: ${err instanceof Error ? err.message : String(err)}`, opts);
    }
}
/** Never throws; a failure is logged and the hook stays silent. */
export function recordSubagentStart(input, opts = {}, now = Date.now()) {
    update(input, opts, "SubagentStart", (list) => [...list.filter((r) => r.id !== input.agent_id), { id: input.agent_id, type: typeOf(input), startedAt: now }]);
}
export function recordSubagentStop(input, opts = {}, now = Date.now()) {
    update(input, opts, "SubagentStop", (list) => {
        const id = input.agent_id;
        if (list.some((r) => r.id === id))
            return list.map((r) => (r.id === id ? { ...r, endedAt: now } : r));
        return [...list, { id, type: typeOf(input), endedAt: now }];
    });
}
export function formatDuration(ms) {
    const s = Math.floor(Math.max(0, ms) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const p = (n) => String(n).padStart(2, "0");
    if (h > 0)
        return `${h}h${p(m)}m${p(sec)}s`;
    if (m > 0)
        return `${m}m${p(sec)}s`;
    return `${sec}s`;
}
