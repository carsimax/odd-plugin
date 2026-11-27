// Test-only: structural conformance of every envelope the review engine and the MCP server emit, against the vendored upstream
// schemas under <repo>/test-fixtures/review/vendor (byte-exact, never edited). The schemas describe the upstream product, so odd-claude's
// documented differences are applied here as EXPLICIT, NAMED, MINIMAL patches (`SchemaPatch`), each with the reason and the log entry that
// decided it. `contract/contract.spec.ts` proves each patch is still needed (dropping any one makes a real envelope fail), so the list
// cannot grow stale or silently widen.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate, type Schema } from "./schema.testkit.js";
import { INTEGRATION_ROOT, PLUGIN_ROOT } from "./impl.testkit.js";
import { validateReceipt } from "./store.testkit.js";

// The contract strings and catalogue of the envelopes, frozen here (captured from the TS implementation) so no product module is imported.
const REVIEW_CONTRACT = "odd-claude.review-integration/v2";
const CONSENT_SCHEMA = "odd-claude.review-integration.consent/v3";
const START_SCHEMA = "odd-claude.review-integration.start/v4";
const CAPTURE_SCHEMA = "odd-claude.review-integration.capture/v1";
const ACK_SCHEMA = "odd-claude.review-integration.review-acknowledged/v1";
const OUTCOME_SCHEMA = "odd-claude.review-integration.start-outcome/v1";
const REASON_DESCRIPTIONS: Readonly<Record<string, string>> = {
  not_due: "The candidate has no changes, so no review is due",
  escalated: "The review was escalated and needs a human decision",
  target_already_acknowledged: "This candidate was already reviewed and acknowledged",
  correction_budget_exhausted: "The correction attempts are already used",
  role_capacity_exceeded: "The admitted role results are full",
  manual_intervention_required: "Manual intervention is required to proceed",
  invalidated: "The review authority was invalidated; change the candidate and start again",
  consent_declined: "Review was declined for this candidate; a different candidate asks again",
  acknowledgement_token_unavailable: "The approval is pending but its one-shot acknowledgement token was not supplied",
  corrupted_or_unverifiable_authority: "Review authority is corrupted or unverifiable",
  fresh_target_ready: "Target is unreviewed and ready for initial review start",
  native_low_risk_verification: "Low risk candidate eligible for native verification",
  reviewer_results_required: "Reviewer lens artifacts required for current revision",
  refuter_results_available: "Blocking findings can be challenged by an optional refuter before correction",
  review_completion_required: "Every lens result is admitted; the review must be settled",
  correction_required: "A correction of the blocking findings is required",
  validator_result_required: "A validator result is required for the corrected candidate",
  approved_acknowledgement_required: "Approved review awaits its one-shot acknowledgement",
};
const shellQuote = (value: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);
/** The real off switch of this installation: `node <plugin root>/dist/cli/review-mode.js disable`. */
const offPathCommand = (): string => `node ${shellQuote(join(PLUGIN_ROOT, "dist", "cli", "review-mode.js"))} disable`;
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface SchemaPatch {
  name: string;
  /** Why odd-claude differs from the vendored schema (and the Log entry that decided it). */
  why: string;
  apply: (schema: any) => void;
}

const V2 = join(INTEGRATION_ROOT, "v2", "schemas");
const UPSTREAM = ["gentle", "ai"].join("-"); // vendored ids carry the upstream product prefix

// Renames applied while LOADING every schema document (the $ref closure included). They are text-level, so they are listed once:
//  - product prefix of the ids/consts: odd-claude owns its own namespace and hash domains (S3 decision, L5).
//  - reference commands are CLI lines; odd-claude's transitions name MCP tools (L34), the only three commands status emits.
const loadRaw = (id: string): any =>
  JSON.parse(
    readFileSync(id, "utf8")
      .replaceAll(`${UPSTREAM}.review`, "odd-claude.review")
      .replaceAll(`"^${UPSTREAM} review acknowledge-approved"`, '"^review_acknowledge_approved$"')
      .replaceAll(`"^${UPSTREAM} review status(?: |$)"`, '"^review_status$"')
      .replaceAll(`"^${UPSTREAM} review [a-z][a-z-]*"`, '"^(review_start|review_complete|review_acknowledge_approved)$"'),
  );

