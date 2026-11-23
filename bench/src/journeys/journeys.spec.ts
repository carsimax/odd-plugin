// The ported journeys against the odd subject: each one's normalized projection, friction accounting per journey class, and isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedProjection, runJourney, toJourney, type Journey, type JourneyDef, type JourneyResultRow, type StepKind } from "../journey.js";
import { blocksTotal } from "../metrics.js";
import { buildResult } from "../report.js";
import { validateResult } from "../schema.js";
import { oddSubject } from "../subjects/odd.js";
import { oracleAvailable, oracleBinaryPath, oracleEnv, oracleSubject } from "../subjects/oracle.js";
import { applyEdit, applyFixture, CHANGE, editedFile } from "./fixtures.js";
import { createSandbox } from "../sandbox.js";
import { JOURNEY_DEFS } from "./index.js";

const KINDS: readonly StepKind[] = ["assess", "inspect", "status", "start", "answerConsent", "captureAll", "resume", "correct", "commit", "acknowledge", "gateCheck", "stopHook", "modeSet"];
const byId = (id: string): JourneyDef => {
  const d = JOURNEY_DEFS.find((x) => x.id === id);
  assert.ok(d, `unknown journey ${id}`);
  return d;
};

// One run per journey, shared by the projection test and the accounting tests (a journey takes seconds: real processes).
const runs = new Map<string, Promise<JourneyResultRow>>();
const run = (id: string): Promise<JourneyResultRow> => {
  if (!runs.has(id)) runs.set(id, runJourney(toJourney(byId(id), oddSubject)));
  return runs.get(id)!;
};

