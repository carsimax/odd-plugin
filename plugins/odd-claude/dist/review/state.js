// Compact review state v2 (U4): pure, I/O-free model, validator and transitions.
//
// Mirrors the compact state of the reference engine (state enum, 0/1/4 lens policy, floor_two
// correction budget, up to two correction attempts, at most six admitted role results, one-shot
// acknowledgement token) under odd-claude names and hash domains. Nothing here reads a clock, a
// file or the network: callers pass `now`, and the only entropy is the token generator, which is
// injectable. Transitions never mutate their input; they return a new sealed record or a typed
// refusal. The raw acknowledgement token is returned once and only its domain hash is persisted.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { domainHash } from "./canonical.js";
export const STATE_SCHEMA = "odd-claude.review-state/v2";
export const MAX_CORRECTION_ATTEMPTS = 2;
export const MAX_ADMITTED_ROLE_RESULTS = 6;
export const MAX_CORRECTION_CHANGED_LINES = 200;
export const LENSES = ["risk", "resilience", "readability", "reliability"];
export const STATES = ["reviewing", "correction_required", "validating", "approved", "escalated", "invalidated"];
export const SEVERITIES = ["BLOCKER", "CRITICAL", "MAJOR", "MINOR", "INFO", "WARNING", "SUGGESTION"];
export const EVIDENCE_CLASSES = ["deterministic", "inferential", "insufficient"];
export const CAUSAL_DISPOSITIONS = ["introduced", "behavior-activated", "worsened", "pre-existing", "base-only", "unknown"];
const FINDING_PREFIX = { risk: "R1-", readability: "R2-", reliability: "R3-", resilience: "R4-" };
export function findingIdPrefixForLens(lens) {
    return FINDING_PREFIX[lens] ?? "";
}
/**
 * How a finding weighs on approval. Severe findings with insufficient evidence or unknown causality are inconclusive
 * (escalate); pre-existing / base-only ones are follow-ups; the rest block unless a refuter refuted them.
 */
