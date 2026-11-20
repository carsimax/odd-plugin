// Acknowledge / burn (U7): spends an approval exactly once and leaves a receipt that gates (U13/U14) can check.
//
// Equivalent of the reference `compact_burn.go AcknowledgeApprovedCompactAuthority` under odd-claude names: the raw
// token is checked against the stored domain hash (constant-time, state.ts `burn`), the target identity and the live
// revision must match, and the approval can be spent once.
//
// Crash-safe ordering (decision, tested by ack.spec.ts with a SIGKILL at every fs call):
//   RECEIPT FIRST, BURN SECOND, both inside ONE store lock (`updateState`):
//     1. token / target / state / revision are verified with no side effect;
//     2. `review-receipt.json` is written create-only and atomically (an inert fact: while the state is still unburned
//        no gate treats it as consumption);
//     3. the burned state is written (the CAS commit; this is the irreversible step and it comes last).
//   A crash between 2 and 3 leaves "approved + receipt, unburned": nothing is consumed, and a retry with the same
//   token and revision finds the receipt, verifies it equals what it would write (reusing its `burned_at`) and only
//   commits the burn. A crash before 2 or 3 leaves a stray temp that the next mutation sweeps. "Burned without a
//   receipt" is therefore unreachable through this module (the reference publishes its inert fact before the burn for
//   the same reason). The gates read consumption from the BURNED STATE plus a VALID matching receipt, never from the
//   receipt alone, so "receipt without burn" is never consumption.
// Which candidate is bound: the record's `target_identity` (and `candidate_tree`). After a validated correction state.ts
// makes that the CORRECTED candidate (the reviewed original is kept as `original_*` history), so `input.target` must be
// the corrected identity: the original (defective) candidate is `wrong_target`, the receipt carries the corrected
// identity/tree, and `scanTarget` matches on it, so the original never counts as consumed.
// Once burned, the stored token hash stays in the record, so a retry with a stale revision cannot re-burn: it is
// refused as `target_already_acknowledged`.
import { timingSafeEqual } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, domainHash } from "./canonical.js";
import { LENSES, MAX_CORRECTION_ATTEMPTS, burn } from "./state.js";
import { StoreConcurrentUpdateError, StoreCorruptError, StoreInvalidLineageError, StoreNotFoundError, listLineages, readReceipt, readState, storeRootFor, updateState, writeAtomic, } from "./store.js";
export const RECEIPT_SCHEMA = "odd-claude.review-receipt/v1";
const RECEIPT_FILE = "review-receipt.json";
const SHA_RE = /^sha256:[0-9a-f]{64}$/;
const TREE_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const LINEAGE_RE = /^review-[0-9a-f]{16}$/;
export class AckRefusedError extends Error {
    code;
    constructor(code, message, options) {
        super(`acknowledge refused (${code}): ${message}`, options);
        this.name = "AckRefusedError";
        this.code = code;
    }
}
const receiptHashOf = (body) => domainHash("review-receipt", 1, body);
function buildReceipt(approved, burned, burnedAt) {
    const body = {
        schema: RECEIPT_SCHEMA,
        lineage_id: approved.lineage_id,
        target_identity: approved.target_identity,
        projection: approved.projection,
        base_tree: approved.base_tree,
        candidate_tree: approved.candidate_tree,
        approved_revision: approved.revision,
        burned_at: burnedAt,
        selected_lenses: [...approved.selected_lenses],
        risk_level: approved.risk_level,
        ledger_hash: approved.ledger_hash ?? "",
        evidence_hash: approved.evidence_hash ?? "",
        burn_receipt: burned.burn_receipt ?? "",
    };
    return { ...body, receipt_hash: receiptHashOf(body) };
}
const RECEIPT_KEYS = [
    "schema", "lineage_id", "target_identity", "projection", "base_tree", "candidate_tree", "approved_revision",
    "burned_at", "selected_lenses", "risk_level", "ledger_hash", "evidence_hash", "burn_receipt", "receipt_hash",
];
/** Strict structural validation plus recomputation of `receipt_hash`. */
export function validateReceipt(input) {
    const errors = [];
    if (typeof input !== "object" || input === null || Array.isArray(input))
        return { ok: false, errors: ["receipt must be an object"] };
    const o = input;
    for (const k of Object.keys(o))
        if (!RECEIPT_KEYS.includes(k))
            errors.push(`unknown field ${k}`);
    for (const k of RECEIPT_KEYS)
        if (!(k in o))
            errors.push(`missing field ${k}`);
    if (errors.length > 0)
        return { ok: false, errors };
    const sha = (k) => typeof o[k] === "string" && SHA_RE.test(o[k]);
    if (o.schema !== RECEIPT_SCHEMA)
        errors.push(`schema must be ${RECEIPT_SCHEMA}`);
    if (typeof o.lineage_id !== "string" || !LINEAGE_RE.test(o.lineage_id))
        errors.push("lineage_id must match review-<16 hex>");
    for (const k of ["target_identity", "approved_revision", "ledger_hash", "evidence_hash", "burn_receipt", "receipt_hash"]) {
        if (!sha(k))
            errors.push(`${k} must be sha256:<64 hex>`);
    }
    if (o.projection !== "workspace" && o.projection !== "staged")
        errors.push("projection must be workspace or staged");
    for (const k of ["base_tree", "candidate_tree"])
        if (typeof o[k] !== "string" || !TREE_RE.test(o[k]))
            errors.push(`${k} must be a tree id`);
    if (typeof o.burned_at !== "string" || !TIME_RE.test(o.burned_at) || !Number.isFinite(Date.parse(o.burned_at)))
        errors.push("burned_at must be a UTC RFC 3339 timestamp");
    if (o.risk_level !== "low" && o.risk_level !== "medium" && o.risk_level !== "high")
        errors.push("risk_level must be low, medium or high");
    if (!Array.isArray(o.selected_lenses) || !o.selected_lenses.every((l) => typeof l === "string" && LENSES.includes(l))) {
        errors.push("selected_lenses must be a list of known lenses");
    }
    if (errors.length === 0) {
        const { receipt_hash: _h, ...body } = o;
        void _h;
        if (o.receipt_hash !== receiptHashOf(body))
            errors.push("receipt_hash does not match the receipt content");
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true, receipt: o };
}
function refusalFor(code, message) {
    switch (code) {
        case "token_malformed":
        case "token_mismatch":
            return new AckRefusedError("wrong_token", message);
        case "illegal_state":
            return new AckRefusedError("not_approved", message);
        case "already_burned":
            return new AckRefusedError("target_already_acknowledged", message);
        default:
            return new AckRefusedError("invalid_input", message);
    }
}
const isoNow = () => new Date().toISOString();
const sameJson = (a, b) => {
    const x = Buffer.from(canonicalJson(a));
    const y = Buffer.from(canonicalJson(b));
    return x.length === y.length && timingSafeEqual(x, y);
};
/**
 * Burns the approved lineage with its one-shot token and writes the receipt (see the ordering note above). Resolves
 * with the burned record and the receipt, or throws `AckRefusedError` with a typed code (state unchanged). Idempotent
 * completion: after a crash between receipt and burn, retry with the SAME token and revision.
 */
