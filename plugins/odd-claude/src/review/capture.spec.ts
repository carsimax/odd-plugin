import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBEDDED_RESULT_SCHEMAS,
  beginCorrectionValidation,
  captureCorrectionResult,
  captureLensResult,
  captureRefuterResult,
  captureValidatorResult,
  completeReview,
  planCorrection,
  previewCorrectionValidation,
  resultSchemaErrors,
  type CaptureOutcome,
  type CaptureStatus,
} from "./capture.js";
import { lensArtifactSubject, refuterRequestHash, targetedValidationRequestHash, treeDiffPaths } from "./artifact.js";
import { freezeSnapshot, type RepositoryIdentity } from "./snapshot.js";
import { startReview, type RiskAssessment } from "./start.js";
import { MAX_ADMITTED_ROLE_RESULTS, type StateRecord } from "./state.js";
import { readState } from "./store.js";
import { MIRROR_ROOT, clone, readJson } from "./fixtures.testkit.js";

// ---- helpers: real temp git repos, removed in teardown ----

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

const A_ORIGINAL = "one\ntwo\nthree\n";
const A_CHANGED = A_ORIGINAL + Array.from({ length: 20 }, (_, i) => `a-added-${i}\n`).join("");
const B_CHANGED = "bee\n" + Array.from({ length: 10 }, (_, i) => `b-added-${i}\n`).join("");

interface Fx {
  repo: string;
  commonDir: string;
  repository: RepositoryIdentity;
  cleanup: () => void;
}

