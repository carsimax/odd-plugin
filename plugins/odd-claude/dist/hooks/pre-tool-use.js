import { deliveryNotice } from "../review/gate.js";
/**
 * RDD delivery notice: the only PreToolUse behavior of the plugin. For a Bash command that delivers work (`git push`,
 * `gh pr create|merge`), with RDD on and an unreviewed candidate, it adds ONE advisory notice as additionalContext.
 * It never denies, asks or blocks: the command always runs, and in every other case (or on any failure) the output is
 * empty. Only the Stop settle reminder may block.
 */
export function preToolUse(input, opts = {}) {
    if (input.tool_name !== "Bash")
        return undefined;
    const toolInput = input.tool_input;
    const command = toolInput !== null && typeof toolInput === "object" ? toolInput.command : undefined;
    const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
    if (typeof command !== "string" || cwd === undefined)
        return undefined;
    const notice = deliveryNotice({ cwd, command }, opts);
    return notice === undefined ? undefined : { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: notice } };
}
