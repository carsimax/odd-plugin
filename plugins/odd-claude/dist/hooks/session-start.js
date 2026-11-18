import { homedir } from "node:os";
import { logError, updateSessionState } from "../lib/state.js";
import { readBackgroundSubagents } from "../lib/background-subagents.js";
import { realIntegrationDeps, runSessionIntegrations } from "../lib/session-integrations.js";
import { buildSessionContext, readDelegationMode, resolveCardsDir } from "../lib/context.js";
import { readPersona } from "../lib/persona.js";
import { recordAgentStatus } from "../lib/agent-status.js";
import { createSessionScratch, sweepStaleTombstones } from "../lib/scratch.js";
import { titleSequence } from "../lib/terminal.js";
import { refreshStatuslineShim } from "../lib/setup-fs.js";
import { bannerEnabled, bannerText } from "../lib/banner.js";
import { pluginVersion } from "../lib/version.js";
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
    // After a plugin update the root moves: keep an existing statusLine shim (see /odd-claude:setup) pointing at it.
    const shimData = opts.dataDir ?? env.CLAUDE_PLUGIN_DATA;
    if (shimData && env.CLAUDE_PLUGIN_ROOT)
        refreshStatuslineShim(shimData, env.CLAUDE_PLUGIN_ROOT);
    const scratchLines = [];
    if (typeof input.session_id === "string" && input.session_id !== "") {
        sweepStaleTombstones(opts);
        try {
            const dir = createSessionScratch(input.session_id, opts);
            scratchLines.push(`Session scratch dir (R56): ${dir}. Use it for throwaway files; it is removed when the session ends. \`/odd-claude:scratch\` shows it.`);
        }
        catch (err) {
            logError(`SessionStart scratch: ${err instanceof Error ? err.message : String(err)}`, opts);
        }
    }
    recordAgentStatus(input, "idle", opts);
    // Detached registry refresh + trusted codegraph warm-up only when the host reports a project dir (never in tests without cwd).
    const extraLines = typeof input.cwd === "string" && input.cwd !== ""
        ? runSessionIntegrations(input.cwd, realIntegrationDeps(env.HOME || homedir(), env, (m) => logError(m, opts), opts)).extraLines
        : [];
    const additionalContext = buildSessionContext({
        persona: readPersona(opts),
        delegationMode: readDelegationMode(opts),
        cardsDir: resolveCardsDir(env),
        backgroundSubagents: readBackgroundSubagents(opts),
        extraLines: [...scratchLines, ...extraLines],
    });
    const out = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext }, terminalSequence: titleSequence(typeof input.cwd === "string" ? input.cwd : undefined) };
    // R45: the banner is a user-facing systemMessage (never model context), only on a fresh startup, opt-out via env or state.
    if (input.source === "startup" && bannerEnabled(opts)) {
        try {
            out.systemMessage = bannerText(pluginVersion());
        }
        catch {
            // no version: no banner
        }
    }
    return out;
}
