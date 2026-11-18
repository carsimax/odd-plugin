import { recordSubagentStart, recordSubagentStop } from "../lib/subagents.js";
/** R09: records the subagent start in session state. Always silent: advisory, never blocks. */
export function subagentStart(input, opts = {}) {
    recordSubagentStart(input, opts);
    return undefined;
}
/** R09: marks the subagent as ended. Always silent. */
export function subagentStop(input, opts = {}) {
    recordSubagentStop(input, opts);
    return undefined;
}
