import { join } from "node:path";
import { recordAgentStatus } from "../lib/agent-status.js";
import { oddClaudeRoot } from "../lib/root.js";
import { logError, updateSessionState, type StateOptions } from "../lib/state.js";
import { shellQuote } from "../review/consent.js";
import { isGlobalModeOn, readReviewMode } from "../review/mode.js";
import { findDueCandidate, GIT_MS } from "../review/due.js";
import { resolveRepository } from "../review/snapshot.js";
import type { StartTarget } from "../review/start.js";
import type { StatusEnvelope } from "../review/status.js";
import type { HookInput, HookOutput } from "./run.js";

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
export function stop(input: HookInput, opts: StateOptions = {}): HookOutput | undefined {
  recordAgentStatus(input, "idle", opts);
  try {
    return settleReminder(input, opts);
  } catch (err) {
    logError(`Stop settle: ${err instanceof Error ? err.message : String(err)}`, opts);
    return undefined;
  }
}

const pluginRoot = (opts: StateOptions): string => oddClaudeRoot(opts.env ?? process.env);

function reminderText(root: string, status: StatusEnvelope, target: StartTarget, opts: StateOptions): string {
  const modeCommand = (verb: string): string => `node ${shellQuote(join(pluginRoot(opts), "dist", "cli", "review-mode.js"))} ${verb}`;
  const range = target.kind === "base-diff" ? ` The candidate is the committed range from base-ref ${target.baseRef} to HEAD (committed-only).` : "";
  return [
    `Review-driven development is enabled for this repository, and it holds an unreviewed candidate (target_identity ${status.target_identity}).${range}`,
    "By the review entry rule, call the review_status tool of the odd-claude review tools (MCP server `odd-review`; Claude Code lists it as mcp__odd-review__review_status) for this repository and route only from the next_transition it returns before reporting completion; never infer a command from prose or a stale reply.",
    "The START that status offers names review_start: call it with the arguments status gives, unchanged and never edited. It always relays consent and never answers it.",
    "If review_start returns a consent envelope, relay it to the human losslessly and never answer it on the human's behalf: only the human's explicit answer goes to review_answer_consent.",
    "This hook never runs review start itself, and it reminds once per session and candidate.",
    `To turn review-driven development off, the human can run: ${modeCommand("disable")} (user-wide), or ${modeCommand(`disable --scope clone --cwd ${shellQuote(root)}`)} (this repository only).`,
  ].join("\n");
}

/** The Stop reminder proper (exported for the lazy entry, `lazy.ts`, which loads this module only when the global RDD switch is on). */
export function settleReminder(input: HookInput, opts: StateOptions): HookOutput | undefined {
  if (input.stop_hook_active === true) return undefined;
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
  const session = typeof input.session_id === "string" && SAFE_SESSION.test(input.session_id) ? input.session_id : undefined;
  // Without a session id the "once" guarantee cannot be kept, so there is no reminder at all.
  if (cwd === undefined || session === undefined) return undefined;
  // Fast path: a clone override can only disable, so a global switch that is not on means off everywhere: no git.
  if (!isGlobalModeOn(opts)) return undefined;
  if (readReviewMode(cwd, { ...opts, gitTimeoutMs: GIT_MS }).effective !== "on") return undefined;
  const root = resolveRepository(cwd, { gitTimeoutMs: GIT_MS }).root;
  const found = findDueCandidate(root);
  if (found === undefined) return undefined;

  // Claim the candidate under the session lock before printing: two concurrent Stops cannot both remind.
  let claimed = false;
  updateSessionState(
    session,
    (current) => {
      const seen = Array.isArray(current[REMINDED_KEY]) ? (current[REMINDED_KEY] as unknown[]).filter((x): x is string => typeof x === "string") : [];
      if (seen.includes(found.status.target_identity)) return current;
      claimed = true;
      return { ...current, [REMINDED_KEY]: [...seen, found.status.target_identity].slice(-MAX_REMINDED) };
    },
    opts,
  );
  if (!claimed) return undefined;
  return { decision: "block", reason: reminderText(root, found.status, found.target, opts) };
}
