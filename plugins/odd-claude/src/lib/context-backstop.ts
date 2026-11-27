// R34 context backstop, adapted from upstream lib/context-backstop.ts (150k-token absolute cap, notice text).
// Pi exposes ctx.getContextUsage(); a Claude Code hook does not (PostToolUse input has session_id,
// transcript_path, cwd, permission_mode, agent_id/agent_type, tool_name/tool_input/tool_response, no usage and
// no window size). So the measurement reads the transcript: the last assistant `usage` line
// (input + cache_creation + cache_read tokens = the prompt the model just saw) (no usage line: no reading, no notice). The window size is unknown, so only the absolute cap applies.
import { statSync } from "node:fs";
import { readTail } from "./transcript-tail.js";
import { readSessionState, updateSessionState, type StateOptions } from "./state.js";

export const CONTEXT_BACKSTOP_TOKENS = 150_000;
export const CONTEXT_BACKSTOP_TOKENS_ENV = "ODD_CLAUDE_CONTEXT_BACKSTOP_TOKENS";
const TAIL_BYTES = 512 * 1024;
/** Once the notice fired only a measured drop (re-arm) matters, so each PostToolUse reads this short tail instead of TAIL_BYTES. */
const FIRED_TAIL_BYTES = 32 * 1024;

type Env = Readonly<Record<string, string | undefined>>;

export function contextBackstopThreshold(env: Env = process.env): number {
  const v = Number(env[CONTEXT_BACKSTOP_TOKENS_ENV]?.trim());
  return Number.isFinite(v) && v > 0 ? v : CONTEXT_BACKSTOP_TOKENS;
}

/** Prompt tokens of the last assistant turn in the transcript tail; undefined when none is found. */
function lastUsageTokens(path: string, max: number = TAIL_BYTES): number | undefined {
  const text = readTail(path, max)?.text;
  if (text === undefined) return undefined;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    try {
      const u = (JSON.parse(lines[i]) as { message?: { usage?: Record<string, unknown> } }).message?.usage;
      if (!u) continue;
      const num = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
      const total = num("input_tokens") + num("cache_creation_input_tokens") + num("cache_read_input_tokens");
      if (total > 0) return total;
    } catch {
      // skip a malformed line
    }
  }
  return undefined;
}

const count = (v: number) => Math.round(v).toLocaleString("en-US");

export function contextBackstopNotice(tokens: number, threshold: number, fullDelegation: boolean): string {
  const tail = fullDelegation
    ? "delegate the next bounded unit with a short handoff, and keep only state checks in this context."
    : "delegate the next bounded unit that needs several steps (its reads, edits, and checks) with a short handoff, while single small edits and state checks stay inline.";
  return `Context backstop: the parent context measures ${count(tokens)} tokens, at or past the ${count(threshold)}-token backstop (advisory, nothing is blocked): ${tail}`;
}

/**
 * One notice per crossing per session (state key `contextBackstop`). A reading below the threshold
 * re-arms it (compaction).
 */
export function checkContextBackstop(
  sessionId: string,
  transcriptPath: unknown,
  fullDelegation: boolean,
  env: Env,
  opts: StateOptions,
): string | undefined {
  if (typeof transcriptPath !== "string" || transcriptPath === "") return undefined;
  const threshold = contextBackstopThreshold(env);
  if (readSessionState(sessionId, opts).contextBackstop === true) {
    // Already fired: nothing can notify until a measured drop re-arms it, so read a short tail and skip the size estimate.
    let tokens: number | undefined;
    try {
      tokens = statSync(transcriptPath).isFile() ? lastUsageTokens(transcriptPath, FIRED_TAIL_BYTES) : undefined;
    } catch {
      tokens = undefined;
    }
    if (tokens !== undefined && tokens < threshold) updateSessionState(sessionId, (s) => (s.contextBackstop === true ? { ...s, contextBackstop: false } : s), opts);
    return undefined;
  }
  let tokens: number | undefined;
  try {
    tokens = lastUsageTokens(transcriptPath);
  } catch {
    tokens = undefined;
  }
  if (tokens === undefined) return undefined;
  if (tokens < threshold) {
    updateSessionState(sessionId, (s) => (s.contextBackstop === true ? { ...s, contextBackstop: false } : s), opts);
    return undefined;
  }
  let fire = false;
  updateSessionState(
    sessionId,
    (s) => {
      if (s.contextBackstop === true) return s;
      fire = true;
      return { ...s, contextBackstop: true };
    },
    opts,
  );
  if (!fire) return undefined;
  return contextBackstopNotice(tokens, threshold, fullDelegation);
}
