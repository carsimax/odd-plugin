// R34 context backstop, adapted from upstream lib/context-backstop.ts (150k-token absolute cap, notice text).
// Pi exposes ctx.getContextUsage(); a Claude Code hook does not (PostToolUse input has session_id,
// transcript_path, cwd, permission_mode, agent_id/agent_type, tool_name/tool_input/tool_response, no usage and
// no window size). So the measurement reads the transcript: the last assistant `usage` line
// (input + cache_creation + cache_read tokens = the prompt the model just saw), or, when no usage line is in
// the tail, a heuristic of file bytes / 4. The window size is unknown, so only the absolute cap applies.
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { updateSessionState, type StateOptions } from "./state.js";

export const CONTEXT_BACKSTOP_TOKENS = 150_000;
export const CONTEXT_BACKSTOP_TOKENS_ENV = "ODD_CLAUDE_CONTEXT_BACKSTOP_TOKENS";
/** Rough tokens-per-byte for the size fallback (the transcript also carries JSON overhead, so it overestimates). */
export const BYTES_PER_TOKEN = 4;
const TAIL_BYTES = 512 * 1024;

type Env = Readonly<Record<string, string | undefined>>;

export function contextBackstopThreshold(env: Env = process.env): number {
  const v = Number(env[CONTEXT_BACKSTOP_TOKENS_ENV]?.trim());
  return Number.isFinite(v) && v > 0 ? v : CONTEXT_BACKSTOP_TOKENS;
}

function tail(path: string): string | undefined {
  if (!statSync(path).isFile()) return undefined; // a FIFO or device would hang openSync / block reads
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    // A tail read can start mid-line: drop the partial first line.
    return size > len ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/** Prompt tokens of the last assistant turn in the transcript tail; undefined when none is found. */
function lastUsageTokens(path: string): number | undefined {
  const text = tail(path);
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

/** Context tokens for a transcript path; undefined when unreadable. `measured` is true for a real usage figure. */
export function measureContext(path: string): { tokens: number; measured: boolean } | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    const real = lastUsageTokens(path);
    if (real !== undefined) return { tokens: real, measured: true };
    return { tokens: Math.round(statSync(path).size / BYTES_PER_TOKEN), measured: false };
  } catch {
    return undefined;
  }
}

export function estimateContextTokens(path: string): number | undefined {
  return measureContext(path)?.tokens;
}

const count = (v: number) => Math.round(v).toLocaleString("en-US");

export function contextBackstopNotice(tokens: number, threshold: number, measured: boolean, fullDelegation: boolean): string {
  const how = measured ? "measures" : "is estimated at";
  const tail = fullDelegation
    ? "delegate the next bounded unit with a short handoff, and keep only state checks in this context."
    : "delegate the next bounded unit that needs several steps (its reads, edits, and checks) with a short handoff, while single small edits and state checks stay inline.";
  return `Context backstop: the parent context ${how} ${count(tokens)} tokens, at or past the ${count(threshold)}-token backstop (advisory, nothing is blocked): ${tail}`;
}

/**
 * One notice per crossing per session (state key `contextBackstop`). A measured reading below the threshold
 * re-arms it (compaction); an estimate never re-arms because the transcript file only grows.
 */
export function checkContextBackstop(
  sessionId: string,
  transcriptPath: unknown,
  fullDelegation: boolean,
  env: Env,
  opts: StateOptions,
): string | undefined {
  if (typeof transcriptPath !== "string" || transcriptPath === "") return undefined;
  const m = measureContext(transcriptPath);
  if (!m) return undefined;
  const threshold = contextBackstopThreshold(env);
  if (m.tokens < threshold) {
    // re-arm only on a measured reading; no write when already disarmed
    if (m.measured) updateSessionState(sessionId, (s) => (s.contextBackstop === true ? { ...s, contextBackstop: false } : s), opts);
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
  return contextBackstopNotice(m.tokens, threshold, m.measured, fullDelegation);
}
