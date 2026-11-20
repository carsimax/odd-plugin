import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AckRefusedError, type AcknowledgeResult } from "./ack.js";
import {
  ACK_SCHEMA, CAPTURE_DRY_RUN_SCHEMA, decodeBinding, encodeAckEnvelope, encodeBinding, encodeCaptureDryRun, encodeCaptureEnvelope,
  encodeConsentEnvelope, encodeStartEnvelope, forecastFor, isRecoverableStop, isTerminalStop, REASON_DESCRIPTIONS, RECOVERABLE_STOP_CODES,
  TERMINAL_STOP_CODES, verifyBinding, type TransitionBinding,
} from "./contract.js";
import { CONSENT_SCHEMA, INVOCATION_PREFIX, offPathCommand, REVIEW_CONTRACT, reviewCommand } from "./consent.js";
import { validate, type Schema } from "./schema.js";
import { START_SCHEMA, type StartResult } from "./start.js";
import type { StateRecord } from "./state.js";
import { clone, INTEGRATION_ROOT } from "./fixtures.testkit.js";

const sha = (c: string) => `sha256:${c.repeat(64)}`;
const rec = (over: Partial<StateRecord> = {}): StateRecord => ({ lineage_id: "review-0123456789abcdef", revision: sha("a"), target_identity: sha("b"), state: "reviewing", burned: false, ...over }) as StateRecord;
const binding: TransitionBinding = { role: "lens", lens: "risk", target_identity: sha("b"), lineage_id: "review-0123456789abcdef", revision: sha("a") };
const failureOf = (r: ReturnType<typeof verifyBinding>) => (r.ok ? undefined : { code: r.code, field: r.field });

const V2 = join(INTEGRATION_ROOT, "v2", "schemas");
const UPSTREAM = ["gentle", "ai"].join("-"); // vendored ids carry the upstream product prefix
const load = (id: string): unknown => JSON.parse(readFileSync(id, "utf8").replaceAll(`${UPSTREAM}.review`, "odd-claude.review"));
const check = (file: string, patch: (s: any) => void, value: unknown): string[] => {
  const path = join(V2, file);
  const schema = clone(load(path)) as any;
  patch(schema);
  return validate(schema as Schema, value, { base: path, load });
};

test("stop reason codes: terminal and recoverable are disjoint, typed and described", () => {
  const all = [...TERMINAL_STOP_CODES, ...RECOVERABLE_STOP_CODES];
  assert.equal(new Set(all).size, all.length);
  for (const c of TERMINAL_STOP_CODES) assert.deepEqual([isTerminalStop(c), isRecoverableStop(c)], [true, false]);
  for (const c of RECOVERABLE_STOP_CODES) assert.deepEqual([isTerminalStop(c), isRecoverableStop(c)], [false, true]);
  for (const c of ["not_due", "escalated", "invalidated", "target_already_acknowledged", "correction_budget_exhausted"]) assert.equal(all.includes(c as never), true, c);
  for (const [code, text] of Object.entries(REASON_DESCRIPTIONS)) assert.match(code, /^[a-z0-9_]+$/), assert.notEqual(text, "");
  assert.deepEqual(forecastFor("stop", "escalated").horizon, "terminal");
  assert.deepEqual(forecastFor("collect", "reviewer_results_required").steps, [{ step: 1, kind: "collect", reason_code: "reviewer_results_required", description: REASON_DESCRIPTIONS.reviewer_results_required }]);
});

