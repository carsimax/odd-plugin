import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTps, extractUsage, renderStatusline, FALLBACK_LINE } from "./statusline.js";

const PAYLOAD = {
  session_id: "s1",
  model: { id: "claude-opus-4-1", display_name: "Opus 4.1" },
  workspace: { current_dir: "/tmp/x" },
  cost: { total_api_duration_ms: 20000 },
  context_window: { used_percentage: 42.4, context_window_size: 200000, total_output_tokens: 1000 },
  rate_limits: { five_hour: { used_percentage: 12.3 }, seven_day: { used_percentage: 40 } },
};
const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");
const PLAIN = { color: false, cols: 200 };

test("renders every segment in order on one line", () => {
  const line = renderStatusline(PAYLOAD, { ...PLAIN, coordinator: true, persona: "mentor", branch: "main", tps: 50 });
  assert.equal(line, "Opus 4.1 · ctx 42% · coord ON · mentor · 5h 12% 7d 40% · main · 50 tok/s");
  assert.ok(!line.includes("\n"));
});

test("coordinator OFF is shown; absent coordinator, branch, tps and rate limits are omitted", () => {
  const line = renderStatusline({ model: { display_name: "Sonnet" } }, { ...PLAIN, coordinator: false });
  assert.equal(line, "Sonnet · coord OFF");
});

test("missing fields and non-object payloads give the fallback line", () => {
  assert.equal(renderStatusline({}, PLAIN), FALLBACK_LINE);
  for (const bad of [null, undefined, 42, "x", [], { model: 7, context_window: "y", rate_limits: [] }]) {
    assert.equal(renderStatusline(bad, PLAIN), FALLBACK_LINE);
  }
});

test("model falls back to id; context % derives from current_usage when used_percentage is absent", () => {
  const line = renderStatusline(
    { model: { id: "m-1" }, context_window: { context_window_size: 1000, current_usage: { input_tokens: 100, cache_read_input_tokens: 150, cache_creation_input_tokens: 50, output_tokens: 9 } } },
    PLAIN,
  );
  assert.equal(line, "m-1 · ctx 30%");
});

test("color adds ANSI; plain output has none; tone changes at 80/95 percent", () => {
  const colored = renderStatusline(PAYLOAD, { color: true, cols: 200 });
  assert.match(colored, /\u001b\[/);
  assert.equal(strip(colored), renderStatusline(PAYLOAD, PLAIN));
  const warn = renderStatusline({ context_window: { used_percentage: 85 } }, { color: true, cols: 200 });
  const err = renderStatusline({ context_window: { used_percentage: 97 } }, { color: true, cols: 200 });
  const ok = renderStatusline({ context_window: { used_percentage: 10 } }, { color: true, cols: 200 });
  assert.equal(new Set([ok, warn, err].map((s) => s.match(/\u001b\[[0-9;]*m/)![0])).size, 3);
  assert.equal(renderStatusline(PAYLOAD, PLAIN).includes("\u001b"), false);
});

test("narrow width drops low-priority segments from the right and never overflows", () => {
  const extras = { ...PLAIN, coordinator: true, persona: "mentor", branch: "main", tps: 50 };
  for (const cols of [60, 30, 20, 10, 5, 1]) {
    const line = renderStatusline(PAYLOAD, { ...extras, cols });
    assert.ok(strip(line).length <= cols, `${cols}: ${line}`);
    assert.ok(line.startsWith(cols >= 8 ? "Opus 4.1" : "Opus"[0]!), `${cols}: ${line}`);
  }
  assert.ok(!renderStatusline(PAYLOAD, { ...extras, cols: 30 }).includes("tok/s"));
});

test("terminal control characters in model/branch/persona are stripped", () => {
  const line = renderStatusline({ model: { display_name: "A\u001b[31mB\u0007\n" } }, { ...PLAIN, branch: "x\u001b]0;t\u0007y" });
  assert.ok(!/[\u0000-\u001f\u007f]/.test(line), JSON.stringify(line));
});

test("extractUsage reads cumulative output tokens and api duration; undefined when absent", () => {
  assert.deepEqual(extractUsage(PAYLOAD), { outputTokens: 1000, apiMs: 20000 });
  assert.equal(extractUsage({}), undefined);
  assert.equal(extractUsage({ cost: { total_api_duration_ms: "x" }, context_window: { total_output_tokens: 5 } }), undefined);
});

test("computeTps: delta between invocations, else the session average, else nothing", () => {
  assert.equal(computeTps({ outputTokens: 1600, apiMs: 30000 }, { outputTokens: 1000, apiMs: 20000 }), 60);
  assert.equal(computeTps({ outputTokens: 1000, apiMs: 20000 }), 50);
  // no api time elapsed between calls: keep the previous reading
  assert.equal(computeTps({ outputTokens: 1000, apiMs: 20000 }, { outputTokens: 1000, apiMs: 20000, tps: 33 }), 33);
  // counters went backwards (new session / compaction): fall back to the average
  assert.equal(computeTps({ outputTokens: 100, apiMs: 10000 }, { outputTokens: 1000, apiMs: 20000, tps: 33 }), 10);
  assert.equal(computeTps({ outputTokens: 0, apiMs: 0 }), undefined);
  assert.equal(computeTps(undefined, { outputTokens: 1, apiMs: 1, tps: 9 }), undefined);
});
