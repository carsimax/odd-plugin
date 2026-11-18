import { homedir } from "node:os";
import { logError, updateSessionState } from "../lib/state.js";
import { readBackgroundSubagents } from "../lib/background-subagents.js";
import { realIntegrationDeps, runSessionIntegrations } from "../lib/session-integrations.js";
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
    const env = opts.env ?? process.env;
    // Detached registry refresh + trusted codegraph warm-up only when the host reports a project dir (never in tests without cwd).
    const extraLines = typeof input.cwd === "string" && input.cwd !== ""
        ? runSessionIntegrations(input.cwd, realIntegrationDeps(env.HOME || homedir(), env, (m) => logError(m, opts), opts)).extraLines
        : [];
    const additionalContext = buildSessionContext({
        persona: readPersona(opts),
        delegationMode: readDelegationMode(opts),
        cardsDir: resolveCardsDir(env),
        backgroundSubagents: readBackgroundSubagents(opts),
        extraLines,
    });
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } };
}