test("binding round trip: opaque, deterministic, signed with a domain hash", () => {
  const s = encodeBinding(binding);
  assert.match(s, /^odd1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
  assert.equal(encodeBinding({ ...binding }), s);
  const d = decodeBinding(s);
  assert.deepEqual(d.ok && d.binding, binding);
  const v = verifyBinding(s, { targetIdentity: sha("b"), lineage: rec() });
  assert.equal(v.ok, true);
});

test("binding tampering, foreign strings and malformed payloads are invalid_binding", () => {
  const s = encodeBinding(binding);
  const [p, payload, tag] = s.split(".") as [string, string, string];
  const forged = Buffer.from(JSON.stringify({ ...binding, revision: sha("c") })).toString("base64url");
  for (const bad of [`${p}.${forged}.${tag}`, `${p}.${payload}.${"0".repeat(64)}`, "nope", `${p}.${payload}`, 5, undefined, `gentle1.${payload}.${tag}`]) {
    const r = decodeBinding(bad);
    assert.equal(!r.ok && r.code, "invalid_binding", String(bad));
  }
  // correctly tagged but a lineage binding without lineage/revision, or an unknown field
  assert.equal(decodeBinding(encodeBinding({ role: "lens", target_identity: sha("b") })).ok, false);
  assert.equal(decodeBinding(encodeBinding({ ...binding, extra: 1 } as never)).ok, false);
});

test("binding drift: target, lineage, revision, state and subject are refused with a typed field", () => {
  const s = encodeBinding(binding);
  const cur = { targetIdentity: sha("b"), lineage: rec() };
  assert.deepEqual(failureOf(verifyBinding(s, { ...cur, targetIdentity: sha("d") })), { code: "binding_drift", field: "target" });
  assert.deepEqual(failureOf(verifyBinding(s, { ...cur, lineage: undefined })), { code: "binding_drift", field: "lineage" });
  assert.deepEqual(failureOf(verifyBinding(s, { ...cur, lineage: rec({ lineage_id: "review-ffffffffffffffff" }) })), { code: "binding_drift", field: "lineage" });
  assert.deepEqual(failureOf(verifyBinding(s, { ...cur, lineage: rec({ revision: sha("e") }) })), { code: "binding_drift", field: "revision" });
  assert.deepEqual(failureOf(verifyBinding(s, { ...cur, lineage: rec({ state: "escalated" }) })), { code: "binding_drift", field: "state" });
  // a signed binding carrying a subject that cannot be re-derived (no repository) or no longer matches
  const withSubject = encodeBinding({ ...binding, subject_hash: sha("9") });
  assert.deepEqual(failureOf(verifyBinding(withSubject, cur)), { code: "binding_drift", field: "subject" });
  assert.deepEqual(failureOf(verifyBinding(withSubject, { ...cur, commonDir: "/nonexistent-odd-claude-dir" })), { code: "binding_drift", field: "subject" });
  // an acknowledge binding is stale once burned; a start binding is stale once a lineage exists
  const ack = encodeBinding({ ...binding, role: "acknowledge" });
  assert.equal(verifyBinding(ack, { ...cur, lineage: rec({ state: "approved" }) }).ok, true);
  assert.deepEqual(failureOf(verifyBinding(ack, { ...cur, lineage: rec({ state: "approved", burned: true }) })), { code: "binding_drift", field: "state" });
  const startB = encodeBinding({ role: "start", target_identity: sha("b") });
  assert.equal(verifyBinding(startB, { targetIdentity: sha("b") }).ok, true);
  assert.deepEqual(failureOf(verifyBinding(startB, cur)), { code: "binding_drift", field: "lineage" });
});

test("consent envelope: one command constant, invocations derive from it", () => {
  assert.equal(INVOCATION_PREFIX, "review_answer_consent");
  assert.equal(reviewCommand("start"), "review_start");
  assert.match(offPathCommand(), /^node .*[\\/]dist[\\/]cli[\\/]review-mode\.js disable$/);
  assert.equal(offPathCommand().includes("<plugin>"), false);
  const env = encodeConsentEnvelope({
    cwd: "/r", targetIdentity: sha("b"), projection: "workspace", riskLevel: "high", changedFiles: 1, changedLines: 2, riskEvidence: ["e"], targetArgs: ["--target", "current-changes"],
  });
  assert.equal(env.schema, CONSENT_SCHEMA);
  for (const c of env.choices) assert.equal(c.invocation.startsWith(`${INVOCATION_PREFIX} --contract ${REVIEW_CONTRACT} `), true);
  const errs = check(
    "consent-v3.schema.json",
    (s) => {
      s.properties.off_path.properties.command.const = offPathCommand();
      s.$defs.choice.properties.invocation.pattern = "^review_answer_consent --contract odd-claude\\.review-integration/v2 .+ --consent (granted|declined)$";
    },
    encodeStartEnvelope({ status: "consent_required", envelope: env }),
  );
  assert.deepEqual(errs, []);
});

const startResult: StartResult = {
  schema: START_SCHEMA, contract: REVIEW_CONTRACT, operation: "review.start", action: "created", lenses_required: true, lineage_id: "review-0123456789abcdef", state: "reviewing",
  risk_level: "high", selected_lenses: ["review-risk"], projection: "workspace", target_identity: sha("b"), base_tree: "1".repeat(40), candidate_tree: "2".repeat(40),
  changed_files: 1, changed_lines: 2, correction_budget: 2, risk_reasons: [{ code: "shell_source" }], artifact_subjects: [],
};

test("start envelopes: started is the start/v4 result; other outcomes are typed", () => {
  assert.deepEqual(encodeStartEnvelope({ status: "started", result: startResult }), startResult);
  assert.equal(encodeStartEnvelope({ status: "not_due", reason: "no_changes", kind: "current-changes", projection: "workspace" }).reason_code, "not_due");
  assert.equal(encodeStartEnvelope({ status: "declined", target_identity: sha("b"), projection: "workspace", risk_level: "high", record_path: "/p" }).reason_code, "consent_declined");
  const refused = encodeStartEnvelope({ status: "refused", code: "target_already_acknowledged", message: "m", lineage_id: "review-0123456789abcdef" });
  assert.deepEqual([refused.code, refused.lineage_id, refused.outcome], ["target_already_acknowledged", "review-0123456789abcdef", "refused"]);
});

test("capture envelopes: dry run validates against the vendored schema; results and refusals are typed", () => {
  const dry = encodeCaptureDryRun({ lineage_id: "review-0123456789abcdef", lens: "risk", selected_order: 0, subject_hash: sha("1") });
  assert.equal(dry.schema, CAPTURE_DRY_RUN_SCHEMA);
  assert.deepEqual(check("capture-result-dry-run.schema.json", () => {}, dry), []);
  assert.equal(dry.lens, "review-risk");
  const ok = encodeCaptureEnvelope({
    ok: true, state: "approved", next: "approved", ackToken: "f".repeat(64), revision: sha("a"), record: rec({ state: "approved" }), pending_lenses: ["resilience"],
  });
  assert.deepEqual([ok.outcome, ok.state, ok.next, ok.pending_lenses], ["captured", "approved", "approved", ["review-resilience"]]);
  assert.deepEqual(ok.acknowledgement, { lineage_id: "review-0123456789abcdef", target_identity: sha("b"), expected_revision: sha("a"), token: "f".repeat(64) });
  const noToken = encodeCaptureEnvelope({ ok: true, state: "reviewing", next: "collect", revision: sha("a"), record: rec(), pending_lenses: [] });
  assert.equal("acknowledgement" in noToken, false);
  const refused = encodeCaptureEnvelope({ ok: false, code: "concurrent_update", message: "m", currentRevision: sha("c") });
  assert.deepEqual([refused.outcome, refused.code, refused.current_revision], ["refused", "concurrent_update", sha("c")]);
});

test("acknowledge envelopes: acknowledged carries the receipt; refusals keep the typed code", () => {
  const receipt = {
    schema: "odd-claude.review-receipt/v1", lineage_id: "review-0123456789abcdef", target_identity: sha("b"), projection: "workspace", base_tree: "1".repeat(40), candidate_tree: "2".repeat(40),
    approved_revision: sha("a"), burned_at: "2026-11-19T10:00:00.000Z", selected_lenses: ["risk"], risk_level: "high", ledger_hash: sha("3"), evidence_hash: sha("4"), burn_receipt: sha("5"), receipt_hash: sha("6"),
  } as AcknowledgeResult["receipt"];
  const env = encodeAckEnvelope({ ok: true, record: rec({ state: "approved", burned: true }), receipt });
  assert.deepEqual([env.schema, env.outcome, env.burned, env.operation], [ACK_SCHEMA, "acknowledged", true, "review.acknowledge-approved"]);
  assert.deepEqual(env.receipt, receipt);
  const refused = encodeAckEnvelope(new AckRefusedError("wrong_token", "bad"));
  assert.deepEqual([refused.outcome, refused.code], ["refused", "wrong_token"]);
});
