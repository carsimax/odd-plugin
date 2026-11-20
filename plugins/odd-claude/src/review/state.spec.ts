import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { domainHash } from "./canonical.js";
import {
  STATE_SCHEMA,
  correctionBudget,
  findingIdPrefixForLens,
  validateStateRecord,
  stateRevision,
  start,
  admitLensResult,
  admitValidatorResult,
  admitRefuterResult,
  findingDisposition,
  blockingFindingIds,
  inconclusiveFindingIds,
  requireCorrection,
  beginValidation,
  approve,
  escalate,
  invalidate,
  burn,
  type StateRecord,
  type StartInput,
  type Finding,
  type Outcome,
} from "./state.js";

const T0 = "2026-11-19T10:00:00.000Z";
const T1 = "2026-11-19T10:05:00.000Z";
const hex = (c: string, n = 64) => c.repeat(n).slice(0, n);
const sha = (c: string) => `sha256:${hex(c)}`;
const FIXED_TOKEN = "ab".repeat(32);

function startInput(over: Partial<StartInput> = {}): StartInput {
  return {
    lineageId: `review-${hex("a", 16)}`,
    targetIdentity: sha("1"),
    projection: "workspace",
    baseTree: hex("b", 40),
    candidateTree: hex("c", 40),
    riskLevel: "medium",
    selectedLenses: ["reliability"],
    originalChangedLines: 8,
    now: T0,
    ...over,
  };
}

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

function clean(lens: string, n = "1") {
  return { lens, findings: [] as Finding[], resultHash: sha(n), now: T0 };
}
function severe(lens: string, id: string): Finding {
  return { id, lens, severity: "CRITICAL", location: "a.ts:1", claim: "boom" };
}

const startReviewing = () => ok(start(startInput())).record;
const startApproved = () => {
  const r = ok(approve(ok(admitLensResult(startReviewing(), clean("reliability"))).record, { now: T1, randomToken: () => FIXED_TOKEN }));
  return r;
};
function toCorrectionRequired(): StateRecord {
  const a = ok(admitLensResult(startReviewing(), { lens: "reliability", findings: [severe("reliability", "R3-001")], resultHash: sha("2"), now: T0 })).record;
  return ok(requireCorrection(a, { fixFindingIds: ["R3-001"], now: T1 })).record;
}
const toValidating = () => ok(beginValidation(toCorrectionRequired(), { actualCorrectionLines: 2, now: T1 })).record;

const STATES: Record<string, () => StateRecord> = {
  reviewing: startReviewing,
  correction_required: toCorrectionRequired,
  validating: toValidating,
  approved: () => startApproved().record,
  escalated: () => ok(escalate(startReviewing(), { reason: "x", now: T1 })).record,
  invalidated: () => ok(invalidate(startReviewing(), { reason: "x", now: T1 })).record,
};

// ---- budget vectors (CompactCorrectionBudget, floor_two) ----

for (const [lines, budget] of [[0, 0], [1, 2], [2, 2], [3, 2], [4, 2], [5, 3], [8, 4], [399, 200], [400, 200], [401, 200], [100000, 200]] as const) {
  test(`correctionBudget(${lines}) = ${budget}`, () => assert.equal(correctionBudget(lines), budget));
}
test("correctionBudget rejects negative and non-integer", () => {
  assert.throws(() => correctionBudget(-1));
  assert.throws(() => correctionBudget(1.5));
});

test("finding id prefixes per lens", () => {
  assert.equal(findingIdPrefixForLens("risk"), "R1-");
  assert.equal(findingIdPrefixForLens("readability"), "R2-");
  assert.equal(findingIdPrefixForLens("reliability"), "R3-");
  assert.equal(findingIdPrefixForLens("resilience"), "R4-");
  assert.equal(findingIdPrefixForLens("nope"), "");
});

// ---- start ----

test("start medium -> reviewing record with frozen budget and valid revision", () => {
  const r = ok(start(startInput()));
  assert.equal(r.record.schema, STATE_SCHEMA);
  assert.equal(STATE_SCHEMA, "odd-claude.review-state/v2");
  assert.equal(r.record.state, "reviewing");
  assert.equal(r.record.correction_budget, 4);
  assert.equal(r.record.correction_budget_policy, "floor_two");
  assert.equal(r.record.correction_attempts, 0);
  assert.equal(r.record.burned, false);
  assert.equal(r.record.revision, stateRevision(r.record));
  assert.equal("ackToken" in r, false);
  assert.deepEqual(validateStateRecord(r.record), { ok: true, record: r.record });
});

test("start low risk with no lenses is directly approved with a token hash, never the raw token", () => {
  const r = ok(start(startInput({ riskLevel: "low", selectedLenses: [], randomToken: () => FIXED_TOKEN })));
  assert.equal(r.record.state, "approved");
  assert.equal(r.ackToken, FIXED_TOKEN);
  assert.equal(r.record.approved_ack_token_hash, domainHash("approved-ack-token", 1, FIXED_TOKEN));
  assert.equal(JSON.stringify(r.record).includes(FIXED_TOKEN), false);
  assert.equal(validateStateRecord(r.record).ok, true);
});

