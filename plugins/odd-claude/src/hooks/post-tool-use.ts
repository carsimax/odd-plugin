import { readDelegationMode } from "../lib/context.js";
import { checkContextBackstop } from "../lib/context-backstop.js";
import { isExplorationTool, recordExploration } from "../lib/exploration-budget.js";
import type { StateOptions } from "../lib/state.js";
import type { HookInput, HookOutput } from "./run.js";

/**
 * R14 exploration budget + R34 context backstop. ADVISORY ONLY: the only output is
 * hookSpecificOutput.additionalContext; it never blocks, asks or denies, and any error is swallowed by run.js.
 * Main thread only (subagent calls carry agent_id/agent_type). The exploration notice needs coordinator mode ON.
 */
export function postToolUse(input: HookInput, opts: StateOptions = {}): HookOutput | undefined {
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || sessionId === "" || typeof input.tool_name !== "string") return undefined;
  if (input.agent_id || input.agent_type) return undefined;
  const full = readDelegationMode(opts) === "full";
  const notices: string[] = [];
  if (isExplorationTool(input.tool_name)) {
    const n = recordExploration(sessionId, input.tool_response, full, opts);
    if (n) notices.push(n);
  }
  const b = checkContextBackstop(sessionId, input.transcript_path, full, opts.env ?? process.env, opts);
  if (b) notices.push(b);
  if (notices.length === 0) return undefined;
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: notices.join("\n\n") } };
}
