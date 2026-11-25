// Defensive parser of `claude -p --output-format stream-json --verbose` stdout. Any field may be missing or malformed: it becomes null, never an exception.
export interface TokenCounts { input: number; output: number; cache_read: number; cache_creation: number; total: number }

export interface ParsedStream {
  /** True when a `result` message was found. */
  result_found: boolean;
  is_error: boolean | null;
  result_subtype: string | null;
  cost_usd: number | null;
  num_turns: number | null;
  duration_ms: number | null;
  /** Summed over every model in `modelUsage` (subagents included); null when `modelUsage` is missing. */
  tokens: TokenCounts | null;
  tokens_by_model: Record<string, TokenCounts> | null;
  /** Distinct top-level `tool_use` blocks named Agent or Task. */
  subagents: number;
  /** Mode the plugin's SessionStart context announced ("Delegation mode: full|organic"), or null when absent. */
  observed_delegation: string | null;
  /** `plugins[].source` of the `system`/`init` message; null when no init message carried a plugins list. */
  observed_plugins: string[] | null;
  /** `output_style` of the `system`/`init` message, or null. */
  observed_output_style: string | null;
  malformed_lines: number;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function counts(u: Record<string, unknown>): TokenCounts {
  const input = num(u.inputTokens) ?? 0, output = num(u.outputTokens) ?? 0, cache_read = num(u.cacheReadInputTokens) ?? 0, cache_creation = num(u.cacheCreationInputTokens) ?? 0;
  return { input, output, cache_read, cache_creation, total: input + output + cache_read + cache_creation };
}

export function parseStream(stdout: string): ParsedStream {
  const out: ParsedStream = {
    result_found: false, is_error: null, result_subtype: null, cost_usd: null, num_turns: null, duration_ms: null,
    tokens: null, tokens_by_model: null, subagents: 0, observed_delegation: null, observed_plugins: null, observed_output_style: null, malformed_lines: 0,
  };
  const agentIds = new Set<string>();
  let anonymous = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let msg: Record<string, unknown> | null;
    try { msg = rec(JSON.parse(line)); } catch { msg = null; }
    if (!msg) { out.malformed_lines++; continue; }
    if (msg.type === "system") {
      // The SessionStart hook output arrives inside a system/hook_response message; only system messages count (an assistant quoting the line is not proof).
      const m = /Delegation mode: (full|organic)/.exec(line);
      if (m && out.observed_delegation === null) out.observed_delegation = m[1];
      if (msg.subtype === "init") {
        if (Array.isArray(msg.plugins)) out.observed_plugins = msg.plugins.map((p) => rec(p)?.source).filter((x): x is string => typeof x === "string");
        if (typeof msg.output_style === "string") out.observed_output_style = msg.output_style;
      }
    }
    if (msg.type === "assistant" && (msg.parent_tool_use_id === null || msg.parent_tool_use_id === undefined)) {
      const content = rec(msg.message)?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          const block = rec(b);
          if (block?.type === "tool_use" && (block.name === "Agent" || block.name === "Task")) {
            if (typeof block.id === "string") agentIds.add(block.id); else anonymous++;
          }
        }
      }
    } else if (msg.type === "result") {
      out.result_found = true;
      out.is_error = typeof msg.is_error === "boolean" ? msg.is_error : null;
      out.result_subtype = typeof msg.subtype === "string" ? msg.subtype : null;
      out.cost_usd = num(msg.total_cost_usd);
      out.num_turns = num(msg.num_turns);
      out.duration_ms = num(msg.duration_ms);
      const usage = rec(msg.modelUsage);
      if (usage) {
        const byModel: Record<string, TokenCounts> = {};
        const sum: TokenCounts = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 };
        for (const [model, u] of Object.entries(usage)) {
          const r = rec(u);
          if (!r) continue;
          const c = counts(r);
          byModel[model] = c;
          for (const k of Object.keys(sum) as (keyof TokenCounts)[]) sum[k] += c[k];
        }
        out.tokens_by_model = byModel;
        out.tokens = sum;
      }
    }
  }
  out.subagents = agentIds.size + anonymous;
  return out;
}