test("start high risk accepts one to four distinct lenses in canonical order, nothing else", () => {
  const all = ["risk", "resilience", "readability", "reliability"];
  assert.equal(ok(start(startInput({ riskLevel: "high", selectedLenses: all }))).record.selected_lenses.length, 4);
  for (const good of [["risk"], ["risk", "reliability"], ["resilience", "readability", "reliability"]]) {
    const r = ok(start(startInput({ riskLevel: "high", selectedLenses: good })));
    assert.deepEqual(r.record.selected_lenses, good);
    assert.equal(r.record.state, "reviewing");
    assert.deepEqual(validateStateRecord(r.record), { ok: true, record: r.record });
  }
  for (const bad of [[], [...all].reverse(), [...all.slice(0, 3), "risk"], ["risk", "risk"], ["risk", "bogus"], ["review-risk"], [...all, "risk"]]) {
    assert.equal(start(startInput({ riskLevel: "high", selectedLenses: bad })).ok, false, JSON.stringify(bad));
  }
});

test("lens counts per risk: low 0, medium exactly 1, high 1..4", () => {
  assert.equal(start(startInput({ riskLevel: "medium", selectedLenses: ["risk", "reliability"] })).ok, false);
  assert.equal(start(startInput({ riskLevel: "medium", selectedLenses: [] })).ok, false);
  assert.equal(start(startInput({ riskLevel: "low", selectedLenses: ["risk"] })).ok, false);
  rejects(mutate(startReviewing(), (o) => { o.selected_lenses = ["risk", "reliability"]; }), /selected_lenses/);
  const high = ok(start(startInput({ riskLevel: "high", selectedLenses: ["risk", "reliability"] }))).record;
  assert.equal(validateStateRecord(high).ok, true);
  rejects(mutate(high, (o) => { o.selected_lenses = []; }), /selected_lenses/);
  rejects(mutate(high, (o) => { o.selected_lenses = ["reliability", "risk"]; }), /selected_lenses/);
});

test("start rejects bad inputs with typed refusals", () => {
  const cases: Array<Partial<StartInput>> = [
    { lineageId: "review-xyz" },
    { targetIdentity: "sha256:abc" },
    { projection: "head" as never },
    { baseTree: "zz" },
    { riskLevel: "medium", selectedLenses: [] },
    { riskLevel: "low", selectedLenses: ["risk"] },
    { riskLevel: "medium", selectedLenses: ["bogus"] },
    { originalChangedLines: -1 },
    { now: "yesterday" },
  ];
  for (const c of cases) {
    const r = start(startInput(c));
    assert.equal(r.ok, false, JSON.stringify(c));
    if (!r.ok) assert.equal(r.refusal.code, "invalid_input");
  }
});

// ---- validation ----

test("validateStateRecord accepts every state fixture", () => {
  for (const [name, build] of Object.entries(STATES)) {
    const v = validateStateRecord(JSON.parse(JSON.stringify(build())));
    assert.equal(v.ok, true, `${name}: ${JSON.stringify(v)}`);
  }
});

function mutate(rec: StateRecord, fn: (o: Record<string, unknown>) => void, reseal = true): unknown {
  const o = JSON.parse(JSON.stringify(rec)) as Record<string, unknown>;
  fn(o);
  if (reseal) o.revision = stateRevision(o as unknown as StateRecord);
  return o;
}
function rejects(input: unknown, needle: RegExp) {
  const v = validateStateRecord(input);
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.errors.some((e) => needle.test(e)), v.errors.join(" | "));
}

test("validateStateRecord rejects non-objects, unknown fields, and a stale revision", () => {
  for (const x of [null, 3, "s", [], undefined]) assert.equal(validateStateRecord(x).ok, false);
  rejects(mutate(startReviewing(), (o) => { o.extra = 1; }), /unknown field/);
  rejects(mutate(startReviewing(), (o) => { o.state = "approved"; }, false), /revision/);
  rejects(mutate(startReviewing(), (o) => { delete o.lineage_id; }), /lineage_id/);
});

test("validateStateRecord rejects bad enums and formats", () => {
  const base = startReviewing();
  rejects(mutate(base, (o) => { o.schema = "other.review-state/v2"; }), /schema/);
  rejects(mutate(base, (o) => { o.state = "unreviewed"; }), /state/);
  rejects(mutate(base, (o) => { o.lineage_id = "review-ABCDEF0123456789"; }), /lineage_id/);
  rejects(mutate(base, (o) => { o.target_identity = "sha256:ABC"; }), /target_identity/);
  rejects(mutate(base, (o) => { o.projection = "committed"; }), /projection/);
  rejects(mutate(base, (o) => { o.base_tree = "nothex"; }), /base_tree/);
  rejects(mutate(base, (o) => { o.risk_level = "extreme"; }), /risk_level/);
  rejects(mutate(base, (o) => { o.selected_lenses = ["reliability", "reliability"]; }), /selected_lenses/);
  rejects(mutate(base, (o) => { o.selected_lenses = ["review-risk"]; }), /selected_lenses/);
  rejects(mutate(base, (o) => { o.created_at = "nope"; }), /created_at/);
  rejects(mutate(base, (o) => { o.updated_at = "2026-11-19T09:00:00.000Z"; }), /updated_at/);
  rejects(mutate(base, (o) => { o.correction_budget = 99; }), /correction_budget/);
  rejects(mutate(base, (o) => { o.correction_budget_policy = "legacy"; }), /correction_budget_policy/);
});