// L36: transition arguments are the review tools' own snake_case property names; the vendored acknowledge execution names them as CLI flags.
const ARGUMENT_RENAMES: Record<string, string> = { lineage: "lineage_id", target: "target_identity", "expected-revision": "expected_revision" };
const load = (id: string): unknown => {
  const schema = loadRaw(id);
  const ack = schema?.$defs?.approved_acknowledgement_execution?.properties?.arguments?.prefixItems as { properties: { name: { const: string } } }[] | undefined;
  for (const item of ack ?? []) item.properties.name.const = ARGUMENT_RENAMES[item.properties.name.const] ?? item.properties.name.const;
  return schema;
};

// ---- the patches ----

export const CONSENT_PATCHES: SchemaPatch[] = [
  {
    name: "consent.off_path",
    why: "L34/L36: the off path is the real `node <plugin root>/dist/cli/review-mode.js disable` of this installation, not the reference CLI line.",
    apply: (s) => {
      s.properties.off_path.properties.command.const = offPathCommand();
    },
  },
  {
    name: "consent.invocation",
    why: "L34/L36: a choice's invocation is the review_answer_consent tool call with its flag text, not a reference CLI line.",
    apply: (s) => {
      s.$defs.choice.properties.invocation.pattern = "^review_answer_consent --contract odd-claude\\.review-integration/v2 .+ --consent (granted|declined)$";
    },
  },
];

export const START_PATCHES: SchemaPatch[] = [
  {
    name: "start.conditional-blocks",
    why: "L10(c): repository_context, next_transition and the changed-path manifest of start-v4 are not produced by START (status carries the next transition).",
    apply: (s) => {
      delete s.allOf;
    },
  },
  {
    name: "start.acknowledgement",
    why: "L10: the one-shot acknowledgement is odd-claude's own object {lineage_id,target_identity,expected_revision,token}, not the transition-execution shape.",
    apply: (s) => {
      s.properties.acknowledgement = true;
    },
  },
  {
    name: "start.risk-vocabulary",
    why: "U9 (risk.ts header): odd-claude adds reason codes and signals the reference does not have. The enums are EXTENDED with exactly those names (an unknown code still fails).",
    apply: (s) => {
      const def = s.$defs.risk_reason.properties;
      def.code.enum.push(
        "dependency_change", "ci_release_change", "hook_change", "contract_change", "credential_path", "permission_path", "network_access", "filesystem_deletion",
        "file_deletion", "binary_change", "symlink_change", "submodule_change",
      );
      def.signal.enum.push("dependency", "ci_release", "hooks", "contract", "credentials", "network", "data_loss");
    },
  },
  {
    name: "start.target-mode",
    why: "L10: target_identity travels without target_mode, which the reference schema defines only for the overlay kind.",
    apply: (s) => {
      delete s.dependentRequired.target_identity;
      delete s.dependentRequired.target_mode;
    },
  },
];

export const STATUS_PATCHES: SchemaPatch[] = [
  {
    name: "status.authority-coupling",
    why: "L34: the reference couples authority and applicability to its own lineage model; odd-claude reports its compact-v2 lineage directly.",
    apply: (s) => {
      delete s.allOf;
    },
  },
  {
    name: "status.reason-rules",
    why: "L34: reason-specific rules of transitions that exist only in the reference engine (and the input-kind rules that go with them).",
    apply: (s) => {
      delete s.$defs.next_transition.allOf;
      delete s.$defs.transition_input.allOf;
    },
  },
  {
    name: "status.artifact-subject",
    why: "L10(c)/U6: odd-claude's artifact subject has its own shape (artifact.ts, pinned by artifact.spec).",
    apply: (s) => {
      s.$defs.transition_input.properties.artifact_subject = true;
    },
  },
  {
    name: "status.consumed",
    why: "L11/L12: `consumed` (status, reason-carrying) is an odd-claude extension reporting the receipt-verified consumption of the target.",
    apply: (s) => {
      s.properties.consumed = true;
    },
  },
  {
    name: "status.collect-command",
    why: "L36: a collect names the tool that admits it (`command`, `arguments`), because odd-claude transitions are executable by a client as given.",
    apply: (s) => {
      s.$defs.transition_collection.properties.command = true;
      s.$defs.transition_collection.properties.arguments = true;
    },
  },
  {
    name: "status.input-command",
    why: "L36: a transition input names the tool that takes it (`command`).",
    apply: (s) => {
      s.$defs.transition_input.properties.command = true;
    },
  },
];

