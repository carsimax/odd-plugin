// R14 exploration budget, ported from upstream lib/exploration-budget.ts. Upstream keeps the counters in
// memory per request; a Claude Code hook is a fresh process per call, so they live in session state
// (key `exploration`) and UserPromptSubmit resets them per turn. Advisory only: it returns a notice.
import { updateSessionState, type StateOptions } from "./state.js";

/** Upstream thresholds: the notice fires once lookups > 3 or text bytes > 40,000. */
export const EXPLORATION_MAX_LOOKUPS = 3;
export const EXPLORATION_MAX_BYTES = 40_000;

export interface ExplorationCounters {
  lookups: number;
  bytes: number;
  notified: boolean;
}

const BUILTIN = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
// MCP name forms: the global `codegraph` server, plus the legacy plugin-bundled one (tolerated).
const CODEGRAPH = /^mcp__(?:plugin_odd-claude_)?codegraph__/;

export function isExplorationTool(name: string): boolean {
  return BUILTIN.has(name) || CODEGRAPH.test(name);
}

/** UTF-8 bytes of every string inside a tool response (upstream counts text parts only). */
export function responseTextBytes(value: unknown, depth = 0): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (depth > 8 || value === null || typeof value !== "object") return 0;
  let total = 0;
  // The `type` discriminator ("text", "file") is protocol, not content.
  for (const [k, v] of Object.entries(value)) if (k !== "type") total += responseTextBytes(v, depth + 1);
  return total;
}

function counters(state: Record<string, unknown>): ExplorationCounters {
  const e = state.exploration as Partial<ExplorationCounters> | undefined;
  return {
    lookups: typeof e?.lookups === "number" ? e.lookups : 0,
    bytes: typeof e?.bytes === "number" ? e.bytes : 0,
    notified: e?.notified === true,
  };
}

const n = (v: number) => v.toLocaleString("en-US");

export function explorationNotice(lookups: number, bytes: number): string {
  return `Exploration budget: ${n(lookups)} tracked lookups and ${n(bytes)} UTF-8 text bytes (an approximate evidence budget). Ongoing discovery needs several parallel odd-explore subagents, one per distinct front (single narrow front: one), even if read-only or initially small. Reading that prepares a writer belongs in that writer's prompt. This is advisory runtime context for the original task, not a new user request; it blocks nothing and grants no mutation authority.`;
}

/** Counts one exploration result; returns the notice once per turn when a threshold is crossed. */
export function recordExploration(sessionId: string, toolResponse: unknown, notify: boolean, opts: StateOptions): string | undefined {
  let notice: string | undefined;
  updateSessionState(
    sessionId,
    (s) => {
      const c = counters(s);
      c.lookups++;
      c.bytes += responseTextBytes(toolResponse);
      if (notify && !c.notified && (c.lookups > EXPLORATION_MAX_LOOKUPS || c.bytes > EXPLORATION_MAX_BYTES)) {
        c.notified = true;
        notice = explorationNotice(c.lookups, c.bytes);
      }
      return { ...s, exploration: c };
    },
    opts,
  );
  return notice;
}

/** Per-turn reset (UserPromptSubmit). */
export function resetExploration(sessionId: string, opts: StateOptions): void {
  updateSessionState(sessionId, (s) => ({ ...s, exploration: { lookups: 0, bytes: 0, notified: false } satisfies ExplorationCounters }), opts);
}
