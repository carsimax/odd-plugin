import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { expectedProjection, runJourney, toJourney, type FixtureSpec, type Journey, type JourneyDef, type MetricEvent, type NormalizedFacts, type StepSpec, type Subject } from "./journey.js";
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

// ---- subject-neutral step model ----

/** A subject that only replays scripted observations: the step model and the accounting are tested without any odd code. */
function scripted(script: (step: StepSpec, n: number) => { facts: NormalizedFacts; events: MetricEvent[] }, seen: { fixture?: FixtureSpec; origin?: boolean; setupGit?: string } = {}): Subject {
  return {
    name: "odd",
    async open(env, fixture) {
      seen.fixture = fixture;
      seen.origin = env.sandbox.origin !== undefined;
      seen.setupGit = env.sandbox.git(["log", "--oneline"]); // uncounted setup git
      await env.runHook("setup", process.execPath, ["-e", "0"]); // setup latency must not leak into the journey
      let n = 0;
      return { async exec(step) { return script(step, n++); } };
    },
  };
}

const def = (over: Partial<JourneyDef> = {}): JourneyDef => ({
  id: "synthetic-def",
  description: "synthetic",
  fixture: { change: "none" },
  steps: [
    { do: { kind: "inspect" }, expect: { outcome: "inspected", lineages: 0 } },
    { do: { kind: "gateCheck", command: "push" }, expect: { outcome: "deny", gate: "deny", reason: "review_due" } },
    { do: { kind: "status" }, expect: { outcome: "status", next: "stop" } },
  ],
  ...over,
});

test("a journey definition is data: its projection is one normalized entry per step, in order, tagged with the step kind", () => {
  assert.deepEqual(expectedProjection(def()), {
    steps: [
      { step: "inspect", outcome: "inspected", lineages: 0 },
      { step: "gateCheck", outcome: "deny", gate: "deny", reason: "review_due" },
      { step: "status", outcome: "status", next: "stop" },
    ],
  });
});

test("event steps account friction only from the events the subject reports; setup is never counted", async () => {
  const seen: { fixture?: FixtureSpec; origin?: boolean; setupGit?: string } = {};
  const subject = scripted((step, n) => {
    if (n === 0) return { facts: { outcome: "inspected", lineages: 0 }, events: [{ kind: "command" }, { kind: "command" }, { kind: "human_prompt", text: "x".repeat(40) }, { kind: "surface", bytes: 100 }, { kind: "latency", op: "synthetic.op", ms: 5 }, { kind: "model_run" }, { kind: "git_subprocess" }] };
    if (n === 1) return { facts: { outcome: "deny", gate: "deny", reason: "review_due" }, events: [{ kind: "command" }, { kind: "block", class: "in_band" }, { kind: "block", class: "by_design" }] };
    return { facts: { outcome: "status", next: "stop" }, events: [{ kind: "command" }] };
  }, seen);
  const row = await runJourney(toJourney(def({ refId: "j05-gate-without-any-review", fixture: { change: "high", origin: true, rdd: "on" } }), subject));
  assert.equal(row.status, "passed", JSON.stringify(row));
  assert.equal(row.ref_id, "j05-gate-without-any-review");
  assert.deepEqual(seen.fixture, { change: "high", origin: true, rdd: "on" });
  assert.equal(seen.origin, true, "the fixture's origin is wired before open");
  assert.match(seen.setupGit ?? "", /bench: initial/);
  const m = row.metrics!;
  assert.equal(m.commands_to_completion.value, 4, "only `command` events count, not the steps themselves");
  assert.equal(m.human_prompts.value, 1);
  assert.equal(m.manual_tokens.value, 10);
  assert.deepEqual(m.blocks.value, { self_recovered: 0, in_band: 1, out_of_band: 0, by_design: 1, dead_end: 0 });
  assert.equal(m.recovery_round_trips.value, 1, "the success right after the blocked step is one recovery");
  assert.equal(m.model_runs.value, 1);
  assert.equal(m.git_subprocesses.value, 1, "setup git is uncounted; only the reported event counts");
  assert.equal(m.human_surface_bytes.value, 100);
  assert.deepEqual(Object.keys(m.latency), ["synthetic.op"], "setup latency is dropped");
  assert.equal(m.latency["synthetic.op"]!.median_ms, 5);
  assert.deepEqual(row.outcome, expectedProjection(def()));
});

test("an explicit recovery event counts, and a step that only reports events is not also counted as a command", async () => {
  const subject = scripted(() => ({ facts: { outcome: "status", next: "stop" }, events: [{ kind: "recovery" }] }));
  const row = await runJourney(toJourney(def({ steps: [{ do: { kind: "status" }, expect: { outcome: "status", next: "stop" } }] }), subject));
  assert.equal(row.status, "passed");
  assert.equal(row.metrics!.recovery_round_trips.value, 1);
  assert.equal(row.metrics!.commands_to_completion.value, 0);
  assert.equal(row.metrics!.blocks.value!.in_band, 0);
});

test("a subject whose normalized facts differ from the journey's expectation fails the journey and still reports metrics", async () => {
  const subject = scripted(() => ({ facts: { outcome: "allow", gate: "allow" }, events: [{ kind: "command" }] }));
  const row = await runJourney(toJourney(def({ steps: [{ do: { kind: "gateCheck", command: "push" }, expect: { outcome: "deny", gate: "deny", reason: "review_due" } }] }), subject));
  assert.equal(row.status, "failed");
  assert.match(row.reason ?? "", /differs from expected/);
  assert.equal(row.metrics!.commands_to_completion.value, 1);
});

test("a subject that throws fails the journey with its message and the sandbox is still removed", async () => {
  let root = "";
  const subject: Subject = { name: "odd", async open(env) { root = env.sandbox.root; return { async exec() { throw new Error("boom"); } }; } };
  const row = await runJourney(toJourney(def(), subject));
  assert.equal(row.status, "failed");
  assert.match(row.reason ?? "", /boom/);
  assert.equal(existsSync(root), false);
});

test("the journey env hands subjects the built plugin entrypoints", async () => {
  let paths: Record<string, string> = {};
  const subject: Subject = { name: "odd", async open(env) { paths = env.plugin; return { async exec() { return { facts: { outcome: "x" }, events: [] }; } }; } };
  await runJourney(toJourney(def({ steps: [{ do: { kind: "inspect" }, expect: { outcome: "x" } }] }), subject));
  for (const k of ["server", "hooks", "reviewMode"]) assert.ok(existsSync(paths[k]!), `${k} exists: ${paths[k]}`);
});
