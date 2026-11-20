import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acknowledgeApproved } from "./ack.js";
import { isRecoverableStop, isTerminalStop, verifyBinding } from "./contract.js";
import { validate, type Schema } from "./schema.js";
import { admitLensResult, approve, escalate, invalidate, requireCorrection, type StateRecord } from "./state.js";
import { startReview, type RiskAssessment, type StartResult } from "./start.js";
import { listLineages, readState, updateState, storeRootFor } from "./store.js";
import { reviewStatus, type StatusEnvelope } from "./status.js";
import { clone, INTEGRATION_ROOT } from "./fixtures.testkit.js";

const ENV = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith("GIT_")) env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
})();

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

interface Repo {
  repo: string;
  commonDir: string;
  cleanup: () => void;
}

function makeRepo(opts: { dirty?: boolean | "docs" } = {}): Repo {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-status-")));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "README.md"), "# t\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  if (opts.dirty === "docs") writeFileSync(join(repo, "README.md"), "# t\n\nmore docs\n");
  else if (opts.dirty !== false) writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\nfour\nfive\n");
  return { repo, commonDir: realpathSync(join(repo, ".git")), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const assessor = (level: RiskAssessment["level"]) => () => ({
  level,
  reasons: [{ code: level === "low" ? "non_executable_only" : "shell_source", ...(level === "low" ? {} : { signal: "shell_process", path: "a.txt" }) }],
  evidence: level === "low" ? [] : ["shell scripting in a.txt"],
});

async function start(r: Repo, level: RiskAssessment["level"]): Promise<StartResult> {
  const o = await startReview({ cwd: r.repo, target: { kind: "current-changes" }, consent: "granted", riskAssessor: assessor(level) });
  assert.equal(o.status, "started", JSON.stringify(o));
  if (o.status !== "started") throw new Error("unreachable");
  return o.result;
}

const NOW = new Date(Date.now() + 60_000).toISOString(); // never precedes created_at
const HASH = `sha256:${"7".repeat(64)}`;

async function mutate(r: Repo, lineage: string, fn: (rec: StateRecord) => ReturnType<typeof approve> | ReturnType<typeof escalate>): Promise<StateRecord> {
  const cur = readState(r.commonDir, lineage);
  return (await updateState(r.commonDir, lineage, cur.revision, fn as never)).record;
}

const admit = (lens: string, findings: unknown[] = []) => (rec: StateRecord) =>
  admitLensResult(rec, { lens, findings: findings as never, resultHash: HASH, now: NOW });

// ---- structural validation against the vendored status-v5 schema (ids mapped to odd-claude) ----

const V2 = join(INTEGRATION_ROOT, "v2", "schemas");
const UPSTREAM = ["gentle", "ai"].join("-"); // vendored ids carry the upstream product prefix
const loadRaw = (id: string): any =>
  JSON.parse(
    readFileSync(id, "utf8")
      .replaceAll(`${UPSTREAM}.review`, "odd-claude.review")
        // the reference commands are CLI lines; here they are the review tool names (the only three commands status emits)
        .replaceAll(`"^${UPSTREAM} review acknowledge-approved"`, '"^review_acknowledge_approved$"')
        .replaceAll(`"^${UPSTREAM} review status(?: |$)"`, '"^review_status$"')
        .replaceAll(`"^${UPSTREAM} review [a-z][a-z-]*"`, '"^(review_start|review_complete|review_acknowledge_approved)$"'),
  );

// Own convention (status.ts): transition arguments are the review tools' own snake_case property names; the vendored acknowledge
// execution names them as CLI flags, so only those names are mapped here. Every other rule of the schema is kept.
const ARGUMENT_RENAMES: Record<string, string> = { lineage: "lineage_id", target: "target_identity", "expected-revision": "expected_revision" };
const load = (id: string): unknown => {
  const schema = loadRaw(id);
  const ack = schema?.$defs?.approved_acknowledgement_execution?.properties?.arguments?.prefixItems as { properties: { name: { const: string } } }[] | undefined;
  for (const item of ack ?? []) item.properties.name.const = ARGUMENT_RENAMES[item.properties.name.const] ?? item.properties.name.const;
  return schema;
};

function statusViolations(envelope: unknown): string[] {
  const path = join(V2, "status-v5.schema.json");
  const schema = clone(load(path)) as any;
  delete schema.allOf; // authority/applicability coupling of the reference lineage model
  delete schema.$defs.next_transition.allOf; // reason-specific rules of reference-only transitions
  delete schema.$defs.transition_input.allOf;
  schema.$defs.transition_input.properties.artifact_subject = true; // own subject shape (artifact.ts), checked in artifact.spec
  schema.properties.consumed = true; // documented extension
  schema.$defs.transition_collection.properties.command = true; // documented extension: the tool that admits the collect
  schema.$defs.transition_collection.properties.arguments = true;
  schema.$defs.transition_input.properties.command = true; // documented extension: the tool that takes this input
  return validate(schema as Schema, envelope, { base: path, load });
}

function checked(env: StatusEnvelope): StatusEnvelope {
  assert.deepEqual(statusViolations(env), []);
  assert.equal(env.forecast.steps[0].kind, env.next_transition.kind);
  assert.equal(env.forecast.steps[0].reason_code, env.next_transition.reason_code);
  assert.equal(env.forecast.horizon, env.next_transition.kind === "stop" ? "terminal" : "partial");
  return env;
}

// ---- tests ----

test("fresh target: execute review.start bound to the target, nothing written", async () => {
  const r = makeRepo();
  try {
    const env = checked(reviewStatus(r.repo));
    assert.equal(env.next_transition.kind, "execute");
    assert.equal(env.next_transition.reason_code, "fresh_target_ready");
    const ex = env.next_transition.execute!;
    assert.equal(ex.operation, "review.start");
    assert.deepEqual(ex.binding, { target_identity: env.target_identity });
    assert.equal(ex.arguments.find((a) => a.name === "target_identity")?.value, env.target_identity);
    assert.equal(env.action, "start");
    assert.deepEqual(env.consumed, { status: "not_consumed", truncated: false, problems: [] });
    assert.equal(env.authority, undefined);
    assert.equal(existsSync(storeRootFor(r.commonDir)), false);
  } finally {
    r.cleanup();
  }
});

test("fresh low-risk target: execute review.start with the low-risk reason", () => {
  const r = makeRepo({ dirty: "docs" });
  try {
    const env = checked(reviewStatus(r.repo));
    assert.equal(env.next_transition.reason_code, "native_low_risk_verification");
    assert.equal(env.next_transition.execute?.operation, "review.start");
  } finally {
    r.cleanup();
  }
});

test("started lineage: collect one binding per selected lens; bindings verify and then drift", async () => {
  const r = makeRepo();
  try {
    const started = await start(r, "high");
    const env = checked(reviewStatus(r.repo));
    assert.equal(env.authority?.lineage_id, started.lineage_id);
    assert.equal(env.authority?.state, "reviewing");
    assert.equal(env.next_transition.kind, "collect");
    assert.equal(env.next_transition.reason_code, "reviewer_results_required");
    const inputs = env.next_transition.collect!.inputs;
    assert.deepEqual(inputs.map((i) => i.name), ["risk", "resilience", "readability", "reliability"].map((l) => `reviewer_result_${l}`));
    const rec = readState(r.commonDir, started.lineage_id);
    for (const input of inputs) {
      const binding = input.arguments.find((a) => a.name === "binding")!.value;
      const ok = verifyBinding(binding, { targetIdentity: env.target_identity, lineage: rec, commonDir: r.commonDir });
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.equal(input.capture_operation, "review.capture-result");
    }
    // one lens admitted: the revision moves, the old bindings drift, the pending set shrinks
    const after = await mutate(r, started.lineage_id, admit("risk"));
    const stale = verifyBinding(inputs[1]!.arguments.find((a) => a.name === "binding")!.value, { targetIdentity: env.target_identity, lineage: after, commonDir: r.commonDir });
    assert.deepEqual({ ok: stale.ok, code: stale.ok ? "" : stale.code, field: stale.ok ? "" : stale.field }, { ok: false, code: "binding_drift", field: "revision" });
    const env2 = checked(reviewStatus(r.repo));
    assert.equal(env2.next_transition.collect!.inputs.length, 3);
  } finally {
    r.cleanup();
  }
});

test("reviewing, all lenses admitted with a blocking finding: optional refuter is collected", async () => {
  const r = makeRepo();
  try {
    const started = await start(r, "medium");
    const finding = { id: "R1-001", lens: "risk", severity: "BLOCKER", location: "a.txt:1", claim: "x", evidence_class: "deterministic", causal_disposition: "introduced" };
    await mutate(r, started.lineage_id, admit("risk", [finding]));
    const env = checked(reviewStatus(r.repo));
    assert.equal(env.next_transition.kind, "collect");
    assert.equal(env.next_transition.reason_code, "refuter_results_available");
  } finally {
    r.cleanup();
  }
});

test("correction_required: collect the corrected candidate", async () => {
  const r = makeRepo();
  try {
    const started = await start(r, "medium");
    const finding = { id: "R1-001", lens: "risk", severity: "BLOCKER", location: "a.txt:1", claim: "x", evidence_class: "deterministic", causal_disposition: "introduced" };
    await mutate(r, started.lineage_id, admit("risk", [finding]));
    await mutate(r, started.lineage_id, (rec) => requireCorrection(rec, { fixFindingIds: ["R1-001"], now: NOW }));
    const env = checked(reviewStatus(r.repo));
    assert.equal(env.authority?.state, "correction_required");
    assert.equal(env.next_transition.reason_code, "correction_required");
    assert.equal(env.next_transition.collect!.inputs[0]!.name, "corrected_candidate");
  } finally {
    r.cleanup();
  }
});

test("all lenses admitted and approved: execute acknowledge-approved with the supplied token", async () => {
  const r = makeRepo();
  try {
    const started = await start(r, "high");
    for (const lens of started.selected_lenses) await mutate(r, started.lineage_id, admit(lens.replace(/^review-/, "")));
    let token = "";
    const approved = await mutate(r, started.lineage_id, (rec) => {
      const o = approve(rec, { now: NOW });
      if (o.ok) token = o.ackToken;
      return o;
    });
    const ack = { lineage_id: approved.lineage_id, target_identity: approved.target_identity, expected_revision: approved.revision, token };
    const env = checked(reviewStatus(r.repo, { acknowledgement: ack }));
    assert.equal(env.next_transition.kind, "execute");
    assert.equal(env.next_transition.reason_code, "approved_acknowledgement_required");
    const ex = env.next_transition.execute!;
    assert.equal(ex.operation, "review.acknowledge-approved");
    assert.deepEqual(ex.arguments.map((a) => a.name), ["cwd", "lineage_id", "target_identity", "expected_revision", "token"]);
    assert.equal(ex.arguments[4]!.value, token);
    assert.deepEqual(ex.binding, { lineage_id: approved.lineage_id, revision: approved.revision, target_identity: approved.target_identity });
    // without the token the approval cannot be offered (recoverable stop); a mismatching one is refused as unverifiable
    const noToken = checked(reviewStatus(r.repo));
    assert.equal(noToken.next_transition.reason_code, "acknowledgement_token_unavailable");
    assert.equal(isRecoverableStop(noToken.next_transition.reason_code), true);
    const wrong = checked(reviewStatus(r.repo, { acknowledgement: { ...ack, expected_revision: HASH } }));
    assert.equal(wrong.next_transition.reason_code, "corrupted_or_unverifiable_authority");
  } finally {
    r.cleanup();
  }
});

test("burned target: stop target_already_acknowledged and consumed true", async () => {
  const r = makeRepo();
  try {
    const started = await start(r, "low");
    const ack = started.acknowledgement!;
    await acknowledgeApproved(r.commonDir, { lineage: ack.lineage_id, target: ack.target_identity, expectedRevision: ack.expected_revision, token: ack.token });
    const env = checked(reviewStatus(r.repo));
    assert.equal(env.next_transition.kind, "stop");
    assert.equal(env.next_transition.reason_code, "target_already_acknowledged");
    assert.equal(isTerminalStop("target_already_acknowledged"), true);
    assert.equal(env.consumed.status, "consumed");
    assert.equal(env.action, "stop");
  } finally {
    r.cleanup();
  }
});

test("burned state without a valid receipt: consumed is unknown (not consumed), reported; start still refuses", async () => {
  const r = makeRepo();
  try {
    const started = await start(r, "low");
    const ack = started.acknowledgement!;
    await acknowledgeApproved(r.commonDir, { lineage: ack.lineage_id, target: ack.target_identity, expectedRevision: ack.expected_revision, token: ack.token });
    const dir = join(storeRootFor(r.commonDir), started.lineage_id);
    const receipt = readdirSync(dir).find((f) => f.includes("receipt"))!;
    rmSync(join(dir, receipt));
    const env = checked(reviewStatus(r.repo));
    assert.equal(env.consumed.status, "unknown");
    assert.equal(env.consumed.problems.length > 0, true);
    assert.equal(env.next_transition.reason_code, "target_already_acknowledged");
  } finally {
    r.cleanup();
  }
});

test("escalated and invalidated lineages stop", async () => {
  const r = makeRepo();
  try {
    const started = await start(r, "high");
    await mutate(r, started.lineage_id, (rec) => escalate(rec, { reason: "needs a human", now: NOW }));
    const esc = checked(reviewStatus(r.repo));
    assert.equal(esc.next_transition.reason_code, "escalated");
    assert.equal(esc.forecast.horizon, "terminal");
    assert.equal(isTerminalStop("escalated"), true);
  } finally {
    r.cleanup();
  }
  const r2 = makeRepo();
  try {
    const started = await start(r2, "high");
    await mutate(r2, started.lineage_id, (rec) => invalidate(rec, { reason: "scope changed", now: NOW }));
    const inv = checked(reviewStatus(r2.repo));
    assert.equal(inv.next_transition.reason_code, "invalidated");
    assert.equal(isRecoverableStop("invalidated"), true);
  } finally {
    r2.cleanup();
  }
});

test("empty diff: stop not_due, no store", async () => {
  const r = makeRepo({ dirty: false });
  try {
    const env = checked(reviewStatus(r.repo));
    assert.equal(env.next_transition.kind, "stop");
    assert.equal(env.next_transition.reason_code, "not_due");
    assert.deepEqual(env.projection.paths, []);
    assert.equal(existsSync(storeRootFor(r.commonDir)), false);
    assert.equal(existsSync(join(r.commonDir, "odd-plugin")), false);
  } finally {
    r.cleanup();
  }
});

test("a declined candidate stops with consent_declined; reading never creates lineages", async () => {
  const r = makeRepo();
  try {
    const o = await startReview({ cwd: r.repo, target: { kind: "current-changes" }, consent: "declined", riskAssessor: assessor("high") });
    assert.equal(o.status, "declined");
    const env = checked(reviewStatus(r.repo));
    assert.equal(env.next_transition.reason_code, "consent_declined");
    assert.deepEqual(listLineages(r.commonDir).lineages, []);
  } finally {
    r.cleanup();
  }
});
