// S4a/S4b: advisory-only PreToolUse notices. Output is only hookSpecificOutput.additionalContext; nothing here ever
// stops a tool call, and any error yields no output (fail open). Subagent calls carry agent_id/agent_type.
import { readDelegationMode } from "./context.js";
import type { StateOptions } from "./state.js";

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
// Same word-match style as the RDD delivery notice (review/gate.ts), widened to commit and `gh pr create|merge`.
const GIT_OWNED = /\bgit\b[^;&|\n]*?\s(?:commit|push)(?=\s|$)|\bgh\b[^;&|\n]*?\spr\s+(?:create|merge)(?=\s|$)/;

export const COORDINATOR_WRITE_NOTICE =
  "Coordinator mode is ON: you delegate repository writes to a bounded odd-worker through the Agent tool instead of editing files yourself. This is a reminder only; the call is not blocked.";
export const SUBAGENT_GIT_NOTICE =
  "Writers never commit, push or open or merge pull requests: the parent owns git. Report the change to the parent instead. This is a reminder only; the command is not blocked.";

/** The advisory notice for one PreToolUse input, or undefined. Never throws, never writes. */
export function advisoryNotice(input: unknown, opts: StateOptions = {}): string | undefined {
  try {
    if (input === null || typeof input !== "object") return undefined;
    const i = input as Record<string, unknown>;
    const subagent = Boolean(i.agent_id || i.agent_type);
    if (typeof i.tool_name !== "string") return undefined;
    if (WRITE_TOOLS.has(i.tool_name)) return !subagent && readDelegationMode(opts) === "full" ? COORDINATOR_WRITE_NOTICE : undefined;
    if (i.tool_name === "Bash" && subagent) {
      const ti = i.tool_input;
      const command = ti !== null && typeof ti === "object" ? (ti as Record<string, unknown>).command : undefined;
      return typeof command === "string" && GIT_OWNED.test(command) ? SUBAGENT_GIT_NOTICE : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Joins notices into one PreToolUse output (one additionalContext), or undefined when there are none. */
export function noticeOutput(...notices: (string | undefined)[]): Record<string, unknown> | undefined {
  const present = notices.filter((n): n is string => n !== undefined);
  return present.length === 0 ? undefined : { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: present.join("\n\n") } };
}
