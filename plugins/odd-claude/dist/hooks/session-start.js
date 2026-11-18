import { updateSessionState } from "../lib/state.js";
import { buildSessionContext, readDelegationMode, resolveCardsDir } from "../lib/context.js";
import { readPersona } from "../lib/persona.js";
/**
 * Records the session start in state (when a session id and data dir exist) and injects the
 * odd-claude context (persona, delegation mode, cards dir, reply-language rule) as additionalContext.
 * Runs for every source (startup, resume, clear, compact).
 */
export function sessionStart(input, opts = {}) {
    if (typeof input.session_id === "string" && input.session_id !== "") {
        try {
            updateSessionState(input.session_id, (s) => ({
                ...s,
                startedAt: new Date().toISOString(),
                source: typeof input.source === "string" ? input.source : null,
            }), opts);
        }
        catch {
            // no data dir: the context must still be injected
        }
    }
    const additionalContext = buildSessionContext({
        persona: readPersona(opts),
        delegationMode: readDelegationMode(opts),
        cardsDir: resolveCardsDir(opts.env ?? process.env),
    });
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } };
}
