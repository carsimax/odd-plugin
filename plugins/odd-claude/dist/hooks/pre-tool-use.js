import { logError } from "../lib/state.js";
import { checkDelivery, DEFAULT_BUDGET_MS } from "../review/gate.js";
/**
 * RDD delivery gate (U14, decision S3 amending the v0.5 no-deny rule): the ONLY PreToolUse behavior of the plugin,
 * and the only place that builds a permission decision. It acts on Bash commands that deliver work (`git push`,
 * `gh pr create|merge`), only while RDD is on for the repository (`checkDelivery` reads the mode first; any off
 * wins), and only for a high-risk committed range that is neither consumed nor declined. In every other case the
 * output is empty. It never starts a review, never answers consent and never writes authority.
 *
 * Policy on errors: see `review/gate.ts`. With RDD on, an internal error while checking a detected delivery is a
 * refusal (fail closed, like the reference); anything that happens before RDD is known to be on is silent.
 */
/**
 * `ODD_CLAUDE_GATE_BUDGET_MS`: a positive integer that can only SHORTEN the gate's whole-check budget (clamped to
 * `DEFAULT_BUDGET_MS`, which already sits 10 s under the 30 s hook timeout), so it can never push the check past the
 * hook timeout. Anything else is ignored. A shorter budget only makes a slow git fail closed sooner with RDD on.
 */
function gateBudget(opts) {
    const raw = (opts.env ?? process.env).ODD_CLAUDE_GATE_BUDGET_MS;
    if (typeof raw !== "string" || !/^[1-9]\d{0,9}$/.test(raw))
        return undefined;
    return Math.min(Number(raw), DEFAULT_BUDGET_MS);
}
export function preToolUse(input, opts = {}) {
    if (input.tool_name !== "Bash")
        return undefined;
    const toolInput = input.tool_input;
    const command = toolInput !== null && typeof toolInput === "object" ? toolInput.command : undefined;
    const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
    if (typeof command !== "string" || cwd === undefined)
        return undefined;
    let verdict;
    try {
        const budget = gateBudget(opts);
        const gateOpts = budget === undefined ? opts : { ...opts, deadlineMs: budget };
        verdict = checkDelivery({ cwd, command }, gateOpts);
    }
    catch (err) {
        // checkDelivery never throws; if it ever does, RDD could not be shown to be on: stay silent.
        logError(`PreToolUse delivery gate: ${err instanceof Error ? err.message : String(err)}`, opts);
        return undefined;
    }
    if (verdict.allowed)
        return undefined;
    if (verdict.code === "check_failed")
        logError(`PreToolUse delivery gate (fail closed): ${verdict.reason.split("\n")[0]}`, opts);
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason } };
}
