import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordAgentStatus } from "../lib/agent-status.js";
import { logError, updateSessionState } from "../lib/state.js";
import { shellQuote } from "../review/consent.js";
import { isGlobalModeOn, readReviewMode } from "../review/mode.js";
import { assessCandidate } from "../review/risk.js";
import { resolveRepository, runGit } from "../review/snapshot.js";
import { reviewStatus } from "../review/status.js";
/** Per git command bound inside the hook (hooks.json gives the whole hook 30 s). */
const GIT_MS = 5000;
/** Candidate identities already reminded about, per session (bounded). */
const REMINDED_KEY = "rddStopReminded";
const MAX_REMINDED = 32;
const SAFE_SESSION = /^[A-Za-z0-9._-]{1,128}$/;
/**
 * R70: marks the session idle in the status file.
 *
 * The ONLY thing this hook may ever print is the RDD settle reminder (decision S3, which amends the v0.5 no-deny
 * rule): a single block, only while RDD is ON, only for an unreviewed candidate that status offers to START and the
 * risk assessment says is due, once per session and candidate. In every other case the output is empty, and any
 * failure fails open (silent). It never runs START and never answers a consent question.
 */
export function stop(input, opts = {}) {
    recordAgentStatus(input, "idle", opts);
    try {
        return settleReminder(input, opts);
    }
    catch (err) {
        logError(`Stop settle: ${err instanceof Error ? err.message : String(err)}`, opts);
        return undefined;
    }
}
const offersStart = (s) => s.next_transition.kind === "execute" && s.next_transition.execute?.operation === "review.start";
/** The committed range a clean worktree would review: the branch upstream, else the remote default branch; one merge base, non-empty. */
export function committedRangeBase(cwd) {
    const git = (...args) => {
        try {
            return runGit({ cwd, args, timeoutMs: GIT_MS }).stdout.toString("utf8").trim();
        }
        catch {
            return undefined;
        }
    };
    const head = git("rev-parse", "--verify", "HEAD^{commit}");
    if (!head)
        return undefined;
    const fromRef = (ref) => {
        if (!ref)
            return undefined;
        const bases = (git("merge-base", "--all", head, ref) ?? "").split(/\s+/).filter((x) => x !== "");
        if (bases.length !== 1 || bases[0] === head)
            return undefined;
        return Number(git("rev-list", "--count", `${bases[0]}..${head}`)) > 0 ? bases[0] : undefined;
    };
    return fromRef(git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")) ?? fromRef(git("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"));
}
function findCandidate(root) {
    const opts = { gitTimeoutMs: GIT_MS };
    const workspace = reviewStatus(root, opts);
    if (offersStart(workspace))
        return { target: { kind: "current-changes" }, status: workspace };
    // Only an EMPTY workspace falls back to the committed range; a candidate that is declined, consumed or under review stays silent.
    if (workspace.next_transition.reason_code !== "not_due")
        return undefined;
    const baseRef = committedRangeBase(root);
    if (baseRef === undefined)
        return undefined;
    const target = { kind: "base-diff", baseRef, committedOnly: true };
    const committed = reviewStatus(root, { ...opts, target });
    return offersStart(committed) ? { target, status: committed } : undefined;
}
/** The plugin root: CLAUDE_PLUGIN_ROOT, else two levels above this module (`<root>/dist/hooks/stop.js`). */
function pluginRoot(opts) {
    const fromEnv = (opts.env ?? process.env).CLAUDE_PLUGIN_ROOT;
    return typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : join(fileURLToPath(import.meta.url), "..", "..", "..");
}
function reminderText(root, status, target, opts) {
    const modeCommand = (verb) => `node ${shellQuote(join(pluginRoot(opts), "dist", "cli", "review-mode.js"))} ${verb}`;
    const range = target.kind === "base-diff" ? ` The candidate is the committed range from base-ref ${target.baseRef} to HEAD (committed-only).` : "";
    return [
        `Review-driven development is enabled for this repository, and it holds an unreviewed candidate (target_identity ${status.target_identity}).${range}`,
        "By the review entry rule, call the review_status tool of this plugin's review tools (MCP server `review`; Claude Code lists it as mcp__plugin_odd-claude_review__review_status) for this repository and route only from the next_transition it returns before reporting completion; never infer a command from prose or a stale reply.",
        "The START that status offers names review_start: call it with the arguments status gives, unchanged and never edited. It always relays consent and never answers it.",
        "If review_start returns a consent envelope, relay it to the human losslessly and never answer it on the human's behalf: only the human's explicit answer goes to review_answer_consent.",
        "This hook never runs review start itself, and it reminds once per session and candidate.",
        `To turn review-driven development off, the human can run: ${modeCommand("disable")} (user-wide), or ${modeCommand(`disable --scope clone --cwd ${shellQuote(root)}`)} (this repository only).`,
    ].join("\n");
}
function settleReminder(input, opts) {
    if (input.stop_hook_active === true)
        return undefined;
    const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
    const session = typeof input.session_id === "string" && SAFE_SESSION.test(input.session_id) ? input.session_id : undefined;
    // Without a session id the "once" guarantee cannot be kept, so there is no reminder at all.
    if (cwd === undefined || session === undefined)
        return undefined;
    // Fast path: a clone override can only disable, so a global switch that is not on means off everywhere: no git.
    if (!isGlobalModeOn(opts))
        return undefined;
    if (readReviewMode(cwd, { ...opts, gitTimeoutMs: GIT_MS }).effective !== "on")
        return undefined;
    const root = resolveRepository(cwd, { gitTimeoutMs: GIT_MS }).root;
    const found = findCandidate(root);
    if (found === undefined)
        return undefined;
    const assessed = assessCandidate(root, found.target, { gitTimeoutMs: GIT_MS });
    if (assessed.status !== "assessed" || !assessed.reviewDue || assessed.targetIdentity !== found.status.target_identity)
        return undefined;
    // Claim the candidate under the session lock before printing: two concurrent Stops cannot both remind.
    let claimed = false;
    updateSessionState(session, (current) => {
        const seen = Array.isArray(current[REMINDED_KEY]) ? current[REMINDED_KEY].filter((x) => typeof x === "string") : [];
        if (seen.includes(found.status.target_identity))
            return current;
        claimed = true;
        return { ...current, [REMINDED_KEY]: [...seen, found.status.target_identity].slice(-MAX_REMINDED) };
    }, opts);
    if (!claimed)
        return undefined;
    return { decision: "block", reason: reminderText(root, found.status, found.target, opts) };
}