test("validateStateRecord: empty lens set only for low risk", () => {
  rejects(mutate(startReviewing(), (o) => { o.selected_lenses = []; }), /selected_lenses/);
  const low = ok(start(startInput({ riskLevel: "low", selectedLenses: [] }))).record;
  assert.equal(validateStateRecord(low).ok, true);
});

test("validateStateRecord: approved needs ack token hash; burned needs approved; attempts <= 1; admitted <= 6", () => {
  const approved = startApproved().record;
  rejects(mutate(approved, (o) => { delete o.approved_ack_token_hash; }), /approved_ack_token_hash/);
  rejects(mutate(approved, (o) => { o.approved_ack_token_hash = "raw-token"; }), /approved_ack_token_hash/);
  rejects(mutate(approved, (o) => { o.burned = true; }), /burn_receipt/);
  rejects(mutate(startReviewing(), (o) => { o.burned = true; o.burn_receipt = sha("9"); }), /burned/);
  rejects(mutate(startReviewing(), (o) => { o.approved_ack_token_hash = sha("9"); }), /approved_ack_token_hash/);
  rejects(mutate(toValidating(), (o) => { o.correction_attempts = 2; }), /correction_attempts/);
  rejects(
    mutate(startReviewing(), (o) => {
      o.admitted_role_results = Array.from({ length: 7 }, (_, i) => ({ role: "refuter", lens: "reliability", result_hash: sha(String(i)), artifact_digest: sha("f") }));
    }),
    /admitted_role_results/,
  );
  rejects(mutate(approved, (o) => { o.evidence_hash = sha("0"); }), /evidence_hash/);
});

test("validateStateRecord: state-specific invariants", () => {
  rejects(mutate(toCorrectionRequired(), (o) => { o.fix_finding_ids = []; }), /fix_finding_ids/);
  rejects(mutate(toValidating(), (o) => { o.actual_correction_lines = 999; }), /actual_correction_lines/);
  rejects(mutate(STATES.escalated!(), (o) => { delete o.escalation_reason; }), /escalation_reason/);
  rejects(mutate(STATES.invalidated!(), (o) => { delete o.invalidation_reason; }), /invalidation_reason/);
  rejects(mutate(startReviewing(), (o) => { o.escalation_reason = "x"; }), /escalation_reason/);
  rejects(mutate(toCorrectionRequired(), (o) => { delete o.ledger_hash; }), /ledger_hash/);
});

test("validateStateRecord: findings bound to selected lens prefix and unique", () => {
  const a = ok(admitLensResult(startReviewing(), { lens: "reliability", findings: [severe("reliability", "R3-001")], resultHash: sha("2"), now: T0 })).record;
  rejects(mutate(a, (o) => { (o.findings as Array<Record<string, unknown>>)[0]!.id = "R1-001"; }), /findings/);
  rejects(mutate(a, (o) => { o.findings = [...(o.findings as unknown[]), ...(o.findings as unknown[])]; }), /findings/);
  rejects(mutate(a, (o) => { (o.findings as Array<Record<string, unknown>>)[0]!.severity = "WHATEVER"; }), /findings/);
  rejects(mutate(a, (o) => { (o.findings as Array<Record<string, unknown>>)[0]!.extra = 1; }), /unknown field/);
});

// ---- revision ----

test("stateRevision ignores key order and the revision field itself; changes with content", () => {
  const rec = startReviewing();
  const reversed = Object.fromEntries(Object.entries(rec).reverse()) as unknown as StateRecord;
  assert.equal(stateRevision(reversed), stateRevision(rec));
  const { revision, ...rest } = rec;
  assert.equal(stateRevision(rec), domainHash("review-state", 2, rest));
  assert.equal(stateRevision({ ...rec, revision: sha("0") }), revision);
  assert.notEqual(stateRevision({ ...rec, updated_at: T1 }), revision);
  assert.equal(validateStateRecord(reversed).ok, true);
});

// ---- transitions: legality table ----

type Op = (r: StateRecord) => Outcome;
const OPS: Record<string, { run: Op; legal: string[] }> = {
  admitLensResult: { run: (r) => admitLensResult(r, clean("reliability")), legal: ["reviewing"] },
  admitValidatorResult: { run: (r) => admitValidatorResult(r, { resultHash: sha("7"), now: T1 }), legal: ["validating"] },
  requireCorrection: { run: (r) => requireCorrection(r, { fixFindingIds: ["R3-001"], now: T1 }), legal: ["reviewing"] },
  beginValidation: { run: (r) => beginValidation(r, { actualCorrectionLines: 2, now: T1 }), legal: ["correction_required"] },
  approve: { run: (r) => approve(r, { now: T1 }), legal: ["reviewing", "validating"] },
  escalate: { run: (r) => escalate(r, { reason: "r", now: T1 }), legal: ["reviewing", "correction_required", "validating"] },
  invalidate: { run: (r) => invalidate(r, { reason: "r", now: T1 }), legal: ["reviewing", "correction_required", "validating", "approved"] },
  burn: { run: (r) => burn(r, { token: FIXED_TOKEN, now: T1 }), legal: ["approved"] },
};

