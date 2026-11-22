// R36 local session stats, ported from upstream lib/shell-stats.ts (collectSessionStats + renderStatsRows).
// Differences: upstream reads Pi session entries and prices them; a Claude Code hook gets no usage API, so the
// numbers come from the transcript JSONL (`transcript_path` in hook input), persisted per session in the state
// file so the CLI can find it. Local only: no cost lookup, no quota endpoint, no network. Every read is bounded.
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { formatDuration, type SubagentRecord } from "./subagents.js";
import { readSessionState, updateSessionState, type StateOptions } from "./state.js";

/** Only the tail of a transcript is read: a long session never costs more than this. */
export const STATS_TAIL_BYTES = 8 * 1024 * 1024;
/** A single line above this is skipped unparsed (a huge tool result, not a usage record). */
export const STATS_MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 8;
const MAX_PATH = 4096;

/** Strips escape sequences, control and bidi characters: transcript text is never trusted. */
function cleanText(s: unknown): string {
  if (typeof s !== "string") return "";
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]?/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u061c\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
      .trim()
  );
}

export interface ModelUsage {
  model: string;
  turns: number;
  tokens: number;
}

export interface TranscriptStats {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** First to last dated entry in the part that was read. */
  spanMs: number;
  /** True when the file was larger than the tail cap: totals cover only its end. */
  truncated: boolean;
  bytesRead: number;
  models: ModelUsage[];
}

export interface Exploration {
  lookups: number;
  bytes: number;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

function validPath(p: unknown): p is string {
  // eslint-disable-next-line no-control-regex
  return typeof p === "string" && p.length <= MAX_PATH && isAbsolute(p) && p.endsWith(".jsonl") && !/[\u0000-\u001f\u007f]/.test(p);
}

/** Persists the latest transcript path of the session (SessionStart / UserPromptSubmit). Never throws, never outputs. */
export function recordTranscriptPath(input: { session_id?: unknown; transcript_path?: unknown }, opts: StateOptions = {}): void {
  const id = input.session_id;
  if (typeof id !== "string" || id === "" || !validPath(input.transcript_path)) return;
  const path = input.transcript_path;
  try {
    updateSessionState(id, (s) => (s.transcriptPath === path ? s : { ...s, transcriptPath: path }), opts);
  } catch {
    // advisory only
  }
}

export function readTranscriptPath(sessionId: string, opts: StateOptions = {}): string | undefined {
  const p = readSessionState(sessionId, opts).transcriptPath;
  return validPath(p) ? p : undefined;
}

function readTail(path: string): { text: string; truncated: boolean; bytes: number } | undefined {
  if (!statSync(path).isFile()) return undefined; // a FIFO or device would hang
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, STATS_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, size - len + got);
      if (n <= 0) break;
      got += n;
    }
    const text = buf.subarray(0, got).toString("utf8");
    // A tail read can start mid-line: drop the partial first line.
    return { text: size > len ? text.slice(text.indexOf("\n") + 1) : text, truncated: size > len, bytes: got };
  } finally {
    closeSync(fd);
  }
}

