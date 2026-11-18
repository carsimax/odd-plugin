import { updateSessionState } from "../lib/state.js";
/** Records the session start in state; emits no output (no context policy yet). */
export function sessionStart(input, opts = {}) {
    if (typeof input.session_id !== "string" || input.session_id === "")
        return undefined;
    updateSessionState(input.session_id, (s) => ({
        ...s,
        startedAt: new Date().toISOString(),
        source: typeof input.source === "string" ? input.source : null,
    }), opts);
    return undefined;
}