test("the catalog ports about twenty journeys with unique ids, neutral vocabulary and upstream ids kept only as references", () => {
  assert.ok(JOURNEY_DEFS.length >= 20 && JOURNEY_DEFS.length <= 26, `${JOURNEY_DEFS.length} journeys`);
  assert.equal(new Set(JOURNEY_DEFS.map((d) => d.id)).size, JOURNEY_DEFS.length);
  for (const d of JOURNEY_DEFS) {
    assert.match(d.id, /^[a-z0-9-]+$/);
    assert.ok(d.description.length > 20 && d.steps.length >= 1, d.id);
    if (d.refId !== undefined) assert.match(d.refId, /^j\d+-[a-z0-9-]+$/, d.id);
    for (const s of d.steps) assert.ok(KINDS.includes(s.do.kind), `${d.id}: ${s.do.kind}`);
    // subject-neutral: no odd tool, hook or file name leaks into the definition
    assert.equal(/review_(assess|inspect|start|status|answer|capture|acknowledge|complete|run)\b|mcp|PreToolUse|dist\/|\.js"/.test(JSON.stringify(d)), false, `${d.id} names a subject-specific surface`);
  }
  const covered = new Set(JOURNEY_DEFS.flatMap((d) => d.steps.map((s) => s.do.kind)));
  for (const k of KINDS.filter((x) => x !== "commit")) assert.ok(covered.has(k), `no journey uses ${k}`);
});

test("the journeys cover every scenario of the brief", () => {
  const ids = new Set(JOURNEY_DEFS.map((d) => d.id));
  for (const id of [
    "low-risk-closes-with-zero-lenses", "medium-risk-one-lens-consent-capture-ack", "high-risk-four-lens-group", "consent-declined-creates-no-review",
    "correction-then-validator-approves", "correction-noop-refused", "gate-push-denied-unreviewed-high-risk", "gate-push-allowed-after-receipt",
    "gate-push-allowed-when-declined", "gate-silent-with-rdd-off", "gate-pr-open-denied-unreviewed", "gate-pr-open-allowed-after-receipt",
    "stop-reminds-once-per-session-and-candidate", "stop-silent-with-rdd-off", "workspace-review-does-not-authorize-committed-range",
    "binding-drift-mid-run", "consent-never-answered-implicitly", "resume-after-consent", "duplicate-start-guard-during-correction",
  ]) assert.ok(ids.has(id), `missing ${id}`);
});

for (const d of JOURNEY_DEFS) {
  test(`odd runs journey ${d.id} and its normalized projection is the expected one`, async () => {
    const row = await run(d.id);
    assert.equal(row.status, "passed", JSON.stringify(row));
    assert.deepEqual(row.outcome, expectedProjection(d));
    assert.equal(row.ref_id, d.refId);
    const m = row.metrics!;
    assert.ok(m.commands_to_completion.value! >= 1);
    const ops = Object.keys(m.latency);
    if (ops.some((o) => o.startsWith("mcp."))) assert.ok(m.human_surface_bytes.value! > 0, "what the agent was shown is counted");
    else assert.ok(m.human_surface_bytes.value! >= 0, "a hook that stays silent shows nothing");
    assert.ok(ops.length >= 1 && ops.every((o) => /^(mcp|hook)\./.test(o)), `latency per operation: ${ops.join()}`);
    for (const o of ops) assert.ok(m.latency[o]!.samples >= 1 && m.latency[o]!.median_ms > 0 && m.latency[o]!.p95_ms >= m.latency[o]!.median_ms, o);
  });
}

test("every journey row and the aggregate form a valid result document", async () => {
  const rows = await Promise.all(JOURNEY_DEFS.map((d) => run(d.id)));
  const res = buildResult("odd", rows, { binaryPath: "x", binaryVersion: "y", commit: "z" });
  assert.deepEqual(validateResult(JSON.parse(JSON.stringify(res))), []);
  assert.deepEqual(res.aggregate.counts, { passed: JOURNEY_DEFS.length, failed: 0, unsupported: 0 });
});

// ---- friction accounting per journey class (hand-counted from the steps) ----

const metrics = async (id: string) => (await run(id)).metrics!;

test("accounting: a low-risk review runs no model, asks no human and takes assess, start and acknowledge", async () => {
  const m = await metrics("low-risk-closes-with-zero-lenses");
  assert.deepEqual([m.model_runs.value, m.human_prompts.value, m.manual_tokens.value, m.commands_to_completion.value], [0, 0, 0, 3]);
  assert.equal(blocksTotal(m.blocks.value!), 0);
  assert.ok(m.git_subprocesses.value! >= 1);
});

test("accounting: medium costs one reviewer run and two human prompts (consent, cost forecast)", async () => {
  const m = await metrics("medium-risk-one-lens-consent-capture-ack");
  // assess, start, answer, status, forecast, capture, acknowledge
  assert.deepEqual([m.model_runs.value, m.human_prompts.value, m.commands_to_completion.value], [1, 2, 7]);
  assert.equal(m.manual_tokens.derivation, "proxy");
  assert.equal(m.manual_tokens.value, Math.ceil((Buffer.byteLength("yes, review this change") + Buffer.byteLength("yes, run the reviewers")) / 4));
  assert.equal(blocksTotal(m.blocks.value!), 0);
});

test("accounting: high costs four reviewer runs; a declined review costs none", async () => {
  assert.equal((await metrics("high-risk-four-lens-group")).model_runs.value, 4);
  assert.equal((await metrics("explicit-lens-selection-narrows-review")).model_runs.value, 2);
  const declined = await metrics("consent-declined-creates-no-review");
  assert.deepEqual([declined.model_runs.value, declined.human_prompts.value], [0, 1]);
});

test("accounting: the correction loop is four lenses plus one validator and three human prompts, and nothing is blocked", async () => {
  const m = await metrics("correction-then-validator-approves");
  assert.deepEqual([m.model_runs.value, m.human_prompts.value], [5, 3]);
  assert.equal(blocksTotal(m.blocks.value!), 0);
});

test("accounting: refusals and denials are in-band blocks that carry their way forward, and nothing refused starts a reviewer", async () => {
  const noop = await metrics("correction-noop-refused");
  assert.deepEqual([noop.blocks.value!.in_band, blocksTotal(noop.blocks.value!), noop.model_runs.value], [1, 1, 4]);
  const dup = await metrics("duplicate-start-guard-during-correction");
  assert.deepEqual([dup.blocks.value!.in_band, dup.model_runs.value], [1, 4]);
  const drift = await metrics("binding-drift-mid-run");
  assert.deepEqual([drift.blocks.value!.in_band, drift.model_runs.value], [1, 0]);
  const stale = await metrics("binding-drift-after-consent-question");
  assert.deepEqual([stale.blocks.value!.in_band, stale.model_runs.value], [1, 0]);
});

test("accounting: the delivery hook never blocks: one hook command and no block, with RDD on or off, before or after a receipt", async () => {
  const unreviewed = await metrics("gate-push-denied-unreviewed-high-risk");
  assert.deepEqual([unreviewed.commands_to_completion.value, blocksTotal(unreviewed.blocks.value!), unreviewed.model_runs.value, unreviewed.human_prompts.value], [1, 0, 0, 0]);
  assert.deepEqual(Object.keys(unreviewed.latency), ["hook.pre_tool_use"]);
  const off = await metrics("gate-silent-with-rdd-off");
  assert.deepEqual([off.commands_to_completion.value, blocksTotal(off.blocks.value!)], [1, 0]);
  const after = await metrics("gate-push-allowed-after-receipt");
  assert.equal(blocksTotal(after.blocks.value!), 0, "neither the unreviewed push nor the one after the receipt is blocked");
  assert.equal(after.recovery_round_trips.value, 0);
});

test("accounting: each Stop reminder is an in-band block, a silent Stop is not", async () => {
  const m = await metrics("stop-reminds-once-per-session-and-candidate");
  assert.equal(m.blocks.value!.in_band, 3);
  assert.equal(m.commands_to_completion.value, 4, "four Stop events; the edit between them is not a product command");
  assert.equal(blocksTotal((await metrics("stop-silent-with-rdd-off")).blocks.value!), 0);
});

// ---- fixtures ----

test("fixtures: each tier writes its own file, staged; committed placement leaves a clean tree ahead of origin; edits change the candidate", async () => {
  const sb = await createSandbox({ origin: true });
  try {
    applyFixture(sb, { change: "high", placement: "committed", extraWorkspace: true, origin: true });
    assert.equal(sb.git(["log", "--oneline"]).trim().split("\n").length, 2, "the change is one commit on top of the initial one");
    assert.match(sb.git(["status", "--short"]), /^A\s+src\/auth\/session\.ts$/m, "the extra workspace change is staged");
    assert.equal(sb.git(["rev-list", "--count", "origin/main..HEAD"]).trim(), "1");
    assert.equal(editedFile({ change: "high", extraWorkspace: true }).path, "src/auth/session.ts");
    const before = readFileSync(join(sb.repo, "src/auth/session.ts"), "utf8");
    applyEdit(sb, { change: "high", extraWorkspace: true }, "noop");
    assert.equal(readFileSync(join(sb.repo, "src/auth/session.ts"), "utf8"), before);
    applyEdit(sb, { change: "high", extraWorkspace: true }, "fix");
    const fixed = readFileSync(join(sb.repo, "src/auth/session.ts"), "utf8");
    applyEdit(sb, { change: "high", extraWorkspace: true }, "drift");
    const drifted = readFileSync(join(sb.repo, "src/auth/session.ts"), "utf8");
    assert.equal(new Set([before, fixed, drifted]).size, 3);
    assert.throws(() => editedFile({ change: "none" }));
  } finally {
    sb.cleanup();
  }
  for (const tier of ["low", "medium", "high"] as const) {
    const s = await createSandbox();
    try {
      applyFixture(s, { change: tier });
      assert.match(s.git(["status", "--short"]), new RegExp(`${CHANGE[tier].path.replace(/\./g, "\\.")}`));
      assert.equal(s.git(["log", "--oneline"]).trim().split("\n").length, 1, "workspace placement commits nothing");
    } finally {
      s.cleanup();
    }
  }
});

// ---- isolation ----

/** path|size|mtime of every entry under `root` (stat only; never reads a file); a missing root is an empty snapshot. */
function snapshot(root: string): string {
  const out: string[] = [];
  const walk = (p: string): void => {
    let st;
    try { st = statSync(p); } catch { return; }
    out.push(`${p}|${st.isDirectory() ? "d" : st.size}|${st.mtimeMs}`);
    if (st.isDirectory()) for (const e of readdirSync(p).sort()) walk(join(p, e));
  };
  walk(root);
  return out.join("\n");
}

test("isolation: a journey run reads and writes only its sandbox; the real ~/.claude plugin state and this repository's odd state are untouched", async () => {
  const home = process.env.HOME ?? "";
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).stdout.trim();
  const watched = [join(home, ".claude", "plugins", "data"), join(home, ".claude", "settings.json"), join(home, ".claude", "settings.local.json"), join(common, "odd-plugin"), join(common, "config")];
  const reviewerScratch = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith("odd-claude-reviewer-")).sort();
  const before = watched.map(snapshot);
  const scratchBefore = reviewerScratch();
  const leaked = { ANTHROPIC_API_KEY: "dummy-not-a-secret", CLAUDE_CODE_OAUTH_TOKEN: "dummy" };
  Object.assign(process.env, leaked);

  // Append a step that looks inside the sandbox before the runner removes it: the state landed there, and only there.
  const inside: { data: string[]; clone: string[]; root: string; env: NodeJS.ProcessEnv } = { data: [], clone: [], root: "", env: {} };
  const probe = { name: "probe sandbox", actor: "events" as const, async run(env: Parameters<Journey["steps"][number]["run"]>[0]) {
    inside.root = env.sandbox.root;
    inside.env = env.sandbox.env;
    inside.data = readdirSync(env.sandbox.dataDir);
    inside.clone = existsSync(join(env.sandbox.repo, ".git", "odd-plugin")) ? readdirSync(join(env.sandbox.repo, ".git", "odd-plugin")) : [];
    return { ok: true };
  } };
  try {
    for (const id of ["stop-reminds-once-per-session-and-candidate", "gate-push-allowed-after-receipt"]) {
      const j = toJourney(byId(id), oddSubject);
      const row = await runJourney({ ...j, steps: [...j.steps, probe] });
      assert.equal(row.status, "passed", JSON.stringify(row));
      assert.ok(inside.root.startsWith(tmpdir()) || inside.root.startsWith(process.env.TMPDIR ?? "\0"), "the sandbox lives under the session TMPDIR");
      assert.equal(existsSync(inside.root), false, "and is removed afterwards");
      if (id.startsWith("stop")) assert.ok(inside.data.includes("review-mode.json") && inside.data.includes("sessions"), `plugin state went to the sandbox data dir: ${inside.data.join()}`);
      else assert.ok(inside.clone.includes("review-transactions"), `review authority went to the sandbox repo: ${inside.clone.join()}`);
      const withoutPath = Object.fromEntries(Object.entries(inside.env).filter(([k]) => k !== "PATH"));
      assert.equal(JSON.stringify(withoutPath).includes(home), false, "no real HOME path in the child environment (PATH keeps the tools' own directories)");
    }
  } finally {
    for (const k of Object.keys(leaked)) delete process.env[k];
  }
  assert.deepEqual(watched.map(snapshot), before, "nothing changed in the real plugin state or the real repository's odd/config files");
  assert.deepEqual(reviewerScratch(), scratchBefore, "no reviewer scratch directory was left in TMPDIR");
});