function violations(file: string, patches: SchemaPatch[], skip: string | undefined, value: unknown): string[] {
  const path = join(V2, file);
  const schema = clone(load(path)) as any;
  for (const p of patches) if (p.name !== skip) p.apply(schema);
  return validate(schema as Schema, value, { base: path, load });
}

export type EnvelopeKind = "consent" | "start" | "status";
const FILES: Record<EnvelopeKind, [string, SchemaPatch[]]> = {
  consent: ["consent-v3.schema.json", CONSENT_PATCHES],
  start: ["start-v4.schema.json", START_PATCHES],
  status: ["status-v5.schema.json", STATUS_PATCHES],
};

/** Violations of the vendored schema for `kind` with every patch applied, except the one named by `skip`. */
export const schemaViolations = (kind: EnvelopeKind, value: unknown, skip?: string): string[] => violations(FILES[kind][0], FILES[kind][1], skip, value);

// ---- own envelope shapes (no vendored schema) ----

const SHA = /^sha256:[0-9a-f]{64}$/;
const keysOf = (o: unknown): string[] => Object.keys(o as object).sort();

function checkForecast(f: any): void {
  assert.equal(typeof f, "object");
  assert.ok(f.horizon === "partial" || f.horizon === "terminal", `forecast horizon ${f.horizon}`);
  assert.ok(Array.isArray(f.steps) && f.steps.length >= 1);
  for (const [i, s] of f.steps.entries()) {
    assert.equal(s.step, i + 1);
    assert.ok(["execute", "collect", "stop"].includes(s.kind), `step kind ${s.kind}`);
    assert.equal(s.description, (REASON_DESCRIPTIONS as Record<string, string>)[s.reason_code], `step ${s.reason_code} carries its catalogued description`);
  }
}

export function checkAcknowledgement(a: any): void {
  assert.deepEqual(keysOf(a), ["expected_revision", "lineage_id", "target_identity", "token"]);
  assert.match(a.lineage_id, /^review-[0-9a-f]{16}$/);
  assert.match(a.target_identity, SHA);
  assert.match(a.expected_revision, SHA);
  assert.match(a.token, /^[0-9a-f]{64}$/);
}

export function checkAckEnvelope(e: any): void {
  assert.equal(e.schema, ACK_SCHEMA);
  assert.equal(e.contract, REVIEW_CONTRACT);
  assert.equal(e.operation, "review.acknowledge-approved");
  assert.equal(e.outcome, "acknowledged");
  assert.equal(e.state, "approved");
  assert.equal(e.burned, true);
  const v = validateReceipt(e.receipt);
  assert.deepEqual(v.ok ? [] : v.errors, [], "the receipt validates and its receipt_hash re-derives");
  assert.equal(e.receipt.lineage_id, e.lineage_id);
  assert.equal(e.receipt.target_identity, e.target_identity);
}

function checkCapture(e: any): void {
  assert.equal(e.schema, CAPTURE_SCHEMA);
  assert.equal(e.contract, REVIEW_CONTRACT);
  assert.equal(e.operation, "review.capture-result");
  assert.equal(e.outcome, "captured");
  assert.match(e.lineage_id, /^review-[0-9a-f]{16}$/);
  assert.match(e.target_identity, SHA);
  assert.match(e.revision, SHA);
  assert.ok(Array.isArray(e.pending_lenses));
  if (e.state === "approved") checkAcknowledgement(e.acknowledgement);
  else assert.equal("acknowledgement" in e, false, "only an approved capture carries the one-shot token");
}