for (const [opName, { run, legal }] of Object.entries(OPS)) {
  for (const [stateName, build] of Object.entries(STATES)) {
    test(`${opName} from ${stateName}: ${legal.includes(stateName) ? "not an illegal-state refusal" : "illegal_state"}`, () => {
      const input = build();
      const before = JSON.stringify(input);
      const r = run(input);
      assert.equal(JSON.stringify(input), before, "input never mutated");
      if (legal.includes(stateName)) {
        if (!r.ok) assert.notEqual(r.refusal.code, "illegal_state");
      } else {
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.refusal.code, "illegal_state");
      }
    });
  }
}

// ---- transitions: behavior ----

test("admitLensResult freezes findings, binds prefixes and refuses duplicates/unselected/mismatched", () => {
  const rec = startReviewing();
  const bad = [
    { ...clean("risk") },
    { lens: "reliability", findings: [severe("reliability", "R1-001")], resultHash: sha("2"), now: T0 },
    { lens: "reliability", findings: [severe("reliability", "R3-001"), severe("reliability", "R3-001")], resultHash: sha("2"), now: T0 },
    { lens: "reliability", findings: [], resultHash: "nope", now: T0 },
    { lens: "reliability", findings: [{ ...severe("reliability", "R3-001"), severity: "??" }], resultHash: sha("2"), now: T0 },
  ];
  for (const b of bad) assert.equal(admitLensResult(rec, b).ok, false);
  const a = ok(admitLensResult(rec, { lens: "reliability", findings: [severe("reliability", "R3-001")], resultHash: sha("2"), now: T1 })).record;
  assert.equal(a.admitted_role_results.length, 1);
  assert.deepEqual(a.admitted_role_results[0]!.role, "lens");
  assert.equal(a.findings.length, 1);
  assert.equal(a.updated_at, T1);
  assert.equal(a.revision, stateRevision(a));
  const dup = admitLensResult(a, clean("reliability", "3"));
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.refusal.code, "lens_already_admitted");
});

test("approve from reviewing needs all lenses and no open severe findings", () => {
  const none = approve(startReviewing(), { now: T1 });
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.refusal.code, "lenses_incomplete");
  const sev = ok(admitLensResult(startReviewing(), { lens: "reliability", findings: [severe("reliability", "R3-001")], resultHash: sha("2"), now: T0 })).record;
  const r = approve(sev, { now: T1 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.refusal.code, "severe_findings_open");
});

test("approve issues the raw token once and stores only its sha256 domain hash", () => {
  const a = startApproved();
  assert.equal(a.ackToken, FIXED_TOKEN);
  assert.equal(a.record.approved_ack_token_hash, domainHash("approved-ack-token", 1, FIXED_TOKEN));
  assert.equal(JSON.stringify(a.record).includes(FIXED_TOKEN), false);
  assert.ok(a.record.ledger_hash && a.record.evidence_hash);
  assert.equal(validateStateRecord(a.record).ok, true);
});

test("approve default token is random 256-bit hex, unique per call", () => {
  const base = ok(admitLensResult(startReviewing(), clean("reliability"))).record;
  const t1 = ok(approve(base, { now: T1 })).ackToken;
  const t2 = ok(approve(base, { now: T1 })).ackToken;
  assert.match(t1, /^[0-9a-f]{64}$/);
  assert.notEqual(t1, t2);
});

test("correction flow: severe finding -> correction_required -> validating -> approved", () => {
  const cr = toCorrectionRequired();
  assert.equal(cr.state, "correction_required");
  assert.deepEqual(cr.fix_finding_ids, ["R3-001"]);
  assert.ok(cr.ledger_hash);
  const v = toValidating();
  assert.equal(v.correction_attempts, 1);
  assert.equal(v.actual_correction_lines, 2);
  const noValidator = approve(v, { now: T1 });
  assert.equal(noValidator.ok, false);
  if (!noValidator.ok) assert.equal(noValidator.refusal.code, "validator_missing");
  const withV = ok(admitValidatorResult(v, { resultHash: sha("7"), now: T1 })).record;
  assert.equal(withV.admitted_role_results.length, 2);
  const dupV = admitValidatorResult(withV, { resultHash: sha("8"), now: T1 });
  assert.equal(dupV.ok, false);
  const done = ok(approve(withV, { now: T1, randomToken: () => FIXED_TOKEN }));
  assert.equal(done.record.state, "approved");
  assert.equal(validateStateRecord(done.record).ok, true);
});

