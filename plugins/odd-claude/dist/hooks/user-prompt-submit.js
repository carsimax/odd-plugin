import { buildPromptAnchor } from "../lib/context.js";
import { logError } from "../lib/state.js";
import { recordAgentStatus } from "../lib/agent-status.js";
import { takeQuotaAdvice } from "../lib/quota.js";
import { recordTranscriptPath } from "../lib/transcript-path.js";
import { resetExploration } from "../lib/exploration-budget.js";
/**
 * Per-turn reply-language anchor (R72): quotes the start of the human's own prompt so the rule
 * survives long sessions and compaction. Silent for slash commands, shell escapes and empty prompts.
 */
export function userPromptSubmit(input, opts = {}) {
    // New turn: reset the per-turn exploration counters (R14). Never affects the output.
    if (typeof input.session_id === "string" && input.session_id !== "") {
        // A lock timeout would skip the reset and leave the turn silenced; retry once before logging and moving on.
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                resetExploration(input.session_id, opts);
                break;
            }
            catch (err) {
                if (attempt === 2)
                    logError(`UserPromptSubmit reset: ${err instanceof Error ? err.message : String(err)}`, opts);
            }
        }
    }
    recordTranscriptPath(input, opts);
    recordAgentStatus(input, "working", opts);
    const advice = typeof input.session_id === "string" && input.session_id !== "" ? takeQuotaAdvice(input.session_id, opts) : undefined;
    const additionalContext = [buildPromptAnchor(input.prompt), advice].filter((p) => p !== undefined).join("\n\n");
    if (additionalContext === "")
        return undefined;
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
}
