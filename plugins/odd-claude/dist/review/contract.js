// Contract surface of the review engine (U10): stop reason codes, opaque transition bindings and the
// envelope encoders for the start / consent / capture / acknowledge results.
//
// Shapes follow the vendored review-integration v2 schemas under odd-claude ids (the reference uses
// its own product prefix); `status.ts` builds the status envelope on top of this module. The tool names and the off switch
// the envelopes mention live in consent.ts (`REVIEW_TOOL_NAMES`, `reviewCommand`, `offPathCommand`).
import { canonicalJson, domainHash } from "./canonical.js";
import { lensArtifactSubject } from "./artifact.js";
import { AckRefusedError } from "./ack.js";
import { buildConsentEnvelope, CONSENT_SCHEMA, REVIEW_CONTRACT } from "./consent.js";
export { REVIEW_CONTRACT, CONSENT_SCHEMA };
export const STATUS_SCHEMA = "odd-claude.review-integration.status/v5";
export const PROJECTION_SCHEMA = "odd-claude.review-integration.projection/v1";
export const REPAIR_SCHEMA = "odd-claude.review-authority-repair-assessment/v1";
export const CAPTURE_SCHEMA = "odd-claude.review-integration.capture/v1";
export const CAPTURE_DRY_RUN_SCHEMA = "odd-claude.review-capture-result-dry-run/v1";
export const ACK_SCHEMA = "odd-claude.review-integration.review-acknowledged/v1";
export const OUTCOME_SCHEMA = "odd-claude.review-integration.start-outcome/v1";
export const FAILURE_SCHEMA = "odd-claude.review-integration.failure/v2";
// ---- transition kinds and reason codes ----
export const TRANSITION_KINDS = ["execute", "collect", "stop"];
/** Stops nothing can recover from for this candidate: the answer will not change by retrying. */
export const TERMINAL_STOP_CODES = [
    "not_due",
    "escalated",
    "target_already_acknowledged",
    "correction_budget_exhausted",
    "role_capacity_exceeded",
    "manual_intervention_required",
];
/** Stops the operator or the next candidate can lift (a new change, a token, a decision, a repair). */
export const RECOVERABLE_STOP_CODES = [
    "invalidated",
    "consent_declined",
    "acknowledgement_token_unavailable",
    "corrupted_or_unverifiable_authority",
];
/** Reason codes of the non-stop heads (execute / collect). */
export const ACTIVE_REASON_CODES = [
    "fresh_target_ready",
    "native_low_risk_verification",
    "reviewer_results_required",
    "refuter_results_available",
    "review_completion_required",
    "correction_required",
    "validator_result_required",
    "approved_acknowledgement_required",
];
export const REASON_DESCRIPTIONS = {
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
export const isTerminalStop = (code) => TERMINAL_STOP_CODES.includes(code);
export const isRecoverableStop = (code) => RECOVERABLE_STOP_CODES.includes(code);
/** One-step forecast of a head transition; a stop is the terminal horizon. */
export function forecastFor(kind, reasonCode) {
    return {
        horizon: kind === "stop" ? "terminal" : "partial",
        steps: [{ step: 1, kind, reason_code: reasonCode, description: REASON_DESCRIPTIONS[reasonCode] }],
    };
}
// ---- opaque transition binding ----
export const BINDING_ROLES = ["start", "lens", "refuter", "complete", "correction", "validator", "acknowledge"];
const SHA_RE = /^sha256:[0-9a-f]{64}$/;
const BINDING_PREFIX = "odd1";
const BINDING_KEYS = new Set(["target_identity", "lineage_id", "revision", "role", "lens", "subject_hash"]);
const tagOf = (payload) => domainHash("transition-binding", 1, payload).slice("sha256:".length);
/** `odd1.<base64url(canonical JSON)>.<hex domain-hash tag>`: opaque to callers, verified before use. */
export function encodeBinding(binding) {
    const json = canonicalJson(binding);
    const payload = Buffer.from(json, "utf8").toString("base64url");
    return `${BINDING_PREFIX}.${payload}.${tagOf(payload)}`;
}
const bad = (message) => ({ ok: false, code: "invalid_binding", message });
export function decodeBinding(value) {
    if (typeof value !== "string")
        return bad("the binding must be a string");
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== BINDING_PREFIX)
        return bad("the binding is not an odd-claude transition binding");
    const [, payload, tag] = parts;
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || tag !== tagOf(payload))
        return bad("the binding signature does not verify");
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    }
    catch {
        return bad("the binding payload is not JSON");
    }
    const o = parsed;
    if (typeof o !== "object" || o === null || Array.isArray(o))
        return bad("the binding payload is not an object");
    for (const k of Object.keys(o))
        if (!BINDING_KEYS.has(k))
            return bad(`unknown binding field ${JSON.stringify(k)}`);
    if (typeof o.target_identity !== "string" || !SHA_RE.test(o.target_identity))
        return bad("the binding target is malformed");
    if (typeof o.role !== "string" || !BINDING_ROLES.includes(o.role))
        return bad("the binding role is unknown");
    if (o.revision !== undefined && (typeof o.revision !== "string" || !SHA_RE.test(o.revision)))
        return bad("the binding revision is malformed");
    if (o.subject_hash !== undefined && (typeof o.subject_hash !== "string" || !SHA_RE.test(o.subject_hash)))
        return bad("the binding subject is malformed");
    for (const k of ["lineage_id", "lens"])
        if (o[k] !== undefined && (typeof o[k] !== "string" || o[k] === ""))
            return bad(`the binding ${k} is malformed`);
    if (o.role !== "start" && (o.lineage_id === undefined || o.revision === undefined))
        return bad("a lineage binding needs lineage_id and revision");
    return { ok: true, binding: o };
}
const STATE_FOR_ROLE = {
    lens: ["reviewing"],
    refuter: ["reviewing"],
    complete: ["reviewing"],
    correction: ["correction_required"],
    validator: ["validating"],
    acknowledge: ["approved"],
};
const drift = (field, message) => ({ ok: false, code: "binding_drift", field, message });
/** Decodes the binding and refuses it when the candidate, the lineage revision, the state or the artifact subject moved. */
export function verifyBinding(value, current) {
    const decoded = decodeBinding(value);
    if (!decoded.ok)
        return decoded;
    const b = decoded.binding;
    if (b.target_identity !== current.targetIdentity)
        return drift("target", "the candidate changed since the binding was issued");
    if (b.role === "start") {
        return current.lineage ? drift("lineage", "a lineage now exists for this candidate") : decoded;
    }
    const rec = current.lineage;
    if (!rec || rec.lineage_id !== b.lineage_id)
        return drift("lineage", "the lineage of the binding is not the current one");
    if (rec.revision !== b.revision)
        return drift("revision", "the lineage revision changed since the binding was issued");
    if (!STATE_FOR_ROLE[b.role].includes(rec.state) || (b.role === "acknowledge" && rec.burned)) {
        return drift("state", `the lineage is ${rec.state}, which no longer matches the ${b.role} binding`);
    }
    if (b.subject_hash !== undefined) {
        if (b.lens === undefined || current.commonDir === undefined)
            return drift("subject", "the artifact subject cannot be re-derived without its lens and repository");
        let subject = null;
        try {
            subject = lensArtifactSubject(current.commonDir, rec, b.lens);
        }
        catch {
            subject = null;
        }
        if (subject === null || subject.subject_hash !== b.subject_hash)
            return drift("subject", "the artifact subject changed since the binding was issued");
    }
    return decoded;
}
/** Consent v3 envelope. The invocations are built from the one command constant of consent.ts. */
export function encodeConsentEnvelope(input) {
    return buildConsentEnvelope(input);
}
const prefixed = (lens) => (lens.startsWith("review-") ? lens : `review-${lens}`);
/** Start outcome → envelope. A started review is the start/v4 result; the others carry the outcome schema. */
export function encodeStartEnvelope(outcome) {
    switch (outcome.status) {
        case "started":
            return { ...outcome.result };
        case "consent_required":
            return { ...outcome.envelope };
        case "not_due":
            return { schema: OUTCOME_SCHEMA, contract: REVIEW_CONTRACT, operation: "review.start", outcome: "not_due", reason_code: "not_due", reason: outcome.reason, kind: outcome.kind, projection: outcome.projection };
        case "declined":
            return {
                schema: OUTCOME_SCHEMA, contract: REVIEW_CONTRACT, operation: "review.start", outcome: "declined", reason_code: "consent_declined",
                target_identity: outcome.target_identity, projection: outcome.projection, risk_level: outcome.risk_level,
            };
        case "refused":
            return {
                schema: FAILURE_SCHEMA, contract: REVIEW_CONTRACT, operation: "review.start", outcome: "refused", code: outcome.code, message: outcome.message,
                ...(outcome.lineage_id !== undefined ? { lineage_id: outcome.lineage_id } : {}),
            };
    }
}
/** Capture outcome → envelope (success carries the state, the next step and the one-shot acknowledgement, if issued). */
export function encodeCaptureEnvelope(outcome) {
    if (!outcome.ok) {
        return {
            schema: FAILURE_SCHEMA, contract: REVIEW_CONTRACT, operation: "review.capture-result", outcome: "refused", code: outcome.code, message: outcome.message,
            ...(outcome.errors !== undefined ? { errors: [...outcome.errors] } : {}),
            ...(outcome.currentRevision !== undefined ? { current_revision: outcome.currentRevision } : {}),
        };
    }
    const r = outcome.record;
    return {
        schema: CAPTURE_SCHEMA,
        contract: REVIEW_CONTRACT,
        operation: "review.capture-result",
        outcome: "captured",
        lineage_id: r.lineage_id,
        target_identity: r.target_identity,
        state: outcome.state,
        next: outcome.next,
        revision: outcome.revision,
        pending_lenses: outcome.pending_lenses.map(prefixed),
        ...(outcome.pending_refutation !== undefined ? { pending_refutation: [...outcome.pending_refutation] } : {}),
        ...(outcome.ackToken !== undefined
            ? { acknowledgement: { lineage_id: r.lineage_id, target_identity: r.target_identity, expected_revision: outcome.revision, token: outcome.ackToken } }
            : {}),
    };
}
/** The capture-result dry-run acceptance (admission validated, nothing persisted). */
export function encodeCaptureDryRun(input) {
    return {
        schema: CAPTURE_DRY_RUN_SCHEMA,
        operation: "review/capture-result",
        validation: "accepted",
        lineage_id: input.lineage_id,
        lens: prefixed(input.lens),
        selected_order: input.selected_order,
        subject_hash: input.subject_hash,
        admission_decision: "completed",
    };
}
/** Acknowledge result (or typed refusal) → envelope. The refusal code is the AckRefusalCode. */
export function encodeAckEnvelope(result) {
    if (result instanceof AckRefusedError) {
        return { schema: FAILURE_SCHEMA, contract: REVIEW_CONTRACT, operation: "review.acknowledge-approved", outcome: "refused", code: result.code, message: result.message };
    }
    const receipt = result.receipt;
    return {
        schema: ACK_SCHEMA,
        contract: REVIEW_CONTRACT,
        operation: "review.acknowledge-approved",
        outcome: "acknowledged",
        lineage_id: result.record.lineage_id,
        target_identity: result.record.target_identity,
        state: result.record.state,
        burned: result.record.burned,
        receipt: { ...receipt, selected_lenses: [...receipt.selected_lenses] },
    };
}