export function findingDisposition(f, refuted = []) {
    if (f.severity !== "BLOCKER" && f.severity !== "CRITICAL")
        return "clear";
    if (f.evidence_class === "insufficient" || f.causal_disposition === "unknown")
        return "inconclusive";
    if (f.causal_disposition === "pre-existing" || f.causal_disposition === "base-only")
        return "follow_up";
    return refuted.includes(f.id) ? "refuted" : "blocking";
}
export function blockingFindingIds(record) {
    return record.findings.filter((f) => findingDisposition(f, record.refuted_finding_ids ?? []) === "blocking").map((f) => f.id).sort();
}
export function inconclusiveFindingIds(record) {
    return record.findings.filter((f) => findingDisposition(f) === "inconclusive").map((f) => f.id).sort();
}
function refuse(code, message) {
    return { ok: false, refusal: { code, message } };
}
// ---- formats ----
const LINEAGE_RE = /^review-[0-9a-f]{16}$/;
const SHA_RE = /^sha256:[0-9a-f]{64}$/;
const TREE_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const FINDING_ID_RE = /^R[1-4]-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const isTime = (v) => typeof v === "string" && TIME_RE.test(v) && Number.isFinite(Date.parse(v));
const isLens = (v) => typeof v === "string" && LENSES.includes(v);
const isSevere = (s) => s === "BLOCKER" || s === "CRITICAL";
const nonNegInt = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** floor_two correction budget: ceil(n/2) capped at 200, never below 2 for a positive candidate. */
export function correctionBudget(originalChangedLines) {
    if (!nonNegInt(originalChangedLines))
        throw new RangeError("original changed lines must be a non-negative integer");
    const legacy = Math.min(MAX_CORRECTION_CHANGED_LINES, Math.floor(originalChangedLines / 2) + (originalChangedLines % 2));
    return originalChangedLines > 0 && legacy < 2 ? 2 : legacy;
}
/** Lens policy: low 0, medium exactly 1, high 1..4 (an explicit pertinent subset, or all four). */
function lensCountRange(risk) {
    return risk === "low" ? [0, 0] : risk === "medium" ? [1, 1] : [1, LENSES.length];
}
function lensSetProblem(risk, lenses) {
    if (risk !== "low" && risk !== "medium" && risk !== "high")
        return "risk_level must be low, medium or high";
    if (!Array.isArray(lenses) || !lenses.every(isLens))
        return "selected_lenses must be a list of known lenses";
    const [min, max] = lensCountRange(risk);
    if (lenses.length < min || lenses.length > max) {
        return `selected_lenses must hold ${min === max ? `exactly ${min}` : `${min} to ${max}`} lenses for ${risk} risk`;
    }
    const order = lenses.map((l) => LENSES.indexOf(l));
    for (let i = 1; i < order.length; i++)
        if (order[i] <= order[i - 1])
            return "selected_lenses must be unique and in canonical order";
    return undefined;
}
// ---- hashes ----
const ledgerHashOf = (findings) => domainHash("review-ledger", 1, [...findings].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
function evidenceHashOf(r) {
    const lensResults = LENSES.flatMap((lens) => r.admitted_role_results.filter((e) => e.role === "lens" && e.lens === lens).map((e) => ({ lens, result_hash: e.result_hash })));
    const validator = r.admitted_role_results.find((e) => e.role === "validator");
    const refuter = r.admitted_role_results.find((e) => e.role === "refuter");
    return domainHash("review-evidence", 1, {
        lens_results: lensResults,
        ledger_hash: r.ledger_hash ?? null,
        correction_attempts: r.correction_attempts,
        validator_result_hash: validator ? validator.result_hash : null,
        ...(refuter ? { refuter_result_hash: refuter.result_hash, refuted_finding_ids: r.refuted_finding_ids ?? [] } : {}),
    });
}
const tokenHashOf = (token) => domainHash("approved-ack-token", 1, token);
/** domainHash("review-state", 2, record without its revision). Key order never matters. */
export function stateRevision(record) {
    const { revision: _ignored, ...rest } = record;
    void _ignored;
    return domainHash("review-state", 2, rest);
}
function seal(record) {
    const sealed = { ...record, revision: "" };
    sealed.revision = stateRevision(sealed);
    return sealed;
}
const REQUIRED = [
    "schema", "revision", "lineage_id", "state", "target_identity", "projection", "base_tree", "candidate_tree", "risk_level",
    "selected_lenses", "original_changed_lines", "correction_budget", "correction_budget_policy", "correction_attempts",
    "admitted_role_results", "findings", "fix_finding_ids", "burned", "created_at", "updated_at",
];
const OPTIONAL = [
    "actual_correction_lines", "ledger_hash", "evidence_hash", "approved_ack_token_hash", "burn_receipt", "approved_revision", "escalation_reason", "invalidation_reason",
    "refuted_finding_ids", "correction_target_identity", "correction_candidate_tree", "original_target_identity", "original_candidate_tree",
];
function checkKeys(obj, required, optional, where, errors) {
    for (const k of Object.keys(obj))
        if (!required.includes(k) && !optional.includes(k))
            errors.push(`${where}: unknown field ${k}`);
    for (const k of required)
        if (!(k in obj))
            errors.push(`${where}: missing field ${k}`);
}
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
export function validateStateRecord(input) {
    const errors = [];
    if (!isObj(input))
        return { ok: false, errors: ["record must be an object"] };
    checkKeys(input, REQUIRED, OPTIONAL, "record", errors);
    const o = input;
    const has = (k) => o[k] !== undefined;
    if (o.schema !== STATE_SCHEMA)
        errors.push(`schema must be ${STATE_SCHEMA}`);
    if (typeof o.lineage_id !== "string" || !LINEAGE_RE.test(o.lineage_id))
        errors.push("lineage_id must match review-<16 hex>");
    if (typeof o.state !== "string" || !STATES.includes(o.state))
        errors.push(`state must be one of ${STATES.join(", ")}`);
    if (typeof o.target_identity !== "string" || !SHA_RE.test(o.target_identity))
        errors.push("target_identity must be sha256:<64 hex>");
    if (o.projection !== "workspace" && o.projection !== "staged")
        errors.push("projection must be workspace or staged");
    if (typeof o.base_tree !== "string" || !TREE_RE.test(o.base_tree))
        errors.push("base_tree must be a 40 or 64 hex tree id");
    if (typeof o.candidate_tree !== "string" || !TREE_RE.test(o.candidate_tree))
        errors.push("candidate_tree must be a 40 or 64 hex tree id");
    const lensProblem = lensSetProblem(o.risk_level, o.selected_lenses);
    if (lensProblem)
        errors.push(lensProblem);
    if (!nonNegInt(o.original_changed_lines))
        errors.push("original_changed_lines must be a non-negative integer");
    if (o.correction_budget_policy !== "floor_two")
        errors.push("correction_budget_policy must be floor_two");
    if (nonNegInt(o.original_changed_lines) && o.correction_budget !== correctionBudget(o.original_changed_lines)) {
        errors.push("correction_budget does not match original_changed_lines");
    }
    if (!nonNegInt(o.correction_attempts) || o.correction_attempts > MAX_CORRECTION_ATTEMPTS) {
        errors.push(`correction_attempts must be an integer from 0 to ${MAX_CORRECTION_ATTEMPTS}`);
    }
    if (typeof o.burned !== "boolean")
        errors.push("burned must be a boolean");
    if (!isTime(o.created_at))
        errors.push("created_at must be a UTC RFC 3339 timestamp");
    if (!isTime(o.updated_at))
        errors.push("updated_at must be a UTC RFC 3339 timestamp");
    else if (isTime(o.created_at) && Date.parse(o.updated_at) < Date.parse(o.created_at))
        errors.push("updated_at must not precede created_at");
    for (const k of ["ledger_hash", "evidence_hash", "burn_receipt"]) {
        if (has(k) && (typeof o[k] !== "string" || !SHA_RE.test(o[k])))
            errors.push(`${k} must be sha256:<64 hex>`);
    }
    if (has("approved_ack_token_hash") && (typeof o.approved_ack_token_hash !== "string" || !SHA_RE.test(o.approved_ack_token_hash))) {
        errors.push("approved_ack_token_hash must be sha256:<64 hex>");
    }
    for (const k of ["escalation_reason", "invalidation_reason"]) {
        if (has(k) && (typeof o[k] !== "string" || o[k].trim() === ""))
            errors.push(`${k} must be a non-empty string`);
    }
    if (has("actual_correction_lines") && !nonNegInt(o.actual_correction_lines))
        errors.push("actual_correction_lines must be a non-negative integer");
    if (has("correction_target_identity")) {
        if (typeof o.correction_target_identity !== "string" || !SHA_RE.test(o.correction_target_identity))
            errors.push("correction_target_identity must be sha256:<64 hex>");
        if (typeof o.correction_attempts !== "number" || o.correction_attempts < 1)
            errors.push("correction_target_identity requires correction_attempts to be at least 1");
    }
    if (has("correction_candidate_tree")) {
        if (typeof o.correction_candidate_tree !== "string" || !TREE_RE.test(o.correction_candidate_tree))
            errors.push("correction_candidate_tree must be a 40 or 64 hex tree id");
        if (!has("correction_target_identity"))
            errors.push("correction_candidate_tree requires correction_target_identity");
    }
    // Defense in depth (reference CompleteCorrection): while validating, the corrected candidate must differ from the reviewed one.
    if (o.state === "validating" && ((has("correction_target_identity") && o.correction_target_identity === o.target_identity)
        || (has("correction_candidate_tree") && o.correction_candidate_tree === o.candidate_tree))) {
        errors.push("a validating record needs a corrected candidate that differs from the reviewed one (unchanged correction: same identity or tree)");
    }
    if (has("original_target_identity") !== has("original_candidate_tree"))
        errors.push("original_target_identity and original_candidate_tree go together");
    // Fail closed: a settled lineage after a correction must bind the corrected candidate, so a missing swap is rejected in the store too.
    if ((o.state === "approved" || o.state === "escalated") && has("correction_candidate_tree") && !has("original_target_identity")) {
        errors.push("a settled record with correction_candidate_tree requires original_target_identity and original_candidate_tree (its candidate must be the corrected one)");
    }
    if (o.state === "approved" && has("correction_target_identity") && !has("original_target_identity")) {
        errors.push("approved after a correction must bind the corrected candidate (original_target_identity and original_candidate_tree are required)");
    }
    if (has("original_target_identity") || has("original_candidate_tree")) {
        if (typeof o.original_target_identity !== "string" || !SHA_RE.test(o.original_target_identity))
            errors.push("original_target_identity must be sha256:<64 hex>");
        if (typeof o.original_candidate_tree !== "string" || !TREE_RE.test(o.original_candidate_tree))
            errors.push("original_candidate_tree must be a 40 or 64 hex tree id");
        // The original is kept by a settled correction, and across a reopened one: a reopened correction_required (corrected
        // fields cleared) and the validating of its later attempt (the corrected fields hold the NEW candidate under validation).
        const reopened = o.state === "correction_required";
        const laterValidation = o.state === "validating";
        if (o.state !== "approved" && o.state !== "escalated" && !reopened && !laterValidation) {
            errors.push("the original candidate is only kept by an approval, an escalation or a reopened correction (original requires the approved, escalated, correction_required or validating state)");
        }
        if (reopened) {
            if (o.correction_attempts === 0 || has("correction_target_identity") || has("correction_candidate_tree"))
                errors.push("an original candidate on a correction_required record needs spent attempts and no pending corrected candidate");
        }
        else if (laterValidation) {
            if (typeof o.correction_attempts !== "number" || o.correction_attempts < 2)
                errors.push("an original candidate on a validating record needs a reopened correction (correction_attempts of at least 2)");
        }
        else if (!has("correction_target_identity") || !has("correction_candidate_tree"))
            errors.push("original candidate requires the corrected candidate (correction_target_identity and correction_candidate_tree)");
        else if (o.target_identity !== o.correction_target_identity || o.candidate_tree !== o.correction_candidate_tree) {
            errors.push("target_identity and candidate_tree must be the corrected candidate when the original is kept");
        }
    }
    const selected = Array.isArray(o.selected_lenses) ? o.selected_lenses.filter((l) => typeof l === "string") : [];
    // admitted role results
    const admitted = [];
    if (!Array.isArray(o.admitted_role_results))
        errors.push("admitted_role_results must be a list");
    else {
        if (o.admitted_role_results.length > MAX_ADMITTED_ROLE_RESULTS)
            errors.push(`admitted_role_results holds more than ${MAX_ADMITTED_ROLE_RESULTS} entries`);
        const seen = new Set();
        o.admitted_role_results.forEach((entry, i) => {
            const where = `admitted_role_results[${i}]`;
            if (!isObj(entry))
                return void errors.push(`${where} must be an object`);
            checkKeys(entry, ["role", "result_hash"], ["lens", "artifact_digest"], where, errors);
            const role = entry.role;
            if (role !== "lens" && role !== "refuter" && role !== "validator")
                return void errors.push(`${where}.role must be lens, refuter or validator`);
            if (typeof entry.result_hash !== "string" || !SHA_RE.test(entry.result_hash))
                errors.push(`${where}.result_hash must be sha256:<64 hex>`);
            if (entry.artifact_digest !== undefined && (typeof entry.artifact_digest !== "string" || !SHA_RE.test(entry.artifact_digest))) {
                errors.push(`${where}.artifact_digest must be sha256:<64 hex>`);
            }
            if (role === "validator" || role === "refuter") {
                if (entry.lens !== undefined)
                    errors.push(`${where}: a ${role} carries no lens`);
            }
            else if (typeof entry.lens !== "string" || !selected.includes(entry.lens))
                errors.push(`${where}.lens must be a selected lens`);
            const key = role === "lens" ? `lens:${String(entry.lens)}` : role;
            if (seen.has(key))
                errors.push(`${where} repeats an admitted ${role} result`);
            seen.add(key);
            admitted.push(entry);
        });
    }
    // findings
    const findings = [];
    if (!Array.isArray(o.findings))
        errors.push("findings must be a list");
    else {
        const ids = new Set();
        o.findings.forEach((f, i) => {
            const where = `findings[${i}]`;
            if (!isObj(f))
                return void errors.push(`${where} must be an object`);
            checkKeys(f, ["id", "lens", "severity", "location", "claim"], ["evidence_class", "causal_disposition"], where, errors);
            const okShape = typeof f.id === "string" && FINDING_ID_RE.test(f.id) && typeof f.lens === "string" && selected.includes(f.lens) &&
                typeof f.severity === "string" && SEVERITIES.includes(f.severity) &&
                typeof f.location === "string" && typeof f.claim === "string" &&
                (f.evidence_class === undefined || EVIDENCE_CLASSES.includes(f.evidence_class)) &&
                (f.causal_disposition === undefined || CAUSAL_DISPOSITIONS.includes(f.causal_disposition));
            if (!okShape)
                return void errors.push(`${where} is malformed (id, selected lens, severity, location, claim)`);
            if (!f.id.startsWith(findingIdPrefixForLens(f.lens)))
                errors.push(`${where}.id must carry the ${findingIdPrefixForLens(f.lens)} prefix of its lens`);
            if (ids.has(f.id))
                errors.push(`${where}.id repeats`);
            ids.add(f.id);
            findings.push(f);
        });
    }
    // fix finding ids
    let fixIds = [];
    if (!Array.isArray(o.fix_finding_ids) || !o.fix_finding_ids.every((x) => typeof x === "string"))
        errors.push("fix_finding_ids must be a list of strings");
    else {
        fixIds = o.fix_finding_ids;
        const sorted = [...new Set(fixIds)].sort();
        if (sorted.length !== fixIds.length || sorted.some((v, i) => v !== fixIds[i]))
            errors.push("fix_finding_ids must be unique and sorted");
        for (const id of fixIds) {
            const f = findings.find((x) => x.id === id);
            if (!f || !isSevere(f.severity))
                errors.push(`fix_finding_ids names ${id}, which is not a severe finding`);
            else if (Array.isArray(o.refuted_finding_ids) && o.refuted_finding_ids.includes(id))
                errors.push(`fix_finding_ids names ${id}, which was refuted`);
        }
    }
    // refuted finding ids (present exactly when a refuter result is admitted)
    const hasRefuter = admitted.some((e) => e.role === "refuter");
    if (has("refuted_finding_ids")) {
        const refuted = o.refuted_finding_ids;
        if (!Array.isArray(refuted) || !refuted.every((x) => typeof x === "string"))
            errors.push("refuted_finding_ids must be a list of strings");
        else {
            const sorted = [...new Set(refuted)].sort();
            if (sorted.length !== refuted.length || sorted.some((v, i) => v !== refuted[i]))
                errors.push("refuted_finding_ids must be unique and sorted");
            for (const id of refuted) {
                const f = findings.find((x) => x.id === id);
                if (!f || findingDisposition(f) !== "blocking")
                    errors.push(`refuted_finding_ids names ${id}, which is not a refutable severe finding`);
            }
        }
        if (!hasRefuter)
            errors.push("refuted_finding_ids requires an admitted refuter result");
    }
    else if (hasRefuter)
        errors.push("an admitted refuter result requires refuted_finding_ids");
    // burn / token
    if (has("approved_revision")) {
        if (typeof o.approved_revision !== "string" || !SHA_RE.test(o.approved_revision))
            errors.push("approved_revision must be sha256:<64 hex>");
        if (o.burned !== true)
            errors.push("approved_revision requires burned");
    }
    if (o.burned === true && !has("burn_receipt"))
        errors.push("burned requires burn_receipt");
    if (o.burned === false && has("burn_receipt"))
        errors.push("burn_receipt requires burned");
    if (o.burned === true && o.state !== "approved")
        errors.push("burned requires the approved state");
    if (o.state === "approved" && !has("approved_ack_token_hash"))
        errors.push("approved requires approved_ack_token_hash");
    if (o.state !== "approved" && has("approved_ack_token_hash"))
        errors.push("approved_ack_token_hash requires the approved state");
    if (o.state !== "escalated" && has("escalation_reason"))
        errors.push("escalation_reason requires the escalated state");
    if (o.state === "escalated" && !has("escalation_reason"))
        errors.push("escalated requires escalation_reason");
    if (o.state !== "invalidated" && has("invalidation_reason"))
        errors.push("invalidation_reason requires the invalidated state");
    if (o.state === "invalidated" && !has("invalidation_reason"))
        errors.push("invalidated requires invalidation_reason");
    // per-state invariants
    const lensAdmitted = selected.every((l) => admitted.some((e) => e.role === "lens" && e.lens === l));
    const hasValidator = admitted.some((e) => e.role === "validator");
    const attempts = o.correction_attempts; // shape errors above already reject a non-integer
    const needsComplete = o.state === "correction_required" || o.state === "validating" || o.state === "approved";
    if (needsComplete && !lensAdmitted)
        errors.push(`${String(o.state)} requires every selected lens result to be admitted`);
    if (o.state === "reviewing") {
        if (fixIds.length || attempts !== 0 || has("actual_correction_lines") || has("ledger_hash") || has("evidence_hash")) {
            errors.push("reviewing record contains post-review data");
        }
        if (admitted.some((e) => e.role === "validator"))
            errors.push("reviewing record admits no validator result");
    }
    if (o.state === "correction_required") {
        if (fixIds.length === 0)
            errors.push("correction_required requires fix_finding_ids");
        // A reopened correction (a failed validation with attempts left) carries the attempts already spent, never the last allowed one.
        if (attempts >= MAX_CORRECTION_ATTEMPTS || has("actual_correction_lines"))
            errors.push("correction_required precedes the correction attempt");
    }
    if (o.state === "validating") {
        if (fixIds.length === 0)
            errors.push("validating requires fix_finding_ids");
        if (attempts < 1)
            errors.push("validating requires correction_attempts to be at least 1 (correction_attempts)");
        if (!nonNegInt(o.actual_correction_lines) || (nonNegInt(o.correction_budget) && o.actual_correction_lines > o.correction_budget)) {
            errors.push("actual_correction_lines must be within correction_budget");
        }
    }
    if (needsComplete && !has("ledger_hash"))
        errors.push(`${String(o.state)} requires ledger_hash`);
    if (has("ledger_hash") && o.ledger_hash !== ledgerHashOf(findings))
        errors.push("ledger_hash does not match findings");
    if (o.state === "approved") {
        const refutedIds = Array.isArray(o.refuted_finding_ids) ? o.refuted_finding_ids : [];
        const unresolved = findings.some((f) => {
            const d = findingDisposition(f, refutedIds);
            return d === "blocking" || d === "inconclusive";
        });
        if (attempts === 0 && (fixIds.length || unresolved))
            errors.push("approved without a correction cannot hold severe findings");
        if (attempts >= 1 && !hasValidator)
            errors.push("approved after a correction requires an admitted validator result");
        if (attempts >= 1 && !nonNegInt(o.actual_correction_lines))
            errors.push("approved after a correction requires actual_correction_lines");
        if (!has("evidence_hash"))
            errors.push("approved requires evidence_hash");
    }
    if (o.state !== "validating" && o.state !== "approved" && o.state !== "escalated" && hasValidator)
        errors.push("validator result requires a validating or later state");
    const record = input;
    if (errors.length === 0 && record.state === "approved" && record.evidence_hash !== evidenceHashOf(record))
        errors.push("evidence_hash does not match admitted results");
    try {
        if (record.revision !== stateRevision(record))
            errors.push("revision does not match the record content");
    }
    catch {
        errors.push("revision cannot be recomputed from the record content");
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true, record };
}
function badNow(now) {
    return isTime(now) ? undefined : refuse("invalid_input", "now must be a UTC RFC 3339 timestamp");
}
function copy(record) {
    const { revision: _r, ...rest } = record;
    void _r;
    return {
        ...rest,
        selected_lenses: [...record.selected_lenses],
        admitted_role_results: record.admitted_role_results.map((e) => ({ ...e })),
        findings: record.findings.map((f) => ({ ...f })),
        fix_finding_ids: [...record.fix_finding_ids],
        ...(record.refuted_finding_ids ? { refuted_finding_ids: [...record.refuted_finding_ids] } : {}),
    };
}
function lensesAdmitted(record) {
    return record.selected_lenses.every((l) => record.admitted_role_results.some((e) => e.role === "lens" && e.lens === l));
}
function newToken(gen) {
    return gen ? gen() : randomBytes(32).toString("hex");
}
/** New lineage: reviewing, or directly approved (token issued) when the policy requires no lenses. */
export function start(input) {
    const invalid = (m) => refuse("invalid_input", m);
    if (typeof input.lineageId !== "string" || !LINEAGE_RE.test(input.lineageId))
        return invalid("lineageId must match review-<16 hex>");
    if (typeof input.targetIdentity !== "string" || !SHA_RE.test(input.targetIdentity))
        return invalid("targetIdentity must be sha256:<64 hex>");
    if (input.projection !== "workspace" && input.projection !== "staged")
        return invalid("projection must be workspace or staged");
    if (typeof input.baseTree !== "string" || !TREE_RE.test(input.baseTree))
        return invalid("baseTree must be a 40 or 64 hex tree id");
    if (typeof input.candidateTree !== "string" || !TREE_RE.test(input.candidateTree))
        return invalid("candidateTree must be a 40 or 64 hex tree id");
    const problem = lensSetProblem(input.riskLevel, input.selectedLenses);
    if (problem)
        return invalid(problem);
    if (!nonNegInt(input.originalChangedLines))
        return invalid("originalChangedLines must be a non-negative integer");
    const now = badNow(input.now);
    if (now)
        return now;
    const reviewing = seal({
        schema: STATE_SCHEMA,
        lineage_id: input.lineageId,
        state: "reviewing",
        target_identity: input.targetIdentity,
        projection: input.projection,
        base_tree: input.baseTree,
        candidate_tree: input.candidateTree,
        risk_level: input.riskLevel,
        selected_lenses: [...input.selectedLenses],
        original_changed_lines: input.originalChangedLines,
        correction_budget: correctionBudget(input.originalChangedLines),
        correction_budget_policy: "floor_two",
        correction_attempts: 0,
        admitted_role_results: [],
        findings: [],
        fix_finding_ids: [],
        burned: false,
        created_at: input.now,
        updated_at: input.now,
    });
    if (reviewing.selected_lenses.length > 0)
        return { ok: true, record: reviewing };
    const approved = approve(reviewing, { now: input.now, randomToken: input.randomToken });
    return approved.ok ? { ok: true, record: approved.record, ackToken: approved.ackToken } : approved;
}
export function admitLensResult(record, input) {
    if (record.state !== "reviewing")
        return refuse("illegal_state", `cannot admit a lens result from ${record.state}`);
    const now = badNow(input.now);
    if (now)
        return now;
    if (!isLens(input.lens) || !record.selected_lenses.includes(input.lens))
        return refuse("invalid_input", `lens ${String(input.lens)} is not selected`);
    if (typeof input.resultHash !== "string" || !SHA_RE.test(input.resultHash))
        return refuse("invalid_input", "resultHash must be sha256:<64 hex>");
    if (input.artifactDigest !== undefined && (typeof input.artifactDigest !== "string" || !SHA_RE.test(input.artifactDigest))) {
        return refuse("invalid_input", "artifactDigest must be sha256:<64 hex>");
    }
    if (record.admitted_role_results.some((e) => e.role === "lens" && e.lens === input.lens)) {
        return refuse("lens_already_admitted", `lens ${input.lens} already has an admitted result`);
    }
    if (record.admitted_role_results.length >= MAX_ADMITTED_ROLE_RESULTS)
        return refuse("capacity_exceeded", "admitted role results are full");
    if (!Array.isArray(input.findings))
        return refuse("invalid_input", "findings must be a list");
    const prefix = findingIdPrefixForLens(input.lens);
    const known = new Set(record.findings.map((f) => f.id));
    const accepted = [];
    for (const f of input.findings) {
        const shaped = isObj(f) && typeof f.id === "string" && FINDING_ID_RE.test(f.id) && f.lens === input.lens &&
            typeof f.severity === "string" && SEVERITIES.includes(f.severity) &&
            typeof f.location === "string" && typeof f.claim === "string" &&
            (f.evidence_class === undefined || EVIDENCE_CLASSES.includes(f.evidence_class)) &&
            (f.causal_disposition === undefined || CAUSAL_DISPOSITIONS.includes(f.causal_disposition));
        if (!shaped)
            return refuse("invalid_input", "finding is malformed or bound to another lens");
        if (!f.id.startsWith(prefix))
            return refuse("invalid_input", `finding id ${f.id} must carry the ${prefix} prefix of lens ${input.lens}`);
        if (known.has(f.id))
            return refuse("invalid_input", `finding id ${f.id} repeats`);
        known.add(f.id);
        accepted.push({
            id: f.id, lens: f.lens, severity: f.severity, location: f.location, claim: f.claim,
            ...(f.evidence_class !== undefined ? { evidence_class: f.evidence_class } : {}),
            ...(f.causal_disposition !== undefined ? { causal_disposition: f.causal_disposition } : {}),
        });
    }
    const next = copy(record);
    next.admitted_role_results.push({
        role: "lens",
        lens: input.lens,
        result_hash: input.resultHash,
        ...(input.artifactDigest !== undefined ? { artifact_digest: input.artifactDigest } : {}),
    });
    next.findings.push(...accepted);
    next.updated_at = input.now;
    return { ok: true, record: seal(next) };
}
export function admitValidatorResult(record, input) {
    if (record.state !== "validating")
        return refuse("illegal_state", `cannot admit a validator result from ${record.state}`);
    const now = badNow(input.now);
    if (now)
        return now;
    if (typeof input.resultHash !== "string" || !SHA_RE.test(input.resultHash))
        return refuse("invalid_input", "resultHash must be sha256:<64 hex>");
    if (input.artifactDigest !== undefined && (typeof input.artifactDigest !== "string" || !SHA_RE.test(input.artifactDigest))) {
        return refuse("invalid_input", "artifactDigest must be sha256:<64 hex>");
    }
    if (record.admitted_role_results.some((e) => e.role === "validator"))
        return refuse("validator_already_admitted", "a validator result is already admitted");
    if (record.admitted_role_results.length >= MAX_ADMITTED_ROLE_RESULTS)
        return refuse("capacity_exceeded", "admitted role results are full");
    const next = copy(record);
    next.admitted_role_results.push({
        role: "validator",
        result_hash: input.resultHash,
        ...(input.artifactDigest !== undefined ? { artifact_digest: input.artifactDigest } : {}),
    });
    next.updated_at = input.now;
    return { ok: true, record: seal(next) };
}
/** One optional refuter batch, after every lens result and before the correction decision. */
export function admitRefuterResult(record, input) {
    if (record.state !== "reviewing")
        return refuse("illegal_state", `cannot admit a refuter result from ${record.state}`);
    const now = badNow(input.now);
    if (now)
        return now;
    if (!lensesAdmitted(record))
        return refuse("lenses_incomplete", "every selected lens result must be admitted before a refuter result");
    if (typeof input.resultHash !== "string" || !SHA_RE.test(input.resultHash))
        return refuse("invalid_input", "resultHash must be sha256:<64 hex>");
    if (input.artifactDigest !== undefined && (typeof input.artifactDigest !== "string" || !SHA_RE.test(input.artifactDigest))) {
        return refuse("invalid_input", "artifactDigest must be sha256:<64 hex>");
    }
    if (record.admitted_role_results.some((e) => e.role === "refuter"))
        return refuse("refuter_already_admitted", "a refuter result is already admitted");
    if (record.admitted_role_results.length >= MAX_ADMITTED_ROLE_RESULTS)
        return refuse("capacity_exceeded", "admitted role results are full");
    const ids = input.refutedFindingIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string"))
        return refuse("invalid_input", "refutedFindingIds must be a list of strings");
    const canonical = [...new Set(ids)].sort();
    if (canonical.length !== ids.length || canonical.some((v, i) => v !== ids[i]))
        return refuse("invalid_input", "refutedFindingIds must be unique and sorted");
    for (const id of ids) {
        const f = record.findings.find((x) => x.id === id);
        if (!f || findingDisposition(f) !== "blocking")
            return refuse("invalid_input", `${id} is not a refutable severe finding of this review`);
    }
    const next = copy(record);
    next.admitted_role_results.push({
        role: "refuter",
        result_hash: input.resultHash,
        ...(input.artifactDigest !== undefined ? { artifact_digest: input.artifactDigest } : {}),
    });
    next.refuted_finding_ids = [...ids];
    next.updated_at = input.now;
    return { ok: true, record: seal(next) };
}
/** Freezes the ledger and opens a correction phase (up to MAX_CORRECTION_ATTEMPTS per lineage) for the named severe findings. */
export function requireCorrection(record, input) {
    if (record.state !== "reviewing")
        return refuse("illegal_state", `cannot require a correction from ${record.state}`);
    const now = badNow(input.now);
    if (now)
        return now;
    if (!lensesAdmitted(record))
        return refuse("lenses_incomplete", "every selected lens result must be admitted before a correction");
    if (!Array.isArray(input.fixFindingIds) || input.fixFindingIds.length === 0)
        return refuse("no_fix_findings", "a correction needs at least one severe finding id");
    const ids = input.fixFindingIds;
    const canonical = [...new Set(ids)].sort();
    if (canonical.length !== ids.length || canonical.some((v, i) => v !== ids[i]))
        return refuse("invalid_input", "fixFindingIds must be unique and sorted");
    for (const id of ids) {
        const f = record.findings.find((x) => x.id === id);
        if (!f || findingDisposition(f, record.refuted_finding_ids ?? []) !== "blocking")
            return refuse("invalid_input", `${String(id)} is not a blocking severe finding of this review`);
    }
    if (record.correction_attempts >= MAX_CORRECTION_ATTEMPTS)
        return refuse("illegal_state", "the correction attempts are already consumed");
    if (record.correction_budget <= 0)
        return refuse("correction_unavailable", "the correction budget is zero; escalate instead");
    const next = copy(record);
    next.state = "correction_required";
    next.fix_finding_ids = [...ids];
    next.ledger_hash = ledgerHashOf(next.findings);
    next.updated_at = input.now;
    return { ok: true, record: seal(next) };
}
export function beginValidation(record, input) {
    if (record.state !== "correction_required")
        return refuse("illegal_state", `cannot begin validation from ${record.state}`);
    const now = badNow(input.now);
    if (now)
        return now;
    if (!nonNegInt(input.actualCorrectionLines))
        return refuse("invalid_input", "actualCorrectionLines must be a non-negative integer");
    if (input.actualCorrectionLines > record.correction_budget) {
        return refuse("correction_over_budget", `correction of ${input.actualCorrectionLines} lines exceeds the budget of ${record.correction_budget}`);
    }
    if (input.correctionTargetIdentity !== undefined && (typeof input.correctionTargetIdentity !== "string" || !SHA_RE.test(input.correctionTargetIdentity))) {
        return refuse("invalid_input", "correctionTargetIdentity must be sha256:<64 hex>");
    }
    if (input.correctionCandidateTree !== undefined) {
        if (input.correctionTargetIdentity === undefined)
            return refuse("invalid_input", "correctionCandidateTree needs correctionTargetIdentity");
        if (typeof input.correctionCandidateTree !== "string" || !TREE_RE.test(input.correctionCandidateTree))
            return refuse("invalid_input", "correctionCandidateTree must be a 40 or 64 hex tree id");
    }
    if (input.correctionTargetIdentity === record.target_identity || (input.correctionCandidateTree !== undefined && input.correctionCandidateTree === record.candidate_tree)) {
        return refuse("correction_unavailable", "the corrected candidate is unchanged: make a correction before validating");
    }
    const next = copy(record);
    next.state = "validating";
    next.correction_attempts = record.correction_attempts + 1;
    next.actual_correction_lines = input.actualCorrectionLines;
    if (input.correctionTargetIdentity !== undefined)
        next.correction_target_identity = input.correctionTargetIdentity;
    if (input.correctionCandidateTree !== undefined)
        next.correction_candidate_tree = input.correctionCandidateTree;
    next.updated_at = input.now;
    return { ok: true, record: seal(next) };
}
/**
 * From validating with a corrected candidate, the lineage's candidate becomes the corrected one (the reviewed original is
 * kept as history). `tree` completes a record that has no `correction_candidate_tree`. Returns false when the corrected
 * tree is unknown (nothing is changed).
 */
function adoptCorrected(next, record, tree) {
    const corrected = record.correction_target_identity;
    const correctedTree = record.correction_candidate_tree ?? tree;
    if (corrected === undefined || correctedTree === undefined)
        return false;
    next.correction_candidate_tree = correctedTree;
    // The first reviewed candidate stays the history across several corrections.
    next.original_target_identity = record.original_target_identity ?? record.target_identity;
    next.original_candidate_tree = record.original_candidate_tree ?? record.candidate_tree;
    next.target_identity = corrected;
    next.candidate_tree = correctedTree;
    return true;
}
/** Approves and issues the one-shot acknowledgement token; only its hash is stored. */
export function approve(record, input) {
    if (record.state !== "reviewing" && record.state !== "validating")
        return refuse("illegal_state", `cannot approve from ${record.state}`);
    const now = badNow(input.now);
    if (now)
        return now;
    if (!lensesAdmitted(record))
        return refuse("lenses_incomplete", "every selected lens result must be admitted before approval");
    if (record.state === "reviewing" && record.findings.some((f) => {
        const d = findingDisposition(f, record.refuted_finding_ids ?? []);
        return d === "blocking" || d === "inconclusive";
    })) {
        return refuse("severe_findings_open", "severe findings require a correction or escalation");
    }
    if (record.state === "validating" && !record.admitted_role_results.some((e) => e.role === "validator")) {
        return refuse("validator_missing", "a validator result must be admitted before approval");
    }
    const token = newToken(input.randomToken);
    if (!TOKEN_RE.test(token))
        return refuse("invalid_input", "acknowledgement token must be 256 bits of lowercase hex");
    if (input.correctionCandidateTree !== undefined && (typeof input.correctionCandidateTree !== "string" || !TREE_RE.test(input.correctionCandidateTree))) {
        return refuse("invalid_input", "correctionCandidateTree must be a 40 or 64 hex tree id");
    }
    if (input.correctionCandidateTree !== undefined && record.correction_target_identity === undefined) {
        return refuse("invalid_input", "correctionCandidateTree needs a record with a correction target");
    }
    const next = copy(record);
    if (record.state === "validating" && record.correction_target_identity !== undefined) {
        // The validator judged the CORRECTED candidate: from here on the lineage's candidate is that one (reference engine:
        // `state.CurrentSnapshot = snapshot` after the correction). The reviewed original is kept only as history. Without
        // the corrected tree the approval is refused: the original must never stay the target of an approval after a correction.
        if (!adoptCorrected(next, record, input.correctionCandidateTree)) {
            return refuse("invalid_input", "an approval after a correction needs the corrected candidate tree (correction_candidate_tree)");
        }
    }
    next.state = "approved";
    next.ledger_hash = ledgerHashOf(next.findings);
    next.evidence_hash = evidenceHashOf({ ...next, revision: "" });
    next.approved_ack_token_hash = tokenHashOf(token);
    next.updated_at = input.now;
    return { ok: true, record: seal(next), ackToken: token };
}
/**
 * A validating correction that failed with attempts left reopens a correction on the same frozen findings. The failed
 * corrected candidate becomes the lineage's candidate (the next correction is measured and scoped against it). Refused
 * when no attempt is left or the corrected tree is unknown; the caller then escalates.
 */
export function reopenCorrection(record, input) {
    if (record.state !== "validating")
        return refuse("illegal_state", `cannot reopen a correction from ${record.state}`);
    const now = badNow(input.now);
    if (now)
        return now;
    if (record.correction_attempts >= MAX_CORRECTION_ATTEMPTS)
        return refuse("illegal_state", "the correction attempts are already consumed");
    if (input.correctionCandidateTree !== undefined && (typeof input.correctionCandidateTree !== "string" || !TREE_RE.test(input.correctionCandidateTree))) {
        return refuse("invalid_input", "correctionCandidateTree must be a 40 or 64 hex tree id");
    }
    const next = copy(record);
    if (!adoptCorrected(next, record, input.correctionCandidateTree))
        return refuse("invalid_input", "a reopened correction needs the corrected candidate tree (correction_candidate_tree)");
    next.state = "correction_required";
    delete next.correction_target_identity;
    delete next.correction_candidate_tree;
    delete next.actual_correction_lines;
    next.updated_at = input.now;
    return { ok: true, record: seal(next) };
}
export function escalate(record, input) {
    if (record.state !== "reviewing" && record.state !== "correction_required" && record.state !== "validating") {
        return refuse("illegal_state", `cannot escalate from ${record.state}`);
    }
    const now = badNow(input.now);
    if (now)
        return now;
    if (typeof input.reason !== "string" || input.reason.trim() === "")
        return refuse("invalid_input", "an escalation needs a reason");
    if (input.correctionCandidateTree !== undefined && (typeof input.correctionCandidateTree !== "string" || !TREE_RE.test(input.correctionCandidateTree))) {
        return refuse("invalid_input", "correctionCandidateTree must be a 40 or 64 hex tree id");
    }
    if (input.correctionCandidateTree !== undefined && record.correction_target_identity === undefined) {
        return refuse("invalid_input", "correctionCandidateTree needs a record with a correction target");
    }
    const next = copy(record);
    // An escalation after a validated correction binds the corrected candidate too (reference engine sets the current
    // snapshot before deciding escalated vs validating); without a known corrected tree it keeps the reviewed one.
    if (record.state === "validating")
        adoptCorrected(next, record, input.correctionCandidateTree);
    next.state = "escalated";
    next.escalation_reason = input.reason;
    next.updated_at = input.now;
    return { ok: true, record: seal(next) };
}
export function invalidate(record, input) {
    if (record.state === "approved" && record.burned)
        return refuse("already_burned", "a burned approval cannot be invalidated");
    if (record.state === "escalated" || record.state === "invalidated")
        return refuse("illegal_state", `cannot invalidate from ${record.state}`);
    const now = badNow(input.now);
    if (now)
        return now;
    if (typeof input.reason !== "string" || input.reason.trim() === "")
        return refuse("invalid_input", "an invalidation needs a reason");
    const next = copy(record);
    next.state = "invalidated";
    delete next.approved_ack_token_hash;
    delete next.evidence_hash;
    delete next.ledger_hash;
    next.fix_finding_ids = [];
    next.correction_attempts = 0;
    delete next.actual_correction_lines;
    delete next.refuted_finding_ids;
    delete next.correction_target_identity;
    delete next.correction_candidate_tree;
    if (next.original_target_identity !== undefined && next.original_candidate_tree !== undefined) {
        next.target_identity = next.original_target_identity;
        next.candidate_tree = next.original_candidate_tree;
    }
    delete next.original_target_identity;
    delete next.original_candidate_tree;
    next.admitted_role_results = next.admitted_role_results.filter((e) => e.role === "lens");
    next.invalidation_reason = input.reason;
    next.updated_at = input.now;
    return { ok: true, record: seal(next) };
}
/** Spends the approval: the raw token must hash to the stored hash (constant-time compare). */
export function burn(record, input) {
    if (record.state !== "approved")
        return refuse("illegal_state", `cannot burn from ${record.state}`);
    if (record.burned)
        return refuse("already_burned", "this approval was already burned");
    const now = badNow(input.now);
    if (now)
        return now;
    if (typeof input.token !== "string" || !TOKEN_RE.test(input.token))
        return refuse("token_malformed", "the acknowledgement token must be 64 lowercase hex characters");
    const stored = Buffer.from(record.approved_ack_token_hash ?? "", "utf8");
    const given = Buffer.from(tokenHashOf(input.token), "utf8");
    if (stored.length !== given.length || !timingSafeEqual(stored, given))
        return refuse("token_mismatch", "the acknowledgement token does not match this approval");
    const next = copy(record);
    next.burned = true;
    next.approved_revision = record.revision;
    next.updated_at = input.now;
    next.burn_receipt = domainHash("review-burn-receipt", 1, {
        lineage_id: record.lineage_id,
        token_hash: record.approved_ack_token_hash,
        burned_at: input.now,
    });
    return { ok: true, record: seal(next) };
}
