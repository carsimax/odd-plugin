import { findDueCandidate, GIT_MS } from "./due.js";
import { isGlobalModeOn, readReviewMode } from "./mode.js";
import { resolveRepository } from "./snapshot.js";
const DELIVERY_VERB = /\bgit\b[^;&|\n]*?\spush(?=\s|$)|\bgh\b[^;&|\n]*?\spr\s+(?:create|merge)(?=\s|$)/;
const CANDIDATE_CHANGE = /\bgit\b[^;&|\n]*?\s(?:commit|merge|rebase|reset|checkout|switch|cherry-pick|revert|am|pull|update-ref)(?=\s|$)/;
export const UNREVIEWED_DELIVERY_NOTICE = "RDD: this repository has an unreviewed candidate; review it before delivery.";
/** The notice for one Bash command, or undefined. Never throws, never writes. */
export function deliveryNotice(input, opts = {}) {
    try {
        if (!DELIVERY_VERB.test(input.command) || CANDIDATE_CHANGE.test(input.command))
            return undefined;
        // A clone override can only disable, so a global switch that is not on means off everywhere: no git.
        if (!isGlobalModeOn(opts))
            return undefined;
        if (readReviewMode(input.cwd, { ...opts, gitTimeoutMs: GIT_MS }).effective !== "on")
            return undefined;
        const root = resolveRepository(input.cwd, { gitTimeoutMs: GIT_MS }).root;
        return findDueCandidate(root) === undefined ? undefined : UNREVIEWED_DELIVERY_NOTICE;
    }
    catch {
        return undefined; // a notice never blocks or fails the command
    }
}