/** Token totals from the transcript tail; undefined when it cannot be read. Never throws. */
export function collectTranscriptStats(path: string): TranscriptStats | undefined {
  try {
    const tail = readTail(path);
    if (tail === undefined) return undefined;
    // Streaming writes the same message id several times with a growing usage: the last record wins.
    const byMessage = new Map<string, { model: string; input: number; output: number; cacheRead: number; cacheWrite: number }>();
    let first = Infinity;
    let last = -Infinity;
    let anon = 0;
    for (const line of tail.text.split("\n")) {
      if (line === "" || line.length > STATS_MAX_LINE_BYTES) continue;
      if (!line.includes('"usage"') && !line.includes('"timestamp"')) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry !== "object" || entry === null) continue;
      const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      if (Number.isFinite(at)) {
        first = Math.min(first, at);
        last = Math.max(last, at);
      }
      const m = entry.message;
      const u = m?.usage;
      if (entry.type !== "assistant" || typeof m !== "object" || m === null || typeof u !== "object" || u === null) continue;
      const model = typeof m.model === "string" ? cleanText(m.model).slice(0, 80) : "";
      if (model === "<synthetic>") continue;
      byMessage.set(typeof m.id === "string" && m.id !== "" ? m.id : `anon-${anon++}`, {
        model: model === "" ? "unknown" : model,
        input: count(u.input_tokens),
        output: count(u.output_tokens),
        cacheRead: count(u.cache_read_input_tokens),
        cacheWrite: count(u.cache_creation_input_tokens),
      });
    }
    const stats: TranscriptStats = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, spanMs: last > first ? last - first : 0, truncated: tail.truncated, bytesRead: tail.bytes, models: [] };
    const models = new Map<string, ModelUsage>();
    for (const r of byMessage.values()) {
      stats.turns++;
      stats.input += r.input;
      stats.output += r.output;
      stats.cacheRead += r.cacheRead;
      stats.cacheWrite += r.cacheWrite;
      const mu = models.get(r.model) ?? { model: r.model, turns: 0, tokens: 0 };
      mu.turns++;
      mu.tokens += r.input + r.output + r.cacheRead + r.cacheWrite;
      models.set(r.model, mu);
    }
    stats.models = [...models.values()].sort((a, b) => b.tokens - a.tokens || b.turns - a.turns).slice(0, MAX_MODELS);
    return stats;
  } catch {
    return undefined;
  }
}

export function readExploration(sessionId: string, opts: StateOptions = {}): Exploration | undefined {
  const e = readSessionState(sessionId, opts).exploration as { lookups?: unknown; bytes?: unknown } | undefined;
  if (typeof e !== "object" || e === null) return undefined;
  return { lookups: count(e.lookups), bytes: count(e.bytes) };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
}

export interface StatsView {
  transcript: TranscriptStats | undefined;
  subagents: readonly SubagentRecord[];
  exploration: Exploration | undefined;
  /** Why there is no transcript section, when there is none. */
  note?: string;
}

/** Mirrors upstream renderStatsRows (spent line dropped: no pricing offline). */
export function renderStats(v: StatsView): string {
  const out = ["odd-claude stats (this session, local data only)"];
  const t = v.transcript;
  if (t === undefined) out.push(v.note ?? "No transcript to read for this session yet.");
  else {
    out.push(`turns      ${t.turns}${t.spanMs > 0 ? ` · ${formatDuration(t.spanMs)}` : ""}`);
    out.push(`tokens     in ${tokens(t.input)} · out ${tokens(t.output)}`);
    const prompt = t.input + t.cacheRead + t.cacheWrite;
    if (prompt > 0) out.push(`cache      ${Math.round((t.cacheRead / prompt) * 100)}% hit · ${tokens(t.cacheRead)} read · ${tokens(t.cacheWrite)} written`);
    for (const m of t.models) out.push(`  ${m.model}  ${plural(m.turns, "turn")} · ${tokens(m.tokens)} tokens`);
    if (t.truncated) out.push(`(partial: only the last ${(t.bytesRead / (1024 * 1024)).toFixed(1)} MiB of the transcript was read)`);
  }
  const done = v.subagents.filter((r) => r.startedAt !== undefined && r.endedAt !== undefined);
  const running = v.subagents.filter((r) => r.endedAt === undefined).length;
  const total = done.reduce((a, r) => a + Math.max(0, (r.endedAt as number) - (r.startedAt as number)), 0);
  out.push(`subagents  ${plural(v.subagents.length, "subagent")} (${running} running)${done.length > 0 ? ` · ${formatDuration(total)} finished work` : ""}`);
  if (v.exploration !== undefined) out.push(`explore    this turn: ${plural(v.exploration.lookups, "lookup")} · ${v.exploration.bytes} bytes`);
  return out.join("\n");
}
