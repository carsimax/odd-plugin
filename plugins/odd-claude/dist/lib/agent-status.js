// Agent status file (R70): <data>/status/<session>.json, rewritten atomically at SessionStart, UserPromptSubmit,
// Stop and SessionEnd so any terminal tool can read what the session is doing. Treat a file older than 30 s as stale.
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, logError, resolveDataDir, safeSegment } from "./state.js";
export const AGENT_STATUS_SCHEMA = "odd-claude.agent-status/v1";
export function agentStatusPath(sessionId, opts = {}) {
    return join(resolveDataDir(opts), "status", `${safeSegment(sessionId)}.json`);
}
/** Atomic private write (0600). Throws when the status dir is a symlink or not a directory. */
export function writeAgentStatus(sessionId, state, cwd, opts = {}) {
    const dir = join(resolveDataDir(opts), "status");
    mkdirSync(resolveDataDir(opts), { recursive: true });
    try {
        const st = lstatSync(dir);
        if (st.isSymbolicLink() || !st.isDirectory())
            throw new Error(`unsafe status dir: ${dir}`);
    }
    catch (err) {
        if (err.code !== "ENOENT")
            throw err;
        mkdirSync(dir, { mode: 0o700 });
    }
    const body = { schema: AGENT_STATUS_SCHEMA, session: sessionId, cwd: cwd ?? null, state, updatedAt: new Date().toISOString() };
    atomicWriteFile(agentStatusPath(sessionId, opts), JSON.stringify(body, null, 2) + "\n", 0o600);
}
/** Hook-side wrapper: needs a session id, never throws, logs a failure. */
export function recordAgentStatus(input, state, opts = {}) {
    if (typeof input.session_id !== "string" || input.session_id === "")
        return;
    try {
        writeAgentStatus(input.session_id, state, typeof input.cwd === "string" ? input.cwd : undefined, opts);
    }
    catch (err) {
        logError(`agent status (${state}): ${err instanceof Error ? err.message : String(err)}`, opts);
    }
}
