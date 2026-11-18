import { recordSubagentStart, recordSubagentStop } from "../lib/subagents.js";
import type { StateOptions } from "../lib/state.js";
import type { HookInput, HookOutput } from "./run.js";

/** R09: records the subagent start in session state. Always silent: advisory, never blocks. */
export function subagentStart(input: HookInput, opts: StateOptions = {}): HookOutput | undefined {
  recordSubagentStart(input, opts);
  return undefined;
}

/** R09: marks the subagent as ended. Always silent. */
export function subagentStop(input: HookInput, opts: StateOptions = {}): HookOutput | undefined {
  recordSubagentStop(input, opts);
  return undefined;
}