test("requireCorrection refusals: unknown/non-severe ids, empty, unsorted, incomplete lenses, zero budget", () => {
  const lensesIncomplete = requireCorrection(startReviewing(), { fixFindingIds: ["R3-001"], now: T1 });
  assert.equal(lensesIncomplete.ok, false);
  const a = ok(admitLensResult(startReviewing(), {
    lens: "reliability",
    findings: [severe("reliability", "R3-001"), { id: "R3-002", lens: "reliability", severity: "MINOR", location: "a:1", claim: "c" }],
    resultHash: sha("2"),
    now: T0,
  })).record;
  for (const ids of [[], ["R3-999"], ["R3-002"], ["R3-001", "R3-001"]]) {
    const r = requireCorrection(a, { fixFindingIds: ids, now: T1 });
    assert.equal(r.ok, false, JSON.stringify(ids));
  }
  const zero = ok(start(startInput({ originalChangedLines: 0 }))).record;
  const z = ok(admitLensResult(zero, { lens: "reliability", findings: [severe("reliability", "R3-001")], resultHash: sha("2"), now: T0 })).record;
  const r = requireCorrection(z, { fixFindingIds: ["R3-001"], now: T1 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.refusal.code, "correction_unavailable");
});

test("beginValidation refuses over-budget and invalid line counts", () => {
  const cr = toCorrectionRequired();
  const over = beginValidation(cr, { actualCorrectionLines: cr.correction_budget + 1, now: T1 });
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.refusal.code, "correction_over_budget");
  assert.equal(beginValidation(cr, { actualCorrectionLines: -1, now: T1 }).ok, false);
  assert.equal(beginValidation(cr, { actualCorrectionLines: 1.5, now: T1 }).ok, false);
  assert.equal(ok(beginValidation(cr, { actualCorrectionLines: cr.correction_budget, now: T1 })).record.state, "validating");
});

test("escalate and invalidate record reasons and require them", () => {
  assert.equal(escalate(startReviewing(), { reason: "  ", now: T1 }).ok, false);
  assert.equal(invalidate(startReviewing(), { reason: "", now: T1 }).ok, false);
  const e = ok(escalate(toValidating(), { reason: "validator failed", now: T1 })).record;
  assert.equal(e.state, "escalated");
  assert.equal(e.escalation_reason, "validator failed");
  const i = ok(invalidate(startApproved().record, { reason: "scope changed", now: T1 })).record;
  assert.equal(i.state, "invalidated");
  assert.equal(i.invalidation_reason, "scope changed");
  assert.equal("approved_ack_token_hash" in i, false);
  assert.equal(validateStateRecord(i).ok, true);
});

