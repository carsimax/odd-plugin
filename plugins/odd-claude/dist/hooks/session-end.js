import { recordAgentStatus } from "../lib/agent-status.js";
import { removeSessionScratch } from "../lib/scratch.js";
import { logError } from "../lib/state.js";
import { CLEAR_TITLE } from "../lib/terminal.js";
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/**
 * SessionEnd: removes only this session's scratch dir (R56), marks the status file `ended` (R70), clears the
 * terminal title (R62) and prints the resume hint (R64) except after `/clear`. Advisory output only.
 */
export function sessionEnd(input, opts = {}) {
    const id = typeof input.session_id === "string" ? input.session_id : "";
    if (id !== "") {
        try {
            const r = removeSessionScratch(id, opts);
            if (r === "refused")
                logError(`SessionEnd scratch: refused to remove an unsafe path for session ${id}`, opts);
        }
        catch (err) {
            logError(`SessionEnd scratch: ${err instanceof Error ? err.message : String(err)}`, opts);
        }
        recordAgentStatus(input, "ended", opts);
    }
    const out = { terminalSequence: CLEAR_TITLE };
    if (SAFE_ID.test(id) && input.reason !== "clear") {
        out.systemMessage = `odd-claude: resume this session with \`claude --resume ${id}\``;
        // Headless runs do not show SessionEnd output, so the hint is also logged.
        logError(`SessionEnd: resume with: claude --resume ${id}`, opts);
    }
    return out;
}
