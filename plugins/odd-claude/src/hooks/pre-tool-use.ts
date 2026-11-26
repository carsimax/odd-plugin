import { advisoryNotice } from "../lib/advisory-notices.js";
import { deliveryNotice } from "../review/gate.js";
import type { StateOptions } from "../lib/state.js";
import type { HookInput, HookOutput } from "./run.js";

/**
 * PreToolUse notices, all advisory: the RDD delivery notice (Bash `git push`, `gh pr create|merge`, with RDD on and an unreviewed
 * candidate) and the S4a/S4b notices of `lib/advisory-notices.ts`. They combine into ONE additionalContext. It never denies, asks
 * or blocks: the call always runs, and in every other case (or on any failure) the output is empty. Only the Stop settle reminder may block.
 */
export function preToolUse(input: HookInput, opts: StateOptions = {}): HookOutput | undefined {
  const notices = [deliveryOf(input, opts), advisoryNotice(input, opts)].filter((n): n is string => n !== undefined);
  if (notices.length === 0) return undefined;
  const notice = notices.join("\n\n");
  return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: notice } };
}

function deliveryOf(input: HookInput, opts: StateOptions): string | undefined {
  if (input.tool_name !== "Bash") return undefined;
  const toolInput = input.tool_input;
  const command = toolInput !== null && typeof toolInput === "object" ? (toolInput as Record<string, unknown>).command : undefined;
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
  if (typeof command !== "string" || cwd === undefined) return undefined;
  return deliveryNotice({ cwd, command }, opts);
}