test("invalidate refuses a burned approval", () => {
  const a = startApproved();
  const burned = ok(burn(a.record, { token: a.ackToken, now: T1 })).record;
  const r = invalidate(burned, { reason: "x", now: T1 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.refusal.code, "already_burned");
});

// ---- burn ----

test("burn with the right token marks burned with a receipt; token never stored raw", () => {
  const a = startApproved();
  const b = ok(burn(a.record, { token: a.ackToken, now: T1 })).record;
  assert.equal(b.burned, true);
  assert.equal(b.state, "approved");
  assert.match(b.burn_receipt ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(b.updated_at, T1);
  assert.equal(JSON.stringify(b).includes(a.ackToken), false);
  assert.equal(validateStateRecord(b).ok, true);
  assert.equal(a.record.burned, false, "input not mutated");
});

test("burn binds the pre-burn revision as approved_revision; it is only valid on a burned record", () => {
  const a = startApproved();
  const b = ok(burn(a.record, { token: a.ackToken, now: T1 })).record;
  assert.equal(b.approved_revision, a.record.revision);
  assert.equal(validateStateRecord(b).ok, true);
  assert.equal(a.record.approved_revision, undefined);
  assert.equal(validateStateRecord(a.record).ok, true, "an unburned or legacy record without the field stays valid");
  rejects(mutate(a.record, (o) => { o.approved_revision = sha("9"); }), /approved_revision/);
  rejects(mutate(b, (o) => { o.approved_revision = "nope"; }), /approved_revision/);
});

test("burn with a wrong or malformed token is refused and changes nothing", () => {
  const a = startApproved();
  const wrong = burn(a.record, { token: "cd".repeat(32), now: T1 });
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.refusal.code, "token_mismatch");
  for (const t of ["", "abc", "AB".repeat(32), "zz".repeat(32), FIXED_TOKEN + "00", sha("a")]) {
    const r = burn(a.record, { token: t, now: T1 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.refusal.code, "token_malformed");
  }
  assert.equal(a.record.burned, false);
});

test("burn twice is refused", () => {
  const a = startApproved();
  const b = ok(burn(a.record, { token: a.ackToken, now: T1 })).record;
  const again = burn(b, { token: a.ackToken, now: T1 });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.refusal.code, "already_burned");
});

test("the token hash is a plain sha256 of the domain-separated token", () => {
  const manual = createHash("sha256").update(`odd-claude.approved-ack-token/v1\0${JSON.stringify(FIXED_TOKEN)}`, "utf8").digest("hex");
  assert.equal(domainHash("approved-ack-token", 1, FIXED_TOKEN), `sha256:${manual}`);
});

// ---- U6: finding dispositions, refuter admission, correction target ----

const sev = (lens: string, id: string, extra: Partial<Finding> = {}): Finding => ({ ...severe(lens, id), ...extra });

test("findingDisposition: severe findings block, follow up, stay inconclusive or are refuted", () => {
  const f = (extra: Partial<Finding>) => sev("reliability", "R3-001", extra);
  assert.equal(findingDisposition({ ...f({}), severity: "MAJOR" }), "clear");
  assert.equal(findingDisposition(f({})), "blocking");
  assert.equal(findingDisposition(f({ evidence_class: "deterministic", causal_disposition: "introduced" })), "blocking");
  assert.equal(findingDisposition(f({ causal_disposition: "worsened" })), "blocking");
  assert.equal(findingDisposition(f({ causal_disposition: "pre-existing" })), "follow_up");
  assert.equal(findingDisposition(f({ causal_disposition: "base-only" })), "follow_up");
  assert.equal(findingDisposition(f({ causal_disposition: "unknown" })), "inconclusive");
  assert.equal(findingDisposition(f({ evidence_class: "insufficient", causal_disposition: "introduced" })), "inconclusive");
  assert.equal(findingDisposition(f({}), ["R3-001"]), "refuted");
  assert.equal(findingDisposition(f({ causal_disposition: "unknown" }), ["R3-001"]), "inconclusive");
});

test("admitLensResult keeps evidence class and causal disposition and rejects unknown values", () => {
  const rec = ok(admitLensResult(startReviewing(), { lens: "reliability", findings: [sev("reliability", "R3-001", { evidence_class: "inferential", causal_disposition: "introduced" })], resultHash: sha("2"), now: T0 })).record;
  assert.equal(rec.findings[0]!.evidence_class, "inferential");
  assert.equal(rec.findings[0]!.causal_disposition, "introduced");
  assert.deepEqual(validateStateRecord(rec), { ok: true, record: rec });
  const bad = admitLensResult(startReviewing(), { lens: "reliability", findings: [sev("reliability", "R3-001", { causal_disposition: "maybe" })], resultHash: sha("2"), now: T0 });
  assert.equal(bad.ok, false);
  assert.equal(admitLensResult(startReviewing(), { lens: "reliability", findings: [sev("reliability", "R3-001", { severity: "WARNING" })], resultHash: sha("2"), now: T0 }).ok, true);
});

const reviewedWith = (...findings: Finding[]) => ok(admitLensResult(startReviewing(), { lens: "reliability", findings, resultHash: sha("2"), now: T0 })).record;

test("approve from reviewing: follow-ups and refuted findings do not block; inconclusive and blocking do", () => {
  const followUp = reviewedWith(sev("reliability", "R3-001", { causal_disposition: "pre-existing" }));
  assert.deepEqual(blockingFindingIds(followUp), []);
  assert.equal(approve(followUp, { now: T1, randomToken: () => FIXED_TOKEN }).ok, true);
  const unknown = reviewedWith(sev("reliability", "R3-001", { causal_disposition: "unknown" }));
  assert.deepEqual(inconclusiveFindingIds(unknown), ["R3-001"]);
  assert.equal(approve(unknown, { now: T1 }).ok, false);
  const blocking = reviewedWith(sev("reliability", "R3-001"));
  const refusal = approve(blocking, { now: T1 });
  assert.equal(!refusal.ok && refusal.refusal.code, "severe_findings_open");
  const refuted = ok(admitRefuterResult(blocking, { resultHash: sha("3"), refutedFindingIds: ["R3-001"], now: T1 })).record;
  assert.deepEqual(refuted.refuted_finding_ids, ["R3-001"]);
  assert.deepEqual(blockingFindingIds(refuted), []);
  const approved = ok(approve(refuted, { now: T1, randomToken: () => FIXED_TOKEN })).record;
  assert.equal(approved.state, "approved");
  assert.deepEqual(validateStateRecord(approved), { ok: true, record: approved });
});

test("admitRefuterResult: only from reviewing with every lens admitted, once, for blocking findings", () => {
  const blocking = reviewedWith(sev("reliability", "R3-001"));
  const input = { resultHash: sha("3"), refutedFindingIds: ["R3-001"], now: T1 };
  assert.equal(!ok(admitRefuterResult(blocking, { ...input, refutedFindingIds: [] })).record.refuted_finding_ids!.length, true);
  const code = (r: Outcome) => (r.ok ? "ok" : r.refusal.code);
  assert.equal(code(admitRefuterResult(startReviewing(), input)), "lenses_incomplete");
  assert.equal(code(admitRefuterResult(toCorrectionRequired(), input)), "illegal_state");
  assert.equal(code(admitRefuterResult(blocking, { ...input, refutedFindingIds: ["R3-009"] })), "invalid_input");
  assert.equal(code(admitRefuterResult(blocking, { ...input, refutedFindingIds: ["R3-001", "R3-001"] })), "invalid_input");
  assert.equal(code(admitRefuterResult(blocking, { ...input, resultHash: "nope" })), "invalid_input");
  const once = ok(admitRefuterResult(blocking, input)).record;
  assert.equal(code(admitRefuterResult(once, input)), "refuter_already_admitted");
  const pre = reviewedWith(sev("reliability", "R3-001", { causal_disposition: "pre-existing" }));
  assert.equal(code(admitRefuterResult(pre, input)), "invalid_input");
  // a refuted finding can no longer be named for the correction
  const other = ok(admitLensResult(startReviewing(), { lens: "reliability", findings: [sev("reliability", "R3-001"), sev("reliability", "R3-002")], resultHash: sha("2"), now: T0 })).record;
  const partly = ok(admitRefuterResult(other, { ...input, refutedFindingIds: ["R3-001"] })).record;
  assert.equal(code(requireCorrection(partly, { fixFindingIds: ["R3-001"], now: T1 })), "invalid_input");
  assert.equal(ok(requireCorrection(partly, { fixFindingIds: ["R3-002"], now: T1 })).record.state, "correction_required");
});

test("validateStateRecord: refuter results carry no lens and need refuted_finding_ids; correction target needs the attempt", () => {
  const blocking = reviewedWith(sev("reliability", "R3-001"));
  const refuted = ok(admitRefuterResult(blocking, { resultHash: sha("3"), refutedFindingIds: ["R3-001"], now: T1 })).record;
  rejects(mutate(refuted, (o) => { delete o.refuted_finding_ids; }), /refuter result requires refuted_finding_ids/);
  rejects(mutate(blocking, (o) => { o.refuted_finding_ids = ["R3-001"]; }), /requires an admitted refuter/);
  rejects(mutate(refuted, (o) => { (o.admitted_role_results as Array<Record<string, unknown>>)[1]!.lens = "reliability"; }), /refuter carries no lens/);
  const validating = ok(beginValidation(toCorrectionRequired(), { actualCorrectionLines: 2, correctionTargetIdentity: sha("4"), now: T1 })).record;
  assert.equal(validating.correction_target_identity, sha("4"));
  assert.deepEqual(validateStateRecord(validating), { ok: true, record: validating });
  rejects(mutate(toCorrectionRequired(), (o) => { o.correction_target_identity = sha("4"); }), /correction_target_identity/);
  rejects(mutate(validating, (o) => { o.correction_target_identity = "x"; }), /correction_target_identity/);
  const bad = beginValidation(toCorrectionRequired(), { actualCorrectionLines: 2, correctionTargetIdentity: "x", now: T1 });
  assert.equal(bad.ok, false);
  const inv = ok(invalidate(refuted, { reason: "x", now: T1 })).record;
  assert.equal("refuted_finding_ids" in inv, false);
});

// ---- correction: the validated corrected candidate becomes the lineage's current candidate ----

const CORRECTED_TREE = hex("d", 40);
function toApprovedAfterCorrection(withTree = true): StateRecord {
  const v = ok(beginValidation(toCorrectionRequired(), {
    actualCorrectionLines: 2, correctionTargetIdentity: sha("4"), ...(withTree ? { correctionCandidateTree: CORRECTED_TREE } : {}), now: T1,
  })).record;
  const a = ok(admitValidatorResult(v, { resultHash: sha("5"), now: T1 })).record;
  return ok(approve(a, { now: T1, randomToken: () => FIXED_TOKEN })).record;
}

test("approve after a validated correction binds the corrected candidate and keeps the original as history", () => {
  const ap = toApprovedAfterCorrection();
  assert.equal(ap.target_identity, sha("4"));
  assert.equal(ap.candidate_tree, CORRECTED_TREE);
  assert.equal(ap.original_target_identity, sha("1"));
  assert.equal(ap.original_candidate_tree, hex("c", 40));
  assert.deepEqual(validateStateRecord(ap), { ok: true, record: ap });
  // forged history / mismatching current candidate are rejected by the validator
  rejects(mutate(ap, (o) => { o.target_identity = sha("9"); }), /corrected candidate/);
  rejects(mutate(ap, (o) => { o.candidate_tree = hex("e", 40); }), /corrected candidate/);
  rejects(mutate(ap, (o) => { delete o.original_candidate_tree; }), /original/);
  rejects(mutate(toCorrectionRequired(), (o) => { o.original_target_identity = sha("1"); o.original_candidate_tree = hex("c", 40); }), /original/);
  // burn keeps the corrected candidate
  assert.equal(ok(burn(ap, { token: FIXED_TOKEN, now: T1 })).record.target_identity, sha("4"));
});

test("invalidating an approval after a correction restores the reviewed candidate", () => {
  const inv = ok(invalidate(toApprovedAfterCorrection(), { reason: "x", now: T1 })).record;
  assert.equal(inv.target_identity, sha("1"));
  assert.equal(inv.candidate_tree, hex("c", 40));
  for (const k of ["original_target_identity", "original_candidate_tree", "correction_candidate_tree", "correction_target_identity"]) assert.equal(k in inv, false, k);
  assert.equal(validateStateRecord(inv).ok, true);
});

test("approve refuses a validating record with a correction target but no corrected tree; the caller's tree completes it", () => {
  const legacy = ok(beginValidation(toCorrectionRequired(), { actualCorrectionLines: 2, correctionTargetIdentity: sha("4"), now: T1 })).record;
  const admitted = ok(admitValidatorResult(legacy, { resultHash: sha("5"), now: T1 })).record;
  const refused = approve(admitted, { now: T1, randomToken: () => FIXED_TOKEN });
  assert.equal(refused.ok, false, "the original must never stay the target of an approval after a correction");
  assert.equal(approve(admitted, { now: T1, correctionCandidateTree: "zz" }).ok, false);
  const done = ok(approve(admitted, { now: T1, randomToken: () => FIXED_TOKEN, correctionCandidateTree: CORRECTED_TREE })).record;
  assert.equal(done.target_identity, sha("4"));
  assert.equal(done.candidate_tree, CORRECTED_TREE);
  assert.equal(done.correction_candidate_tree, CORRECTED_TREE);
  assert.equal(done.original_target_identity, sha("1"));
  assert.deepEqual(validateStateRecord(done), { ok: true, record: done });
});

test("approved with correction_candidate_tree but no original_* is rejected (the store fails closed on a missing swap)", () => {
  const ap = toApprovedAfterCorrection();
  rejects(mutate(ap, (o) => { delete o.original_target_identity; delete o.original_candidate_tree; o.target_identity = sha("1"); o.candidate_tree = hex("c", 40); }), /original/);
  rejects(mutate(ap, (o) => { delete o.original_target_identity; delete o.original_candidate_tree; }), /original|corrected candidate/);
  // approved with a correction target but no corrected tree and no history: the original would be consumed
  rejects(mutate(ap, (o) => {
    delete o.original_target_identity; delete o.original_candidate_tree; delete o.correction_candidate_tree;
    o.target_identity = sha("1"); o.candidate_tree = hex("c", 40);
  }), /original|corrected candidate/);
});

test("escalating a validated-and-failed correction binds the corrected candidate, like an approval", () => {
  const v = ok(beginValidation(toCorrectionRequired(), { actualCorrectionLines: 2, correctionTargetIdentity: sha("4"), correctionCandidateTree: CORRECTED_TREE, now: T1 })).record;
  const e = ok(escalate(v, { reason: "still broken", now: T1 })).record;
  assert.equal(e.state, "escalated");
  assert.equal(e.target_identity, sha("4"));
  assert.equal(e.candidate_tree, CORRECTED_TREE);
  assert.equal(e.original_target_identity, sha("1"));
  assert.deepEqual(validateStateRecord(e), { ok: true, record: e });
  rejects(mutate(e, (o) => { delete o.original_target_identity; delete o.original_candidate_tree; }), /original|corrected candidate/);
  // escalating without a correction (or without a known corrected tree) keeps the reviewed candidate
  assert.equal(ok(escalate(toCorrectionRequired(), { reason: "x", now: T1 })).record.target_identity, sha("1"));
  const legacy = ok(beginValidation(toCorrectionRequired(), { actualCorrectionLines: 2, correctionTargetIdentity: sha("4"), now: T1 })).record;
  const le = ok(escalate(legacy, { reason: "x", now: T1 })).record;
  assert.equal(le.target_identity, sha("1"));
  assert.equal(validateStateRecord(le).ok, true);
  assert.equal(ok(escalate(legacy, { reason: "x", now: T1, correctionCandidateTree: CORRECTED_TREE })).record.target_identity, sha("4"));
});

test("approve and escalate refuse a correctionCandidateTree on a record without a correction target", () => {
  const plain = ok(beginValidation(toCorrectionRequired(), { actualCorrectionLines: 2, now: T1 })).record;
  const admitted = ok(admitValidatorResult(plain, { resultHash: sha("5"), now: T1 })).record;
  assert.equal(approve(admitted, { now: T1, correctionCandidateTree: CORRECTED_TREE }).ok, false);
  assert.equal(escalate(admitted, { reason: "x", now: T1, correctionCandidateTree: CORRECTED_TREE }).ok, false);
  // without the tree they behave as before
  assert.equal(approve(admitted, { now: T1 }).ok, true);
  assert.equal(escalate(admitted, { reason: "x", now: T1 }).ok, true);
});

// ---- defense in depth: an unchanged correction never reaches `validating` (state-level, like the reference CompleteCorrection) ----

test("beginValidation refuses a corrected identity or tree equal to the reviewed candidate (correction_unavailable)", () => {
  const cr = toCorrectionRequired();
  const sameIdentity = beginValidation(cr, { now: T1, actualCorrectionLines: 0, correctionTargetIdentity: cr.target_identity, correctionCandidateTree: cr.candidate_tree });
  assert.equal(sameIdentity.ok, false);
  if (!sameIdentity.ok) assert.equal(sameIdentity.refusal.code, "correction_unavailable");
  const onlyIdentity = beginValidation(cr, { now: T1, actualCorrectionLines: 0, correctionTargetIdentity: cr.target_identity });
  assert.equal(onlyIdentity.ok === false && onlyIdentity.refusal.code, "correction_unavailable");
  const sameTree = beginValidation(cr, { now: T1, actualCorrectionLines: 1, correctionTargetIdentity: sha("4"), correctionCandidateTree: cr.candidate_tree });
  assert.equal(sameTree.ok === false && sameTree.refusal.code, "correction_unavailable");
  // a distinct corrected candidate still opens validation
  assert.equal(beginValidation(cr, { now: T1, actualCorrectionLines: 1, correctionTargetIdentity: sha("4"), correctionCandidateTree: hex("d", 40) }).ok, true);
});

test("validateStateRecord rejects a validating record whose correction candidate equals the reviewed one", () => {
  const v = toValidating();
  const withCorrection = ok(beginValidation(toCorrectionRequired(), { now: T1, actualCorrectionLines: 1, correctionTargetIdentity: sha("4"), correctionCandidateTree: hex("d", 40) })).record;
  assert.equal(validateStateRecord(withCorrection).ok, true);
  rejects(mutate(withCorrection, (o) => { o.correction_target_identity = o.target_identity; }), /unchanged|equal|same/);
  rejects(mutate(withCorrection, (o) => { o.correction_candidate_tree = o.candidate_tree; }), /unchanged|equal|same/);
  rejects(mutate(v, (o) => { o.correction_target_identity = o.target_identity; }), /unchanged|equal|same/);
});
