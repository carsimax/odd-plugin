import { buildPromptAnchor } from "../lib/context.js";
import { logError } from "../lib/state.js";
import { recordAgentStatus } from "../lib/agent-status.js";
import { takeQuotaAdvice } from "../lib/quota.js";
import { recordTranscriptPath } from "../lib/transcript-path.js";
import { resetExploration } from "../lib/exploration-budget.js";
import { allow, revoke, revokeAll } from "../lib/peer-grants.js";
import { isValidSessionId } from "../lib/session-id.js";
// Peer consent (R07 P2): only the human's own prompt, trimmed, equal to exactly one of these forms is a grant command.
const PEER_CMD = /^\/odd-peers (allow|revoke) (\S+)$/;
/** Handles `/odd-peers allow|revoke <id>` / `revoke --all`; undefined when the prompt is not exactly that. */
function peerConsent(input, opts) {
    if (typeof input.prompt !== "string")
        return undefined;
    const m = PEER_CMD.exec(input.prompt.trim());
    if (!m)
        return undefined;
    const [, verb, arg] = m;
    const me = input.session_id;
    if (!isValidSessionId(me))
        return "Peer grant refused: this session has no valid session id. Nothing was changed.";
    try {
        if (verb === "revoke" && arg === "--all") {
            revokeAll(me, opts);
            return `Peer grants revoked: session ${me} accepts messages from nobody.`;
        }
        if (!isValidSessionId(arg))
            return "Peer grant refused: invalid session id (expected 8-64 letters, digits or dashes, starting with a letter or digit). Nothing was changed.";
        if (verb === "allow") {
            allow(me, arg, opts);
            return `Peer grant recorded: session ${me} accepts messages from ${arg}. Run /odd-peers revoke ${arg} to undo; it also ends with this session.`;
        }
        revoke(me, arg, opts);
        return `Peer grant revoked: session ${me} no longer accepts messages from ${arg}.`;
    }
    catch (err) {
        logError(`UserPromptSubmit peers: ${err instanceof Error ? err.message : String(err)}`, opts);
        return `Peer grant refused: ${err instanceof Error ? err.message : "store error"}. Nothing was changed.`;
    }
}
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
    const additionalContext = [buildPromptAnchor(input.prompt), advice, peerConsent(input, opts)].filter((p) => p !== undefined).join("\n\n");
    if (additionalContext === "")
        return undefined;
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
}
