import { recordAgentStatus } from "../lib/agent-status.js";
import type { StateOptions } from "../lib/state.js";
import type { HookInput, HookOutput } from "./run.js";

/**
 * R70: marks the session idle in the status file. The output is always empty: a Stop hook that prints
 * anything can make Claude Code continue the conversation, and this plugin never forces continuation.
 */
export function stop(input: HookInput, opts: StateOptions = {}): HookOutput | undefined {
  recordAgentStatus(input, "idle", opts);
  return undefined;
}
