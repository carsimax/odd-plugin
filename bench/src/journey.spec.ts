import { test } from "node:test";
import assert from "node:assert/strict";
import { runJourney, type Journey } from "./journey.js";
import { exampleStatusJourney } from "./journeys/example.js";
import { validateResult } from "./schema.js";
import { buildResult } from "./report.js";

test("example journey drives odd's real MCP server end to end with a fake claude", async () => {
  const row = await runJourney(exampleStatusJourney);
  assert.equal(row.status, "passed", JSON.stringify(row));
  assert.deepEqual(row.outcome, exampleStatusJourney.expected);
  const m = row.metrics!;
  assert.equal(m.commands_to_completion.value, 2);
  assert.equal(m.human_prompts.value, 0);
  assert.equal(m.model_runs.value, 0);
  assert.equal(m.model_runs.derivation, "measured");
  assert.ok(m.human_surface_bytes.value! > 100, "tool text bytes are counted");
  assert.ok(m.git_subprocesses.value! >= 1, "the status tool shells out to git through the counted PATH");
  assert.equal(m.latency["mcp.review_status"]!.samples, 1);
  assert.ok(m.latency["mcp.review_status"]!.median_ms > 0);
  const res = buildResult("odd", [row], { binaryPath: "x", binaryVersion: "y", commit: "z" });
  assert.deepEqual(validateResult(JSON.parse(JSON.stringify(res))), []);
});

test("a journey whose projection differs from expected is failed, not passed", async () => {
  const bad: Journey = { ...exampleStatusJourney, id: "bad", expected: { ...exampleStatusJourney.expected, action: "proceed" } };
  const row = await runJourney(bad);
  assert.equal(row.status, "failed");
  assert.ok(row.metrics);
});

test("steps feed human prompts, blocks, recovery round trips and are deadline-bound; sandbox is removed", async () => {
  let root = "";
  const j: Journey = {
    id: "synthetic",
    description: "synthetic",
    expected: { done: true },
    steps: [
      { name: "ask", actor: "human", humanText: "x".repeat(40), run: async (env) => { root = env.sandbox.root; env.see("question text"); return { ok: true }; } },
      { name: "blocked", actor: "agent", run: async () => ({ ok: false, block: "in_band" }) },
      { name: "retry", actor: "agent", run: async () => ({ ok: true, observed: { done: true } }) },
    ],
  };
  const row = await runJourney(j);
  assert.equal(row.status, "passed");
  const m = row.metrics!;
  assert.equal(m.human_prompts.value, 1);
  assert.equal(m.manual_tokens.value, 10);
  assert.equal(m.manual_tokens.derivation, "proxy");
  assert.equal(m.commands_to_completion.value, 2);
  assert.equal(m.blocks.value!.in_band, 1);
  assert.equal(m.recovery_round_trips.value, 1);
  assert.equal(m.human_surface_bytes.value, 13);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(root), false);
  const slow: Journey = { id: "slow", description: "", expected: {}, deadlineMs: 100, steps: [{ name: "hang", actor: "agent", run: () => new Promise(() => {}) }] };
  const r2 = await runJourney(slow);
  assert.equal(r2.status, "failed");
  assert.match(r2.reason ?? "", /deadline/);
});