export async function acknowledgeApproved(commonDir, input, options = {}) {
    if (typeof input?.target !== "string" || !SHA_RE.test(input.target))
        throw new AckRefusedError("invalid_input", "target must be sha256:<64 hex>");
    if (typeof input.expectedRevision !== "string" || !SHA_RE.test(input.expectedRevision))
        throw new AckRefusedError("invalid_input", "expectedRevision must be sha256:<64 hex>");
    const clock = options.now ?? isoNow;
    let receipt;
    try {
        const out = await updateState(commonDir, input.lineage, input.expectedRevision, (record) => {
            if (record.state !== "approved")
                throw new AckRefusedError("not_approved", `the review is ${record.state}, not approved`);
            if (record.burned)
                throw new AckRefusedError("target_already_acknowledged", "this approval was already acknowledged");
            if (record.target_identity !== input.target)
                throw new AckRefusedError("wrong_target", "the target does not match this lineage");
            // 1. verify the token with no side effect (burn() is pure; the compare is constant-time).
            const probe = burn(record, { token: input.token, now: clock() });
            if (!probe.ok)
                throw refusalFor(probe.refusal.code, probe.refusal.message);
            // 2. an existing receipt is a crashed earlier attempt: it must be exactly what we would write; reuse its burned_at.
            const file = join(storeRootFor(commonDir), record.lineage_id, RECEIPT_FILE);
            let existing;
            try {
                existing = readReceipt(commonDir, record.lineage_id);
            }
            catch (e) {
                if (e instanceof StoreCorruptError)
                    throw new AckRefusedError("corrupt_receipt", e.message, { cause: e });
                if (!(e instanceof StoreNotFoundError))
                    throw e;
            }
            let burnedAt = probe.record.updated_at;
            if (existing !== undefined) {
                const v = validateReceipt(existing);
                if (!v.ok)
                    throw new AckRefusedError("corrupt_receipt", `existing receipt is invalid: ${v.errors.join("; ")}`);
                burnedAt = v.receipt.burned_at;
            }
            const burned = existing === undefined ? probe : burn(record, { token: input.token, now: burnedAt });
            if (!burned.ok)
                throw refusalFor(burned.refusal.code, burned.refusal.message);
            const built = buildReceipt(record, burned.record, burnedAt);
            if (existing !== undefined) {
                if (!sameJson(existing, built))
                    throw new AckRefusedError("corrupt_receipt", "an existing receipt does not match this approval");
            }
            else {
                if (lstatOrNull(file))
                    throw new AckRefusedError("corrupt_receipt", "a receipt path exists but could not be read as a receipt");
                writeAtomic(file, `${canonicalJson(built)}\n`);
            }
            receipt = built;
            // 3. the CAS commit of the burn is written by updateState right after this returns.
            return burned;
        }, options);
        return { ok: true, record: out.record, receipt: receipt };
    }
    catch (e) {
        if (e instanceof StoreConcurrentUpdateError) {
            const cur = safeReadState(commonDir, input.lineage);
            if (cur?.state === "approved" && cur.burned)
                throw new AckRefusedError("target_already_acknowledged", "this approval was already acknowledged", { cause: e });
            throw new AckRefusedError("concurrent_update", e.message, { cause: e });
        }
        if (e instanceof StoreInvalidLineageError)
            throw new AckRefusedError("invalid_input", e.message, { cause: e });
        if (e instanceof StoreNotFoundError)
            throw new AckRefusedError("authority_absent", "no review authority exists for this lineage", { cause: e });
        throw e;
    }
}
function lstatOrNull(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch (e) {
        if (e.code === "ENOENT")
            return false;
        throw e;
    }
}
function safeReadState(commonDir, lineage) {
    try {
        return readState(commonDir, lineage);
    }
    catch {
        return undefined;
    }
}
/** Bounded scan (store.listLineages). Consumption is read from the burned state; the receipt must also match it. */
export function scanTarget(commonDir, targetIdentity, options = {}) {
    const listing = listLineages(commonDir, options);
    const scan = { receipts: [], burnedLineages: [], truncated: listing.truncated, problems: [] };
    for (const lineage of listing.lineages) {
        let state;
        try {
            state = readState(commonDir, lineage);
        }
        catch (e) {
            if (e instanceof StoreNotFoundError)
                continue;
            scan.problems.push({ lineage, code: "state_unreadable", message: e.message });
            continue;
        }
        if (state.target_identity !== targetIdentity || state.state !== "approved" || !state.burned)
            continue;
        scan.burnedLineages.push(lineage);
        let raw;
        try {
            raw = readReceipt(commonDir, lineage);
        }
        catch (e) {
            const missing = e instanceof StoreNotFoundError;
            scan.problems.push({ lineage, code: missing ? "receipt_missing" : "receipt_corrupt", message: e.message });
            continue;
        }
        const v = validateReceipt(raw);
        if (!v.ok) {
            scan.problems.push({ lineage, code: "receipt_corrupt", message: v.errors.join("; ") });
            continue;
        }
        const r = v.receipt;
        if (r.lineage_id !== lineage || r.target_identity !== state.target_identity || r.burn_receipt !== state.burn_receipt ||
            r.burned_at !== state.updated_at || r.candidate_tree !== state.candidate_tree || r.base_tree !== state.base_tree ||
            r.projection !== state.projection || r.risk_level !== state.risk_level || !sameJson(r.selected_lenses, state.selected_lenses) ||
            r.ledger_hash !== state.ledger_hash || r.evidence_hash !== state.evidence_hash || r.approved_revision !== state.approved_revision) {
            scan.problems.push({ lineage, code: "receipt_mismatch", message: "the receipt does not match the burned state" });
            continue;
        }
        scan.receipts.push(r);
    }
    scan.receipts.sort((a, b) => (a.burned_at < b.burned_at ? 1 : a.burned_at > b.burned_at ? -1 : 0));
    return scan;
}
/** The newest valid receipt of a burned lineage for the target, ignoring every other lineage. */
export function findReceiptForTarget(commonDir, targetIdentity, options = {}) {
    const scan = scanTarget(commonDir, targetIdentity, options);
    return { ...(scan.receipts[0] ? { receipt: scan.receipts[0] } : {}), truncated: scan.truncated, problems: scan.problems };
}
export function isTargetConsumed(commonDir, targetIdentity, options = {}) {
    const scan = scanTarget(commonDir, targetIdentity, options);
    const status = scan.receipts.length > 0 ? "consumed" : scan.problems.length > 0 ? "unknown" : "not_consumed";
    return { status, consumed: status === "consumed", truncated: scan.truncated, problems: scan.problems };
}
export function budgetStatus(record) {
    const used = record.actual_correction_lines ?? 0;
    return {
        correctionBudget: record.correction_budget,
        actualCorrectionLines: used,
        linesRemaining: Math.max(0, record.correction_budget - used),
        attempts: record.correction_attempts,
        attemptsRemaining: Math.max(0, MAX_CORRECTION_ATTEMPTS - record.correction_attempts),
    };
}
