import { buildPromptAnchor } from "../lib/context.js";
import { logError } from "../lib/state.js";
import { resetExploration } from "../lib/exploration-budget.js";
/**
 * Per-turn reply-language anchor (R72): quotes the start of the human's own prompt so the rule
 * survives long sessions and compaction. Silent for slash commands, shell escapes and empty prompts.
 */
export function userPromptSubmit(input, opts = {}) {
    // New turn: reset the per-turn exploration counters (R14). Never affects the output.
    if (typeof input.session_id === "string" && input.session_id !== "") {
        try {
            resetExploration(input.session_id, opts);
        }
        catch (err) {
            logError(`UserPromptSubmit reset: ${err instanceof Error ? err.message : String(err)}`, opts);
        }
    }
    const additionalContext = buildPromptAnchor(input.prompt);
    if (additionalContext === undefined)
        return undefined;
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
}
