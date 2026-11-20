import { logError, type StateOptions } from "../lib/state.js";
import { checkDelivery } from "../review/gate.js";
import type { HookInput, HookOutput } from "./run.js";

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
export function preToolUse(input: HookInput, opts: StateOptions = {}): HookOutput | undefined {
  if (input.tool_name !== "Bash") return undefined;
  const toolInput = input.tool_input;
  const command = toolInput !== null && typeof toolInput === "object" ? (toolInput as Record<string, unknown>).command : undefined;
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
  if (typeof command !== "string" || cwd === undefined) return undefined;
  let verdict;
  try {
    verdict = checkDelivery({ cwd, command }, opts);
  } catch (err) {
    // checkDelivery never throws; if it ever does, RDD could not be shown to be on: stay silent.
    logError(`PreToolUse delivery gate: ${err instanceof Error ? err.message : String(err)}`, opts);
    return undefined;
  }
  if (verdict.allowed) return undefined;
  if (verdict.code === "check_failed") logError(`PreToolUse delivery gate (fail closed): ${verdict.reason.split("\n")[0]}`, opts);
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason } };
}
