import { buildPromptAnchor } from "../lib/context.js";
import type { HookInput, HookOutput } from "./run.js";

/**
 * Per-turn reply-language anchor (R72): quotes the start of the human's own prompt so the rule
 * survives long sessions and compaction. Silent for slash commands, shell escapes and empty prompts.
 */
export function userPromptSubmit(input: HookInput): HookOutput | undefined {
  const additionalContext = buildPromptAnchor(input.prompt);
  if (additionalContext === undefined) return undefined;
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
}
