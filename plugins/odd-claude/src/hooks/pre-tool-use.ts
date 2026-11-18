// PreToolUse handler for the Bash tool (R21 bash guard + R23 child guard).
// Main thread: destructive/guarded commands -> "ask", hard-deny classes -> "deny".
// Subagents (agent_id / agent_type present, Q3): the same commands -> "deny", no override.
// Returning nothing leaves the normal permission flow untouched. Other tools are not owned here.
import { classifyBashCommand, type GuardDecision } from "../lib/bash-guard.js";
import type { HookInput, HookOutput } from "./run.js";

/** The main thread has `agent_id`/`agent_type` null or absent; any subagent carries at least one. */
export function isSubagentCall(input: HookInput): boolean {
  const present = (v: unknown) => v !== undefined && v !== null && v !== "";
  return present(input.agent_id) || present(input.agent_type);
}

function decision(decision: GuardDecision, reason: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } };
}

export function preToolUse(input: HookInput): HookOutput | undefined {
  if (input.tool_name !== "Bash") return undefined;
  const subagent = isSubagentCall(input);
  const toolInput = input.tool_input;
  const command = typeof toolInput === "object" && toolInput !== null ? (toolInput as { command?: unknown }).command : undefined;
  if (typeof command !== "string") {
    return subagent
      ? decision("deny", "odd-claude child safety blocked a Bash call it could not classify (malformed input).")
      : decision("ask", "odd-claude bash guard could not classify this Bash call (malformed input); confirm before it runs.");
  }
  const verdict = classifyBashCommand(command, { subagent });
  return verdict.decision === "allow" ? undefined : decision(verdict.decision, verdict.reason);
}

/**
 * Used by the dispatcher when the handler throws or stdin is unusable: never silently allow a
 * Bash call that could not be classified. Calls for other tools stay fail-open. Never throws.
 */
export function preToolUseFailSafe(stdin: string): HookOutput | undefined {
  try {
    const input = JSON.parse(stdin) as HookInput;
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("not an object");
    if (typeof input.tool_name === "string" && input.tool_name !== "Bash") return undefined;
    return isSubagentCall(input)
      ? decision("deny", "odd-claude child safety blocked a Bash call because the guard failed.")
      : decision("ask", "odd-claude bash guard failed to classify this Bash call; confirm before it runs.");
  } catch {
    // The caller cannot be told apart from a subagent: take the strict side.
    return decision("deny", "odd-claude bash guard failed and could not read the hook input; the call is blocked.");
  }
}