test("isolation: a fresh journey run leaves no sandbox directory behind in the session TMPDIR", async () => {
  // Test files run in parallel and each creates sandboxes in the same TMPDIR, so the journey's own sandbox is the one checked (not a before/after listing).
  let root = "";
  const probe = { name: "note sandbox", actor: "events" as const, async run(env: Parameters<Journey["steps"][number]["run"]>[0]) { root = env.sandbox.root; return { ok: true }; } };
  const j = toJourney(byId("low-risk-closes-with-zero-lenses"), oddSubject);
  const row = await runJourney({ ...j, steps: [...j.steps, probe] });
  assert.equal(row.status, "passed");
  assert.match(root, /odd-bench-/);
  assert.equal(existsSync(root), false, "no sandbox directory outlives its journey");
});

// ---- isolation, oracle journeys ----

test("isolation (oracle): journeys run against the upstream binary touch only their sandbox; the real ~/.claude, ~/.gentle-shell, the product's own home dirs and this repository's .git are untouched", { skip: oracleAvailable() ? false : `oracle binary not found at ${oracleBinaryPath()}` }, async () => {
  const home = process.env.HOME ?? "";
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).stdout.trim();
  // ~/.gentle-shell is live (the host harness writes sessions and history there while tests run), so only its static entries are watched.
  const watched = [
    join(home, ".claude", "plugins", "data"), join(home, ".claude", "settings.json"), join(home, ".claude", "settings.local.json"),
    ...["config.json", "path-entry.json", "versions.history", "bin", "versions", "runtime"].map((e) => join(home, ".gentle-shell", e)),
    join(home, ".gentle-ai"), join(home, ".config", "gentle-ai"), join(home, ".local", "share", "gentle-ai"), join(home, ".local", "state", "gentle-ai"), join(home, ".cache", "gentle-ai"),
    join(common, "gentle-ai"), join(common, "odd-plugin"), join(common, "config"), join(common, "HEAD"),
  ];
  const before = watched.map(snapshot);
  const leaked = { ANTHROPIC_API_KEY: "dummy-not-a-secret", CLAUDE_CODE_OAUTH_TOKEN: "dummy", AWS_PROFILE: "dummy", GENTLE_AI_TELEMETRY: "1", DO_NOT_TRACK: "0" };
  Object.assign(process.env, leaked);
  const inside: { root: string; env: NodeJS.ProcessEnv; product: string[]; authority: string[]; mode: string[] } = { root: "", env: {}, product: [], authority: [], mode: [] };
  const probe = { name: "probe sandbox", actor: "events" as const, async run(env: Parameters<Journey["steps"][number]["run"]>[0]) {
    inside.root = env.sandbox.root;
    inside.env = oracleEnv(env.sandbox.env);
    const list = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);
    inside.product = list(join(env.sandbox.home, ".gentle-ai"));
    inside.authority = list(join(env.sandbox.repo, ".git", "gentle-ai"));
    return { ok: true };
  } };
  try {
    for (const id of ["stop-reminds-once-per-session-and-candidate", "high-risk-four-lens-group", "rdd-mode-global-and-clone-scopes"]) {
      const j = toJourney(byId(id), oracleSubject);
      const row = await runJourney({ ...j, steps: [...j.steps, probe] });
      assert.equal(row.status, "passed", JSON.stringify(row));
      assert.ok(inside.root.startsWith(tmpdir()) || inside.root.startsWith(process.env.TMPDIR ?? "\0"), "the sandbox lives under the session TMPDIR");
      assert.equal(existsSync(inside.root), false, "and is removed afterwards");
      if (id.startsWith("high")) assert.ok(inside.authority.includes("review-transactions"), `review authority went to the sandbox repo: ${inside.authority.join()}`);
      else assert.ok(inside.product.length > 0, `the product's own state (mode, stop-hook sessions) went to the sandbox HOME: ${inside.product.join()}`);
      assert.equal(inside.env.DO_NOT_TRACK, "1", "telemetry stays off whatever the parent says");
      assert.equal(inside.env.GENTLE_AI_TELEMETRY, "0");
      assert.equal(inside.env.ANTHROPIC_API_KEY, undefined);
      const withoutPath = Object.fromEntries(Object.entries(inside.env).filter(([k]) => k !== "PATH"));
      assert.equal(JSON.stringify(withoutPath).includes(home), false, "no real HOME path in the child environment (PATH keeps the tools' own directories)");
    }
  } finally {
    for (const k of Object.keys(leaked)) delete process.env[k];
  }
  assert.deepEqual(watched.map(snapshot), before, "nothing changed in the real Claude, gentle-shell or product directories, nor in this repository's .git");
});
