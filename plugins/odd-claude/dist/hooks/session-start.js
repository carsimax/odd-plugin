import { homedir } from "node:os";
import { logError, updateSessionState } from "../lib/state.js";
import { readBackgroundSubagents } from "../lib/background-subagents.js";
import { realIntegrationDeps, runSessionIntegrations } from "../lib/session-integrations.js";
import { buildSessionContext, readDelegationMode, resolveCardsDir } from "../lib/context.js";
import { readPersona } from "../lib/persona.js";
import { recordAgentStatus } from "../lib/agent-status.js";
import { createSessionScratch, sweepStaleTombstones } from "../lib/scratch.js";
import { titleSequence } from "../lib/terminal.js";
import { profileContextLine } from "../lib/profiles.js";
import { revokeAll } from "../lib/peer-grants.js";
import { isValidSessionId } from "../lib/peers.js";
import { recordCurrentSession } from "../lib/peers-session.js";
import { recordTranscriptPath } from "../lib/stats.js";
import { activeFeatureDocSummary } from "../lib/feature-doc.js";
/**
 * Records the session start in state (when a session id and data dir exist) and injects the
 * odd-claude context (persona, delegation mode, cards dir, reply-language rule) as additionalContext.
 * Runs for every source (startup, resume, clear, compact). On compact and resume it also appends a compact summary of the active
 * feature document (the odd/tasks file naming the current branch), so the work state survives the compaction; fail-soft.
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
    recordTranscriptPath(input, opts);
    // R07: let this session's peers MCP server find its own id (keyed by the Claude Code pid, our parent). Never blocks.
    if (typeof input.session_id === "string" && input.session_id !== "") {
        try {
            recordCurrentSession(input.session_id, process.ppid, opts);
        }
        catch {
            // not a valid peer id or no data dir: the peers tools then answer "unknown"
        }
    }
    // R07 A1: peer consent must not outlive a session that died without SessionEnd (crash, kill -9). A resumed session reuses its
    // session_id, so on startup/resume/clear the grants start closed. `compact` is the same live conversation: its grants stay.
    if (input.source !== "compact" && isValidSessionId(input.session_id)) {
        try {
            revokeAll(input.session_id, opts);
        }
        catch (err) {
            logError(`SessionStart peer grants: ${err instanceof Error ? err.message : String(err)}`, opts);
        }
    }
    const env = opts.env ?? process.env;
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
    const baseContext = buildSessionContext({
        persona: readPersona(opts),
        delegationMode: readDelegationMode(opts),
        cardsDir: resolveCardsDir(env),
        backgroundSubagents: readBackgroundSubagents(opts),
        extraLines: [...scratchLines, ...extraLines, ...[profileContextLine(opts)].filter((l) => l !== undefined)],
    });
    const reinject = (input.source === "compact" || input.source === "resume") && typeof input.cwd === "string" && input.cwd !== "" ? activeFeatureDocSummary(input.cwd) : undefined;
    const additionalContext = reinject ? `${baseContext}\n\n${reinject}` : baseContext;
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext }, terminalSequence: titleSequence(typeof input.cwd === "string" ? input.cwd : undefined) };
}
