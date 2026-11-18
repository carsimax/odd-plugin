import { classifyStopFailure, recordQuotaFailure } from "../lib/quota.js";
import { logError } from "../lib/state.js";
/**
 * R35 (odd-stop-failure): Claude Code ignores the output and exit code of StopFailure, so this hook is silent.
 * It logs the classified error and, for a recoverable one, arms a single advisory line (`--fallback-model` or
 * `/model`, same provider only) that the next UserPromptSubmit hands to the model while the cooldown runs.
 */
export function stopFailure(input, opts = {}) {
    const error = typeof input.error === "string" ? input.error : undefined;
    const details = typeof input.error_details === "string" ? input.error_details : undefined;
    logError(`StopFailure: ${classifyStopFailure(error, details)} (${error ?? "unknown"})`, opts);
    if (typeof input.session_id === "string" && input.session_id !== "") {
        try {
            recordQuotaFailure(input.session_id, { error, details }, opts);
        }
        catch (err) {
            logError(`StopFailure record: ${err instanceof Error ? err.message : String(err)}`, opts);
        }
    }
    return undefined;
}
