import { recordAgentStatus } from "../lib/agent-status.js";
/**
 * R70: marks the session idle in the status file. The output is always empty: a Stop hook that prints
 * anything can make Claude Code continue the conversation, and this plugin never forces continuation.
 */
export function stop(input, opts = {}) {
    recordAgentStatus(input, "idle", opts);
    return undefined;
}