/** 30 changed lines in a.txt (20) and b.txt (10): correction budget 15. */
async function fixture(level: RiskAssessment["level"] = "medium"): Promise<{ fx: Fx; lineage: string; record: StateRecord }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-capture-")));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), A_ORIGINAL);
  writeFileSync(join(repo, "b.txt"), "bee\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  writeFileSync(join(repo, "a.txt"), A_CHANGED);
  writeFileSync(join(repo, "b.txt"), B_CHANGED);
  const out = await startReview({
    cwd: repo,
    target: { kind: "current-changes" },
    consent: "granted",
    riskAssessor: () => ({ level, reasons: [{ code: "shell_source", signal: "shell_process", path: "a.txt" }], evidence: ["shell scripting in a.txt"] }),
  });
  assert.equal(out.status, "started");
  if (out.status !== "started") throw new Error("start failed");
  const commonDir = realpathSync(join(repo, ".git"));
  const frozen = freezeSnapshot(repo, { kind: "current-changes" });
  if (frozen.status !== "frozen") throw new Error("not frozen");
  const fx: Fx = { repo, commonDir, repository: frozen.repository, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  const lineage = out.result.lineage_id;
  return { fx, lineage, record: readState(commonDir, lineage) };
}

const SEVERE = {
  location: "a.txt:1",
  severity: "CRITICAL",
  claim: "a.txt breaks on empty input",
  proof_refs: ["a.txt:1 reads the first line unchecked"],
  evidence_class: "deterministic",
  causal_disposition: "introduced",
};

function lensInput(fx: Fx, record: StateRecord, lens: string, findings: unknown[] = [], tweak: (result: Record<string, unknown>) => void = () => {}) {
  const subject = lensArtifactSubject(fx.commonDir, record, lens)!;
  const result: Record<string, unknown> = {
    subject_hash: subject.subject_hash,
    inspection: { status: "completed", paths: treeDiffPaths(fx.commonDir, record.base_tree, record.candidate_tree) },
    findings,
    evidence: ["reviewed the complete candidate scope"],
  };
  tweak(result);
  return { lens, subject, result };
}

function good(o: CaptureOutcome): CaptureStatus {
  assert.equal(o.ok, true, JSON.stringify(o, (k, v) => (k === "record" ? undefined : v)));
  return o as CaptureStatus;
}
function refused(o: { ok: boolean }, code: string) {
  assert.equal(o.ok, false, "expected a refusal");
  const r = o as unknown as { code: string; message: string; errors?: string[]; currentRevision?: string };
  assert.equal(r.code, code, r.message);
  return r;
}

/** Captures every selected lens in order; `findingsOf` picks the findings per lens. Returns the last status. */
async function captureAll(fx: Fx, lineage: string, findingsOf: (lens: string) => unknown[] = () => [], opts = {}): Promise<CaptureStatus> {
  let status!: CaptureStatus;
  let record = readState(fx.commonDir, lineage);
  for (const lens of record.selected_lenses) {
    status = good(await captureLensResult(fx.commonDir, lineage, record.revision, lensInput(fx, record, lens, findingsOf(lens)), opts));
    record = status.record;
  }
  return status;
}

const unchanged = (fx: Fx, lineage: string, revision: string) => assert.equal(readState(fx.commonDir, lineage).revision, revision);
const TOKEN = /^[0-9a-f]{64}$/;

function editA(fx: Fx, content: string, file = "a.txt") {
  writeFileSync(join(fx.repo, file), content);
  const f = freezeSnapshot(fx.repo, { kind: "current-changes" });
  if (f.status !== "frozen") throw new Error("not frozen");
  return { candidateTree: f.snapshot.candidateTree, identity: f.snapshot.identity };
}

// ---- happy paths ----

test("one lens, no findings: capture admits and approves, returning the token once", async () => {
  const { fx, lineage, record } = await fixture();
  try {
    assert.equal(record.state, "reviewing");
    const status = good(await captureLensResult(fx.commonDir, lineage, record.revision, lensInput(fx, record, "risk")));
    assert.equal(status.state, "approved");
    assert.equal(status.next, "approved");
    assert.match(status.ackToken!, TOKEN);
    assert.deepEqual(status.pending_lenses, []);
    const stored = readState(fx.commonDir, lineage);
    assert.equal(stored.revision, status.revision);
    assert.equal(stored.state, "approved");
    assert.equal(stored.admitted_role_results.length, 1);
    assert.equal(stored.admitted_role_results[0]!.lens, "risk");
    assert.match(stored.admitted_role_results[0]!.result_hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(stored.admitted_role_results[0]!.artifact_digest, lensArtifactSubject(fx.commonDir, record, "risk")!.subject_hash);
    assert.equal(JSON.stringify(stored).includes(status.ackToken!), false);
    // the lineage is closed: another capture is refused and the token is not issued again
    refused(await captureLensResult(fx.commonDir, lineage, stored.revision, lensInput(fx, record, "risk")), "illegal_state");
  } finally {
    fx.cleanup();
  }
});

test("review- prefixed lens names, ids assigned natively and non-severe findings do not block", async () => {
  const { fx, lineage, record } = await fixture();
  try {
    const minor = { location: "a.txt:2", severity: "WARNING", claim: "naming", proof_refs: ["a.txt:2"] };
    const status = good(await captureLensResult(fx.commonDir, lineage, record.revision, { ...lensInput(fx, record, "risk", [minor, { ...minor, severity: "SUGGESTION" }]), lens: "review-risk" }));
    assert.equal(status.next, "approved");
    assert.deepEqual(status.record.findings.map((f) => f.id), ["R1-1", "R1-2"]);
    assert.deepEqual(status.record.findings.map((f) => f.severity), ["WARNING", "SUGGESTION"]);
  } finally {
    fx.cleanup();
  }
});

test("four lenses with a CRITICAL: collect until the last, then correction_required with the frozen ledger", async () => {
  const { fx, lineage } = await fixture("high");
  try {
    let record = readState(fx.commonDir, lineage);
    assert.deepEqual(record.selected_lenses, ["risk", "resilience", "readability", "reliability"]);
    const seen: CaptureStatus[] = [];
    for (const lens of record.selected_lenses) {
      const s = good(await captureLensResult(fx.commonDir, lineage, record.revision, lensInput(fx, record, lens, lens === "readability" ? [SEVERE] : [])));
      seen.push(s);
      record = s.record;
    }
    assert.deepEqual(seen.map((s) => s.next), ["collect", "collect", "collect", "correction_required"]);
    assert.deepEqual(seen.map((s) => s.pending_lenses.length), [3, 2, 1, 0]);
    assert.equal(seen.every((s) => s.ackToken === undefined), true);
    const last = seen[3]!;
    assert.equal(last.state, "correction_required");
    assert.deepEqual(last.record.fix_finding_ids, ["R2-1"]);
    assert.match(last.record.ledger_hash!, /^sha256:[0-9a-f]{64}$/);
    assert.equal(last.record.findings[0]!.causal_disposition, "introduced");
  } finally {
    fx.cleanup();
  }
});

test("pre-existing and base-only severe findings are follow-ups: approved; unknown causality or insufficient evidence: escalated", async () => {
  for (const [patch, state] of [
    [{ causal_disposition: "pre-existing" }, "approved"],
    [{ causal_disposition: "base-only" }, "approved"],
    [{ causal_disposition: "unknown" }, "escalated"],
    [{ evidence_class: "insufficient" }, "escalated"],
  ] as const) {
    const { fx, lineage } = await fixture();
    try {
      const s = await captureAll(fx, lineage, () => [{ ...SEVERE, ...patch }]);
      assert.equal(s.state, state, JSON.stringify(patch));
      assert.equal(s.next, state);
      assert.equal(s.ackToken !== undefined, state === "approved");
      if (state === "escalated") assert.match(s.record.escalation_reason!, /unknown causality or insufficient evidence: R1-1/);
    } finally {
      fx.cleanup();
    }
  }
});

// ---- refuter ----

const INFERENTIAL = { ...SEVERE, evidence_class: "inferential" };
const refuterResult = (record: StateRecord, results: Array<{ finding_id: string; outcome: string }>) => ({
  refuter_request_hash: refuterRequestHash(record),
  results: results.map((r) => ({ ...r, proof_refs: ["a.txt:1 handles the empty input"] })),
});

test("refuter refutes the only blocking finding: held for the refuter, then approved with a token", async () => {
  const { fx, lineage } = await fixture();
  try {
    const held = await captureAll(fx, lineage, () => [INFERENTIAL], { awaitRefuter: true });
    assert.equal(held.state, "reviewing");
    assert.equal(held.next, "collect");
    assert.deepEqual(held.pending_refutation, ["R1-1"]);
    assert.equal(held.ackToken, undefined);
    const s = good(await captureRefuterResult(fx.commonDir, lineage, held.revision, { result: refuterResult(held.record, [{ finding_id: "R1-1", outcome: "refuted" }]) }));
    assert.equal(s.state, "approved");
    assert.equal(s.next, "approved");
    assert.match(s.ackToken!, TOKEN);
    assert.deepEqual(s.record.refuted_finding_ids, ["R1-1"]);
    assert.equal(s.record.admitted_role_results.filter((e) => e.role === "refuter").length, 1);
    refused(await captureRefuterResult(fx.commonDir, lineage, s.revision, { result: refuterResult(held.record, []) }), "illegal_state");
  } finally {
    fx.cleanup();
  }
});

test("refuter that corroborates, is inconclusive or is silent leaves the finding blocking: correction_required", async () => {
  for (const results of [[{ finding_id: "R1-1", outcome: "corroborated" }], [{ finding_id: "R1-1", outcome: "inconclusive" }], []]) {
    const { fx, lineage } = await fixture();
    try {
      const held = await captureAll(fx, lineage, () => [INFERENTIAL], { awaitRefuter: true });
      const s = good(await captureRefuterResult(fx.commonDir, lineage, held.revision, { result: refuterResult(held.record, results) }));
      assert.equal(s.next, "correction_required");
      assert.deepEqual(s.record.fix_finding_ids, ["R1-1"]);
      assert.deepEqual(s.record.refuted_finding_ids, []);
    } finally {
      fx.cleanup();
    }
  }
});

test("partly refuted: only the surviving finding goes to the correction", async () => {
  const { fx, lineage } = await fixture();
  try {
    const held = await captureAll(fx, lineage, () => [INFERENTIAL, { ...INFERENTIAL, location: "b.txt:1", claim: "b.txt also breaks" }], { awaitRefuter: true });
    assert.deepEqual(held.pending_refutation, ["R1-1", "R1-2"]);
    const s = good(await captureRefuterResult(fx.commonDir, lineage, held.revision, { result: refuterResult(held.record, [{ finding_id: "R1-2", outcome: "refuted" }]) }));
    assert.equal(s.next, "correction_required");
    assert.deepEqual(s.record.fix_finding_ids, ["R1-1"]);
    const plan = planCorrection(fx.commonDir, lineage);
    assert.equal(plan.ok, true);
    if (plan.ok) assert.deepEqual(plan.allowed_paths, ["a.txt"]);
  } finally {
    fx.cleanup();
  }
});

test("refuter refusals: bad schema, wrong request hash, unknown or repeated finding, second refuter, and nothing is admitted", async () => {
  const { fx, lineage } = await fixture();
  try {
    const held = await captureAll(fx, lineage, () => [INFERENTIAL], { awaitRefuter: true });
    const ok1 = refuterResult(held.record, [{ finding_id: "R1-1", outcome: "refuted" }]);
    refused(await captureRefuterResult(fx.commonDir, lineage, held.revision, { result: { results: [] } }), "schema_invalid");
    refused(await captureRefuterResult(fx.commonDir, lineage, held.revision, { result: { ...ok1, results: [{ finding_id: "R1-1", outcome: "maybe", proof_refs: ["x"] }] } }), "schema_invalid");
    refused(await captureRefuterResult(fx.commonDir, lineage, held.revision, { result: { ...ok1, refuter_request_hash: `sha256:${"0".repeat(64)}` } }), "binding_drift");
    refused(await captureRefuterResult(fx.commonDir, lineage, held.revision, { result: refuterResult(held.record, [{ finding_id: "R1-9", outcome: "refuted" }]) }), "unknown_finding");
    refused(await captureRefuterResult(fx.commonDir, lineage, held.revision, { result: refuterResult(held.record, [{ finding_id: "R1-1", outcome: "refuted" }, { finding_id: "R1-1", outcome: "corroborated" }]) }), "invalid_input");
    refused(await captureRefuterResult(fx.commonDir, lineage, "sha256:stale", { result: ok1 }), "concurrent_update");
    unchanged(fx, lineage, held.revision);
    // completing without the refuter opens the correction; a refuter is then no longer admissible
    const done = good(await completeReview(fx.commonDir, lineage, held.revision));
    assert.equal(done.next, "correction_required");
    refused(await captureRefuterResult(fx.commonDir, lineage, done.revision, { result: ok1 }), "illegal_state");
  } finally {
    fx.cleanup();
  }
});

test("completeReview is refused before every lens is admitted", async () => {
  const { fx, lineage, record } = await fixture("high");
  try {
    refused(await completeReview(fx.commonDir, lineage, record.revision), "lenses_incomplete");
    unchanged(fx, lineage, record.revision);
  } finally {
    fx.cleanup();
  }
});

// ---- correction ----

async function toCorrection() {
  const ctx = await fixture();
  const s = await captureAll(ctx.fx, ctx.lineage, () => [SEVERE]);
  assert.equal(s.next, "correction_required");
  return { ...ctx, correction: s };
}

const validatorResult = (record: StateRecord, over: Record<string, unknown> = {}) => ({
  targeted_validation_request_hash: targetedValidationRequestHash(record),
  correction_target_identity: record.correction_target_identity,
  original_criteria: { passed: true, evidence: ["a.txt:1 now guards the empty input"] },
  correction_regression: { passed: true, evidence: ["the regression test passes"] },
  follow_ups: [],
  ...over,
});

test("planCorrection returns the frozen severe findings, the budget and the allowed paths; only when a correction is pending", async () => {
  const { fx, lineage, correction } = await toCorrection();
  try {
    const plan = planCorrection(fx.commonDir, lineage);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.deepEqual(plan.findings.map((f) => f.id), ["R1-1"]);
    assert.equal(plan.budget, 15);
    assert.equal(plan.attempts_remaining, 2);
    assert.deepEqual(plan.allowed_paths, ["a.txt"]);
    assert.equal(plan.ledger_hash, correction.record.ledger_hash);
    assert.equal(plan.revision, correction.revision);
  } finally {
    fx.cleanup();
  }
  const other = await fixture();
  try {
    refused(planCorrection(other.fx.commonDir, other.lineage), "illegal_state");
  } finally {
    other.fx.cleanup();
  }
});

test("correction within budget and scope -> validating -> approved with a token", async () => {
  const { fx, lineage, correction } = await toCorrection();
  try {
    const corrected = editA(fx, A_CHANGED.replace("one\n", "ONE\n"));
    const v = good(await beginCorrectionValidation(fx.repository, lineage, correction.revision, corrected));
    assert.equal(v.state, "validating");
    assert.equal(v.next, "validating");
    assert.equal(v.record.correction_attempts, 1);
    assert.equal(v.record.actual_correction_lines, 2);
    assert.equal(v.record.correction_target_identity, corrected.identity);
    const s = good(await captureValidatorResult(fx.commonDir, lineage, v.revision, { result: validatorResult(v.record) }));
    assert.equal(s.state, "approved");
    assert.equal(s.next, "approved");
    assert.match(s.ackToken!, TOKEN);
    assert.equal(s.record.admitted_role_results.filter((e) => e.role === "validator").length, 1);
    assert.equal(s.record.admitted_role_results.length <= MAX_ADMITTED_ROLE_RESULTS, true);
    refused(await captureValidatorResult(fx.commonDir, lineage, s.revision, { result: validatorResult(v.record) }), "illegal_state");
  } finally {
    fx.cleanup();
  }
});

const FAIL_CRITERIA = { original_criteria: { passed: false, evidence: ["still broken"] } };
const FAIL_REGRESSION = { correction_regression: { passed: false, evidence: ["broke b"], regressions: [{ location: "a.txt:3", claim: "new bug", proof_refs: ["a.txt:3"] }] } };

test("a validator that fails either check reopens the second correction; its failure escalates and a third is refused", async () => {
  for (const over of [FAIL_CRITERIA, FAIL_REGRESSION]) {
    const { fx, lineage, correction } = await toCorrection();
    try {
      const first = editA(fx, A_CHANGED.replace("one\n", "ONE\n"));
      const v1 = good(await beginCorrectionValidation(fx.repository, lineage, correction.revision, first));
      const reopened = good(await captureValidatorResult(fx.commonDir, lineage, v1.revision, { result: validatorResult(v1.record, over), correctionCandidateTree: first.candidateTree }));
      assert.equal(reopened.state, "correction_required");
      assert.equal(reopened.next, "correction_required");
      assert.equal(reopened.ackToken, undefined);
      assert.equal(reopened.record.correction_attempts, 1);
      assert.equal(reopened.record.target_identity, first.identity, "the failed correction is the lineage's candidate");
      assert.equal(reopened.record.original_target_identity, correction.record.target_identity);
      assert.equal(reopened.record.admitted_role_results.some((e) => e.role === "validator"), false);
      assert.deepEqual(reopened.record.fix_finding_ids, correction.record.fix_finding_ids);
      assert.equal(reopened.record.correction_target_identity, undefined);
      const plan = planCorrection(fx.commonDir, lineage);
      assert.equal(plan.ok && plan.attempts_remaining, 1);

      // an unchanged candidate is still no correction
      refused(await beginCorrectionValidation(fx.repository, lineage, reopened.revision, first), "correction_unavailable");

      const second = editA(fx, A_CHANGED.replace("one\n", "UNO\n"));
      const v2 = good(await beginCorrectionValidation(fx.repository, lineage, reopened.revision, second));
      assert.equal(v2.state, "validating");
      assert.equal(v2.record.correction_attempts, 2);
      const s2 = good(await captureValidatorResult(fx.commonDir, lineage, v2.revision, { result: validatorResult(v2.record, over), correctionCandidateTree: second.candidateTree }));
      assert.equal(s2.state, "escalated");
      assert.equal(s2.next, "escalated");
      assert.equal(s2.ackToken, undefined);
      assert.match(s2.record.escalation_reason!, /targeted validator/);
      assert.equal(s2.record.correction_attempts, 2);
      assert.equal(s2.record.original_target_identity, correction.record.target_identity, "the first reviewed candidate stays the history");
      // no third correction, from any angle
      refused(planCorrection(fx.commonDir, lineage), "illegal_state");
      refused(await beginCorrectionValidation(fx.repository, lineage, s2.revision, editA(fx, A_CHANGED.replace("one\n", "EINS\n"))), "illegal_state");
      unchanged(fx, lineage, s2.revision);
    } finally {
      fx.cleanup();
    }
  }
});

test("the second correction can be approved; the approval binds the second corrected candidate", async () => {
  const { fx, lineage, correction } = await toCorrection();
  try {
    const first = editA(fx, A_CHANGED.replace("one\n", "ONE\n"));
    const v1 = good(await beginCorrectionValidation(fx.repository, lineage, correction.revision, first));
    const reopened = good(await captureValidatorResult(fx.commonDir, lineage, v1.revision, { result: validatorResult(v1.record, FAIL_CRITERIA), correctionCandidateTree: first.candidateTree }));
    const second = editA(fx, A_CHANGED.replace("one\n", "UNO\n"));
    const v2 = good(await beginCorrectionValidation(fx.repository, lineage, reopened.revision, second));
    const done = good(await captureValidatorResult(fx.commonDir, lineage, v2.revision, { result: validatorResult(v2.record), correctionCandidateTree: second.candidateTree }));
    assert.equal(done.state, "approved");
    assert.match(done.ackToken!, TOKEN);
    assert.equal(done.record.correction_attempts, 2);
    assert.equal(done.record.target_identity, second.identity);
    assert.equal(done.record.candidate_tree, second.candidateTree);
    assert.equal(done.record.original_target_identity, correction.record.target_identity);
  } finally {
    fx.cleanup();
  }
});

test("a lineage persisted before the change (one attempt, validating) still reads and resumes to approved", async () => {
  const { fx, lineage, correction } = await toCorrection();
  try {
    const corrected = editA(fx, A_CHANGED.replace("one\n", "ONE\n"));
    const v = good(await beginCorrectionValidation(fx.repository, lineage, correction.revision, corrected));
    const stored = readState(fx.commonDir, lineage);
    assert.equal(stored.correction_attempts, 1);
    assert.equal(stored.state, "validating");
    const done = good(await captureValidatorResult(fx.commonDir, lineage, v.revision, { result: validatorResult(stored), correctionCandidateTree: corrected.candidateTree }));
    assert.equal(done.state, "approved");
    assert.equal(done.record.correction_attempts, 1);
  } finally {
    fx.cleanup();
  }
});

test("a second correction is refused once validation has begun", async () => {
  const { fx, lineage, correction } = await toCorrection();
  try {
    const v = good(await beginCorrectionValidation(fx.repository, lineage, correction.revision, editA(fx, A_CHANGED.replace("one\n", "ONE\n"))));
    refused(planCorrection(fx.commonDir, lineage), "illegal_state");
    refused(await beginCorrectionValidation(fx.repository, lineage, v.revision, editA(fx, A_CHANGED.replace("one\n", "UNO\n"))), "illegal_state");
    unchanged(fx, lineage, v.revision);
  } finally {
    fx.cleanup();
  }
});

test("a correction that touches a path outside the frozen findings is refused and leaves the state untouched", async () => {
  const { fx, lineage, correction } = await toCorrection();
  try {
    const outside = editA(fx, B_CHANGED.replace("bee\n", "BEE\n"), "b.txt");
    const r = refused(await beginCorrectionValidation(fx.repository, lineage, correction.revision, outside), "correction_out_of_scope");
    assert.deepEqual(r.errors, ["b.txt"]);
    unchanged(fx, lineage, correction.revision);
    assert.equal(readState(fx.commonDir, lineage).state, "correction_required");
  } finally {
    fx.cleanup();
  }
});

test("a correction over the line budget is refused and leaves the state untouched", async () => {
  const { fx, lineage, correction } = await toCorrection();
  try {
    const big = editA(fx, A_CHANGED + Array.from({ length: 16 }, (_, i) => `more-${i}\n`).join(""));
    refused(await beginCorrectionValidation(fx.repository, lineage, correction.revision, big), "correction_over_budget");
    unchanged(fx, lineage, correction.revision);
    // exactly at the budget (15 lines) is accepted
    const exact = editA(fx, A_CHANGED + Array.from({ length: 15 }, (_, i) => `more-${i}\n`).join(""));
    assert.equal(good(await beginCorrectionValidation(fx.repository, lineage, correction.revision, exact)).record.actual_correction_lines, 15);
  } finally {
    fx.cleanup();
  }
});

test("validator refusals: schema, request hash, target identity, unavailable inspection; nothing is admitted", async () => {
  const { fx, lineage, correction } = await toCorrection();
  try {
    const v = good(await beginCorrectionValidation(fx.repository, lineage, correction.revision, editA(fx, A_CHANGED.replace("one\n", "ONE\n"))));
    const result = validatorResult(v.record);
    refused(await captureValidatorResult(fx.commonDir, lineage, v.revision, { result: { ...result, follow_ups: "none" } }), "schema_invalid");
    refused(await captureValidatorResult(fx.commonDir, lineage, v.revision, { result: validatorResult(v.record, { correction_regression: { passed: false, evidence: ["x"] } }) }), "schema_invalid");
    refused(await captureValidatorResult(fx.commonDir, lineage, v.revision, { result: { ...result, targeted_validation_request_hash: `sha256:${"0".repeat(64)}` } }), "binding_drift");
    refused(await captureValidatorResult(fx.commonDir, lineage, v.revision, { result: { ...result, correction_target_identity: `sha256:${"1".repeat(64)}` } }), "binding_drift");
    refused(
      await captureValidatorResult(fx.commonDir, lineage, v.revision, { result: validatorResult(v.record, { original_criteria: { passed: true, evidence: ["x"], inspection: { status: "unavailable", reason: "timed out" } } }) }),
      "inspection_unavailable",
    );
    refused(await captureValidatorResult(fx.commonDir, lineage, "sha256:stale", { result }), "concurrent_update");
    unchanged(fx, lineage, v.revision);
  } finally {
    fx.cleanup();
  }
});

// ---- binding, schema, duplicates ----

test("subject drift is refused with binding_drift and nothing is admitted", async () => {
  const { fx, lineage, record } = await fixture("high");
  try {
    const mine = lensInput(fx, record, "risk");
    const sibling = lensArtifactSubject(fx.commonDir, record, "reliability")!;
    // another lens's subject
    refused(await captureLensResult(fx.commonDir, lineage, record.revision, { ...mine, subject: sibling }), "binding_drift");
    // result echoing the wrong subject hash
    refused(await captureLensResult(fx.commonDir, lineage, record.revision, lensInput(fx, record, "risk", [], (r) => { r.subject_hash = sibling.subject_hash; })), "binding_drift");
    refused(await captureLensResult(fx.commonDir, lineage, record.revision, lensInput(fx, record, "risk", [], (r) => { r.subject_hash = `sha256:${"0".repeat(64)}`; })), "binding_drift");
    // tampered subject (self-hash broken) and subject from another candidate
    refused(await captureLensResult(fx.commonDir, lineage, record.revision, { ...mine, subject: { ...mine.subject, candidate_tree: "f".repeat(40) } }), "binding_drift");
    refused(await captureLensResult(fx.commonDir, lineage, record.revision, { ...mine, subject: { ...mine.subject, base_tree: "f".repeat(40), subject_hash: sibling.subject_hash } }), "binding_drift");
    refused(await captureLensResult(fx.commonDir, lineage, record.revision, { ...mine, subject: null as never }), "binding_drift");
    // the result names another lens
    refused(await captureLensResult(fx.commonDir, lineage, record.revision, lensInput(fx, record, "risk", [], (r) => { r.lens = "reliability"; })), "binding_drift");
    // a finding bound to another lens
    refused(await captureLensResult(fx.commonDir, lineage, record.revision, lensInput(fx, record, "risk", [{ ...SEVERE, lens: "reliability" }])), "binding_drift");
    unchanged(fx, lineage, record.revision);
    good(await captureLensResult(fx.commonDir, lineage, record.revision, mine));
  } finally {
    fx.cleanup();
  }
});

test("a subject from another lineage is binding_drift", async () => {
  const one = await fixture();
  const two = await fixture();
  try {
    const foreign = lensInput(two.fx, two.record, "risk");
    refused(await captureLensResult(one.fx.commonDir, one.lineage, one.record.revision, foreign), "binding_drift");
    unchanged(one.fx, one.lineage, one.record.revision);
  } finally {
    one.fx.cleanup();
    two.fx.cleanup();
  }
});

test("schema-invalid lens results are refused with errors and nothing is admitted", async () => {
  const { fx, lineage, record } = await fixture();
  try {
    const tries: Array<(r: Record<string, unknown>) => void> = [
      (r) => { delete r.evidence; },
      (r) => { r.evidence = ["n/a"]; },
      (r) => { r.extra = true; },
      (r) => { r.findings = [{ location: "a.txt:1", severity: "CRITICAL", claim: "x", proof_refs: ["y"] }]; },
      (r) => { r.findings = [{ location: "a.txt", severity: "MAJOR", claim: "x", proof_refs: ["y"] }]; },
      (r) => { r.inspection = { status: "unavailable", paths: [] }; },
      (r) => { r.subject_hash = "nope"; },
    ];
    for (const tweak of tries) {
      const r = refused(await captureLensResult(fx.commonDir, lineage, record.revision, lensInput(fx, record, "risk", [], tweak)), "schema_invalid");
      assert.equal((r.errors ?? []).length > 0, true);
    }
    refused(await captureLensResult(fx.commonDir, lineage, record.revision, { ...lensInput(fx, record, "risk"), result: "not json" }), "schema_invalid");
    unchanged(fx, lineage, record.revision);
  } finally {
    fx.cleanup();
  }
});

test("inspection must cover exactly the changed-path manifest; unavailable inspection is not admitted", async () => {
  const { fx, lineage, record } = await fixture();
  try {
    refused(await captureLensResult(fx.commonDir, lineage, record.revision, lensInput(fx, record, "risk", [], (r) => { r.inspection = { status: "completed", paths: ["a.txt"] }; })), "inspection_incomplete");
    refused(await captureLensResult(fx.commonDir, lineage, record.revision, lensInput(fx, record, "risk", [], (r) => { r.inspection = { status: "completed", paths: ["a.txt", "b.txt", "c.txt"] }; })), "inspection_incomplete");
    const un = refused(
      await captureLensResult(fx.commonDir, lineage, record.revision, lensInput(fx, record, "risk", [], (r) => { r.inspection = { status: "unavailable", paths: [], reason: "timed out" }; })),
      "inspection_unavailable",
    );
    assert.equal(un.message, "timed out");
    unchanged(fx, lineage, record.revision);
  } finally {
    fx.cleanup();
  }
});

test("a duplicate lens, an unselected lens and a stale revision are refused", async () => {
  const { fx, lineage, record } = await fixture("high");
  try {
    const first = good(await captureLensResult(fx.commonDir, lineage, record.revision, lensInput(fx, record, "risk")));
    refused(await captureLensResult(fx.commonDir, lineage, first.revision, lensInput(fx, record, "risk")), "lens_already_admitted");
    refused(await captureLensResult(fx.commonDir, lineage, first.revision, { ...lensInput(fx, record, "risk"), lens: "bogus" }), "invalid_input");
    const stale = refused(await captureLensResult(fx.commonDir, lineage, record.revision, lensInput(fx, record, "resilience")), "concurrent_update");
    assert.equal(stale.currentRevision, first.revision);
    assert.equal(readState(fx.commonDir, lineage).admitted_role_results.length, 1);
    unchanged(fx, lineage, first.revision);
  } finally {
    fx.cleanup();
  }
  const mono = await fixture();
  try {
    refused(await captureLensResult(mono.fx.commonDir, mono.lineage, mono.record.revision, { ...lensInput(mono.fx, mono.record, "risk"), lens: "resilience" }), "invalid_input");
  } finally {
    mono.fx.cleanup();
  }
});

// ---- concurrency ----

test("concurrent captures for different lenses on one lineage admit each lens exactly once (CAS)", async () => {
  const { fx, lineage, record } = await fixture("high");
  try {
    const attempts: Record<string, number> = {};
    const finals = await Promise.all(
      record.selected_lenses.map(async (lens) => {
        let revision = record.revision;
        for (;;) {
          attempts[lens] = (attempts[lens] ?? 0) + 1;
          const out = await captureLensResult(fx.commonDir, lineage, revision, lensInput(fx, record, lens));
          if (out.ok) return out;
          assert.equal(out.code, "concurrent_update", out.message);
          revision = out.currentRevision!;
        }
      }),
    );
    const stored = readState(fx.commonDir, lineage);
    assert.equal(stored.state, "approved");
    assert.deepEqual(stored.admitted_role_results.map((e) => e.lens).sort(), ["readability", "reliability", "resilience", "risk"]);
    assert.equal(finals.filter((f) => f.ackToken !== undefined).length, 1, "exactly one capture settles the review and receives the token");
    assert.equal(finals.filter((f) => f.next === "approved").length >= 1, true);
    assert.equal(Object.values(attempts).some((n) => n > 1), true, "at least one capture lost the CAS and retried");
  } finally {
    fx.cleanup();
  }
});

// ---- vendored provider-mirror vectors and embedded schema pinning ----

const MIRROR_NAMES = { lens: "lens", refuter: "refuter", validator: "targeted-validator" } as const;

for (const kind of ["lens", "refuter", "validator"] as const) {
  test(`provider-mirror ${kind} vector validates; embedded schema equals the vendored one except $id/title`, () => {
    const name = MIRROR_NAMES[kind];
    assert.deepEqual(resultSchemaErrors[kind](readJson(join(MIRROR_ROOT, "vectors", `${name}.json`))), []);
    const vendored = clone(readJson(join(MIRROR_ROOT, "schemas", `${name}.schema.json`))) as Record<string, unknown>;
    const embedded = clone(EMBEDDED_RESULT_SCHEMAS[kind]) as unknown as Record<string, unknown>;
    assert.match(String(embedded.$id), /^https:\/\/odd-claude\.dev\/schema\/review\//);
    delete vendored.$id;
    delete vendored.title;
    delete embedded.$id;
    delete embedded.title;
    assert.deepEqual(embedded, vendored);
    const examples = (vendored.examples ?? []) as unknown[];
    for (const example of examples) assert.deepEqual(resultSchemaErrors[kind](example), []);
  });
}

test("embedded schemas reject malformed results", () => {
  const lens = readJson(join(MIRROR_ROOT, "vectors", "lens.json")) as Record<string, unknown>;
  assert.notDeepEqual(resultSchemaErrors.lens({ ...lens, evidence: [] }), []);
  assert.notDeepEqual(resultSchemaErrors.lens({ ...lens, inspection: { status: "completed" } }), []);
  const validator = readJson(join(MIRROR_ROOT, "vectors", "targeted-validator.json")) as Record<string, unknown>;
  assert.notDeepEqual(resultSchemaErrors.validator({ ...validator, follow_ups: [{ observation: "x" }] }), []);
  assert.equal(readFileSync(join(MIRROR_ROOT, "vectors", "refuter.json"), "utf8").length > 0, true);
});

test("previewCorrectionValidation writes nothing; captureCorrectionResult records the attempt with the validator result in ONE transition", async () => {
  const { fx, lineage, correction } = await toCorrection();
  try {
    const corrected = editA(fx, A_CHANGED.replace("one\n", "ONE\n"));
    const preview = previewCorrectionValidation(fx.repository, lineage, correction.revision, corrected);
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    assert.equal(preview.record.state, "validating");
    unchanged(fx, lineage, correction.revision);
    assert.equal(readState(fx.commonDir, lineage).correction_attempts, 0);

    // refusals (scope) are the same as beginCorrectionValidation's and write nothing
    refused(previewCorrectionValidation(fx.repository, lineage, correction.revision, editA(fx, B_CHANGED.replace("bee\n", "BEE\n"), "b.txt")), "correction_out_of_scope");

    // a result that does not echo the preview's request hash is refused and the attempt is NOT spent
    const result = validatorResult(preview.record);
    refused(await captureCorrectionResult(fx.repository, lineage, correction.revision, corrected, { result: { ...result, targeted_validation_request_hash: `sha256:${"0".repeat(64)}` } }), "binding_drift");
    refused(await captureCorrectionResult(fx.repository, lineage, correction.revision, corrected, { result: { ...result, follow_ups: "none" } }), "schema_invalid");
    unchanged(fx, lineage, correction.revision);
    assert.equal(readState(fx.commonDir, lineage).correction_attempts, 0);
    refused(await captureCorrectionResult(fx.repository, lineage, "sha256:" + "9".repeat(64), corrected, { result }), "concurrent_update");

    const s = good(await captureCorrectionResult(fx.repository, lineage, correction.revision, corrected, { result }));
    assert.equal(s.state, "approved");
    assert.match(s.ackToken!, TOKEN);
    assert.equal(s.record.correction_attempts, 1);
    assert.equal(s.record.target_identity, corrected.identity, "the approved lineage's candidate is the corrected one");
    assert.equal(s.record.candidate_tree, corrected.candidateTree);
    assert.equal(s.record.admitted_role_results.filter((e) => e.role === "validator").length, 1);
    refused(await captureCorrectionResult(fx.repository, lineage, s.revision, corrected, { result }), "illegal_state");

    // a failing validator reopens the second correction in the same single transition (the attempt is consumed with it)
    const other = await toCorrection();
    try {
      const c2 = editA(other.fx, A_CHANGED.replace("one\n", "ONE\n"));
      const p2 = previewCorrectionValidation(other.fx.repository, other.lineage, other.correction.revision, c2);
      assert.equal(p2.ok, true);
      if (!p2.ok) return;
      const e = good(await captureCorrectionResult(other.fx.repository, other.lineage, other.correction.revision, c2, { result: validatorResult(p2.record, { original_criteria: { passed: false, evidence: ["still broken"] } }) }));
      assert.equal(e.state, "correction_required");
      assert.equal(e.record.correction_attempts, 1);
      assert.equal(e.record.target_identity, c2.identity);
      assert.equal(readState(other.fx.commonDir, other.lineage).revision, e.revision);
    } finally {
      other.fx.cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test("approving after beginCorrectionValidation + captureValidatorResult also binds the corrected candidate", async () => {
  const { fx, lineage, correction } = await toCorrection();
  try {
    const original = readState(fx.commonDir, lineage).target_identity;
    const corrected = editA(fx, A_CHANGED.replace("one\n", "ONE\n"));
    const v = good(await beginCorrectionValidation(fx.repository, lineage, correction.revision, corrected));
    assert.equal(v.record.target_identity, original, "validating still carries the reviewed candidate");
    assert.equal(v.record.correction_candidate_tree, corrected.candidateTree);
    const s = good(await captureValidatorResult(fx.commonDir, lineage, v.revision, { result: validatorResult(v.record) }));
    assert.equal(s.record.target_identity, corrected.identity);
    assert.equal(s.record.original_target_identity, original);
  } finally {
    fx.cleanup();
  }
});

test("an unchanged corrected candidate (same tree or same identity) is refused as correction_unavailable and leaves the state untouched", async () => {
  const { fx, lineage, correction } = await toCorrection();
  try {
    const current = readState(fx.commonDir, lineage);
    const sameTree = { candidateTree: current.candidate_tree, identity: `sha256:${"3".repeat(64)}` };
    const sameIdentity = editA(fx, A_CHANGED.replace("one\n", "ONE\n"));
    refused(await beginCorrectionValidation(fx.repository, lineage, correction.revision, sameTree), "correction_unavailable");
    refused(await beginCorrectionValidation(fx.repository, lineage, correction.revision, { ...sameIdentity, identity: current.target_identity }), "correction_unavailable");
    refused(previewCorrectionValidation(fx.repository, lineage, correction.revision, sameTree), "correction_unavailable");
    refused(await captureCorrectionResult(fx.repository, lineage, correction.revision, sameTree, { result: {} }), "correction_unavailable");
    unchanged(fx, lineage, correction.revision);
    // a genuinely changed candidate is still accepted
    good(await beginCorrectionValidation(fx.repository, lineage, correction.revision, sameIdentity));
  } finally {
    fx.cleanup();
  }
});

// ---- verifier regressions (S1): an unchanged correction is refused at every entry point ----

/** Captures the three entry points for a corrected candidate; every one must refuse with `correction_unavailable` and leave the state byte-identical. */
async function assertNotACorrection(fx: Fx, lineage: string, revision: string) {
  const f = freezeSnapshot(fx.repo, { kind: "current-changes" });
  if (f.status !== "frozen") throw new Error("not frozen");
  const corrected = { candidateTree: f.snapshot.candidateTree, identity: f.snapshot.identity };
  const file = join(fx.commonDir, "odd-plugin", "review-transactions", "v2", lineage, "review-state.json");
  const before = readFileSync(file, "utf8");
  refused(await beginCorrectionValidation(fx.repository, lineage, revision, corrected), "correction_unavailable");
  refused(previewCorrectionValidation(fx.repository, lineage, revision, corrected), "correction_unavailable");
  refused(await captureCorrectionResult(fx.repository, lineage, revision, corrected, { result: {} }), "correction_unavailable");
  assert.equal(readFileSync(file, "utf8"), before, "state byte-identical");
  unchanged(fx, lineage, revision);
}

test("S1: an ignored-only or CRLF-normalized change is not a correction (all three entry points)", async () => {
  const { fx, lineage, correction } = await toCorrection();
  try {
    // ignored-only: a new file matched by info/exclude does not enter the snapshot
    mkdirSync(join(fx.commonDir, "info"), { recursive: true });
    writeFileSync(join(fx.commonDir, "info", "exclude"), "ignored.txt\n");
    writeFileSync(join(fx.repo, "ignored.txt"), "ignored content\n");
    await assertNotACorrection(fx, lineage, correction.revision);
    // CRLF rewrite normalized away by core.autocrlf=true
    git(fx.repo, "config", "core.autocrlf", "true");
    writeFileSync(join(fx.repo, "a.txt"), A_CHANGED.replace(/\n/g, "\r\n"));
    await assertNotACorrection(fx, lineage, correction.revision);
  } finally {
    fx.cleanup();
  }
});

test("S1: same identity under a changed tree is refused by preview and captureCorrectionResult too", async () => {
  const { fx, lineage, correction } = await toCorrection();
  try {
    const changed = editA(fx, A_CHANGED.replace("one\n", "ONE\n"));
    const file = join(fx.commonDir, "odd-plugin", "review-transactions", "v2", lineage, "review-state.json");
    const before = readFileSync(file, "utf8");
    const forged = { candidateTree: changed.candidateTree, identity: readState(fx.commonDir, lineage).target_identity };
    refused(await beginCorrectionValidation(fx.repository, lineage, correction.revision, forged), "correction_unavailable");
    refused(previewCorrectionValidation(fx.repository, lineage, correction.revision, forged), "correction_unavailable");
    refused(await captureCorrectionResult(fx.repository, lineage, correction.revision, forged, { result: {} }), "correction_unavailable");
    assert.equal(readFileSync(file, "utf8"), before);
    unchanged(fx, lineage, correction.revision);
  } finally {
    fx.cleanup();
  }
});