function checkStatus(e: any): void {
  assert.deepEqual(schemaViolations("status", e), []);
  // the schema's reason-specific rules are patched out (status.reason-rules): the vocabulary is the engine's own catalogue
  assert.ok(e.next_transition.reason_code in REASON_DESCRIPTIONS, `status reason ${e.next_transition.reason_code} is catalogued`);
  assert.equal(e.forecast.steps[0].kind, e.next_transition.kind);
  assert.equal(e.forecast.steps[0].reason_code, e.next_transition.reason_code);
  assert.equal(e.forecast.horizon, e.next_transition.kind === "stop" ? "terminal" : "partial");
  checkForecast(e.forecast);
}

function checkStartOutcome(e: any): void {
  assert.equal(e.schema, OUTCOME_SCHEMA);
  assert.equal(e.contract, REVIEW_CONTRACT);
  assert.equal(e.operation, "review.start");
  assert.ok(["declined", "not_due"].includes(e.outcome) || e.outcome === "refused", `start outcome ${e.outcome}`);
  assert.ok(e.reason_code in REASON_DESCRIPTIONS || e.outcome === "refused", `reason ${e.reason_code}`);
}

/** The schema-id based dispatch of any envelope that carries a `schema` member. Returns the kind it was checked as. */
export function conformEnvelope(e: any): string {
  switch (e?.schema) {
    case CONSENT_SCHEMA:
      assert.deepEqual(schemaViolations("consent", e), []);
      return "consent";
    case START_SCHEMA:
      assert.deepEqual(schemaViolations("start", e), []);
      if (e.acknowledgement !== undefined) checkAcknowledgement(e.acknowledgement);
      assert.equal(e.action === "closed", e.risk_level === "low", "only a low-risk start closes at once");
      return "start";
    case OUTCOME_SCHEMA:
      checkStartOutcome(e);
      return "start-outcome";
    case "odd-claude.review-integration.status/v5":
      checkStatus(e);
      return "status";
    case CAPTURE_SCHEMA:
      checkCapture(e);
      return "capture";
    case ACK_SCHEMA:
      checkAckEnvelope(e);
      return "ack";
    default:
      assert.fail(`envelope with an unknown schema: ${JSON.stringify(e?.schema)}`);
  }
}

/**
 * Checks ONE tool result body. Returns a label of what it was checked as (for coverage assertions in the specs).
 * Typed tool errors must carry {error:{code,message}} with a snake_case code; run outcomes are checked by their member envelopes.
 */
export function conformToolBody(tool: string, isError: boolean, body: any): string {
  if (isError) {
    assert.deepEqual(Object.keys(body), ["error"], `${tool}: an error result is exactly {error}`);
    assert.match(body.error.code, /^[a-z][a-z0-9_]*$/, `${tool}: error code`);
    assert.equal(typeof body.error.message, "string");
    return "error";
  }
  if (tool === "review_inspect") {
    assert.ok(["on", "off"].includes(body.rdd_mode.effective));
    assert.ok(Array.isArray(body.lineages) && Array.isArray(body.unreadable));
    for (const l of body.lineages) assert.match(l.target_identity, SHA);
    return "inspect";
  }
  if (tool === "review_assess") {
    assert.ok(["assessed", "not_due"].includes(body.outcome));
    return "assess";
  }
  if (typeof body.schema === "string") return conformEnvelope(body);
  assert.equal(typeof body.outcome, "string", `${tool}: a run result names its outcome`);
  switch (body.outcome) {
    case "forecast":
      checkForecast(body.forecast);
      assert.match(body.reviewer_run_binding, SHA);
      assert.ok(body.reviewers.length >= 1);
      return "run:forecast";
    case "consent-required":
      conformEnvelope(body.envelope);
      return "run:consent-required";
    case "closed":
      checkAckEnvelope(body.acknowledgement);
      return "run:closed";
    case "captured":
      conformEnvelope(body.capture);
      return "run:captured";
    case "input-required":
      assert.equal(body.correction.ok, true);
      assert.ok(Array.isArray(body.correction.allowed_paths));
      return "run:input-required";
    case "stopped":
      assert.ok(body.reason_code in REASON_DESCRIPTIONS, `stop reason ${body.reason_code}`);
      return "run:stopped";
    case "not-due":
      return "run:not-due";
    default:
      assert.fail(`${tool}: unexpected run outcome ${body.outcome}`);
  }
}
