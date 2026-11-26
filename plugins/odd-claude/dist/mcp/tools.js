// The review MCP tools (U15): thin adapters over the verified review modules. Nothing here decides review policy.
//
// Rules every tool follows:
//  - Input is validated against the tool's JSON schema (jsonschema.ts) before anything runs; a violation is the typed tool error
//    `invalid_input` listing the problems (never a protocol error, so the model can correct the call).
//  - Routing comes only from `review_status` transitions. Consent is never answered here: `review_start` always relays (the
//    consent envelope comes back untouched) and only `review_answer_consent`, which takes the human's explicit answer plus the
//    exact target identity the question was asked for, records it.
//  - A direct start never duplicates a lineage waiting for its correction: `pendingCorrectionLineage` (run.ts) is checked first
//    and the pending lineage is returned as the typed error `correction_lineage_pending`.
//  - Reviewer runs cost money: `review_run`, `review_capture` and `review_capture_group` return a forecast first and run
//    reviewers only when called again with `reviewer_run_acknowledged: true` and the forecast's `reviewer_run_binding`.
//  - Reviewers run through the injected runner (default: the isolated `claude -p` runner of review/runner.ts).
//  - Outputs are bounded (MAX_OUTPUT_BYTES), errors are typed (`{error:{code,message,...}}` with `isError: true`), nothing is
//    reported to anyone.
import { acknowledgeApproved, AckRefusedError } from "../review/ack.js";
import { completeReview } from "../review/capture.js";
import { decodeBinding, encodeAckEnvelope, encodeCaptureEnvelope, encodeStartEnvelope } from "../review/contract.js";
import { consentBinding, REVIEW_CONTRACT, REVIEW_TOOL_NAMES } from "../review/consent.js";
import { readReviewMode, ReviewModeError } from "../review/mode.js";
import { assessCandidate } from "../review/risk.js";
import { pendingCorrectionLineage, runReview, snapshotTargetFor, validateReviewerOptions, } from "../review/run.js";
import { resolveRepository, SnapshotError } from "../review/snapshot.js";
import { startReview } from "../review/start.js";
import { assessRisk } from "../review/risk.js";
import { reviewStatus } from "../review/status.js";
import { listLineages, readState, StoreAlreadyExistsError, StoreConcurrentUpdateError, StoreCorruptError, StoreInvalidLineageError, StoreInvalidRecordError, StoreIoError, StoreNotFoundError, StoreTransitionRefusedError, } from "../review/store.js";
import { StoreLockContended, StoreLockError } from "../review/lock.js";
import { validateSchema } from "./jsonschema.js";
/** Largest tool result text (bytes). Bigger results become the typed error `output_too_large`. */
export const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_PATHS = 200;
// ---- results ----
function ok(body) {
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES)
        return fail("output_too_large", `the result is larger than ${MAX_OUTPUT_BYTES} bytes and was dropped`);
    return { content: [{ type: "text", text }] };
}
export function fail(code, message, extra = {}) {
    return { content: [{ type: "text", text: JSON.stringify({ error: { code, message: message.slice(0, 1000), ...extra } }) }], isError: true };
}
const STORE_ERRORS = [
    StoreInvalidLineageError, StoreNotFoundError, StoreAlreadyExistsError, StoreCorruptError, StoreConcurrentUpdateError, StoreTransitionRefusedError,
    StoreInvalidRecordError, StoreIoError, StoreLockContended, StoreLockError,
];
/** Every failure becomes a typed tool error; unknown exceptions only expose their message. */
export function errorResult(e) {
    if (e instanceof SnapshotError)
        return fail("snapshot_error", e.message, { detail: e.code });
    if (e instanceof AckRefusedError)
        return fail(e.code, e.message);
    if (e instanceof ReviewModeError)
        return fail("mode_error", e.message);
    if (e instanceof StoreNotFoundError || e instanceof StoreInvalidLineageError)
        return fail("unknown_lineage", e.message);
    if (STORE_ERRORS.some((c) => e instanceof c))
        return fail("authority_error", e.message, { detail: e.name });
    return fail("internal_error", e instanceof Error ? e.message : String(e));
}
// ---- schema pieces ----
const LINEAGE_PATTERN = "^[A-Za-z0-9._-]{1,128}$";
const SHA_PATTERN = "^sha256:[0-9a-f]{64}$";
const CWD = { type: "string", minLength: 1, maxLength: 4096, description: "Absolute path of the repository (or a directory inside it). Defaults to the server's working directory." };
const TARGET_PROPS = {
    cwd: CWD,
    target: { type: "string", enum: ["current-changes", "base-diff"], description: "What to review. Default current-changes." },
    base_ref: { type: "string", minLength: 1, maxLength: 256, description: "Base ref for target base-diff (required there, rejected otherwise)." },
    committed_only: { type: "boolean", description: "base-diff only: review the committed range, ignoring the worktree." },
    projection: { type: "string", enum: ["workspace", "staged"], description: "current-changes only. Default workspace." },
};
const LENS_PROPS = {
    lenses: { type: "array", items: { type: "string", minLength: 1, maxLength: 40 }, minItems: 1, maxItems: 4, description: "Explicit pertinent lenses (risk, resilience, readability, reliability), canonical order, no repeats; needs lenses_reason." },
    lenses_reason: { type: "string", minLength: 1, maxLength: 500 },
    locale: { type: "string", minLength: 2, maxLength: 35, pattern: "^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$" },
};
const RUN_PROPS = {
    model: { type: "string", enum: ["fable", "opus", "sonnet", "haiku"], description: "Reviewer model family for every reviewer of this run. Omit it to follow the active model profile per role (balanced by default)." },
    effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "Reviewer effort (needs a model; not for haiku)." },
    timeout_ms: { type: "integer", minimum: 1000, maximum: 7_200_000 },
    reviewer_run_acknowledged: { type: "boolean", description: "Authorizes the reviewer batch of the forecast named by reviewer_run_binding. Never set it before the user saw the forecast." },
    reviewer_run_binding: { type: "string", minLength: 1, maxLength: 200, description: "reviewer_run_binding of the forecast being acknowledged." },
};
const DETAIL = { type: "string", enum: ["concise", "full"], description: "Response size. full (default) is the complete status; concise drops only the projection detail and the per-slot schema, capture operation and artifact subject, and keeps every id, binding, identity, argument, next_transition, forecast, repair and consumed field." };
const NOTE = " The `arguments` of a review_status transition are exactly this tool's properties (values as strings; \"true\", integers and JSON arrays are coerced), so a transition can be passed as given.";
const object = (properties, required = []) => ({
    type: "object", properties, required, additionalProperties: false,
});
// ---- helpers ----
const CONCISE_STATUS_DROPS = ["projection"];
const CONCISE_INPUT_DROPS = ["schema", "capture_operation", "artifact_subject", "base_tree", "candidate_tree"];
/** review_status detail "concise": drops descriptive fields only; everything the next call needs (ids, bindings, arguments, next_transition) stays. */
function conciseStatus(status) {
    const out = { ...status };
    for (const k of CONCISE_STATUS_DROPS)
        delete out[k];
    const next = out.next_transition;
    if (next?.collect?.inputs !== undefined) {
        const inputs = next.collect.inputs.map((i) => {
            const c = { ...i };
            for (const k of CONCISE_INPUT_DROPS)
                delete c[k];
            return c;
        });
        out.next_transition = { ...next, collect: { ...next.collect, inputs } };
    }
    return out;
}
const str = (a, k) => (typeof a[k] === "string" ? a[k] : undefined);
const bool = (a, k) => (typeof a[k] === "boolean" ? a[k] : undefined);
const cwdOf = (a, ctx) => str(a, "cwd") ?? ctx.defaultCwd;
/** Cross-field target rules the flat schema cannot state. A string is a violation. */
function targetOf(a) {
    const kind = str(a, "target") ?? "current-changes";
    if (kind === "base-diff") {
        if (str(a, "base_ref") === undefined)
            return "target base-diff needs base_ref";
        if (a.projection !== undefined)
            return "projection is only for target current-changes";
        return { target: { kind: "base-diff", baseRef: str(a, "base_ref"), ...(bool(a, "committed_only") === true ? { committedOnly: true } : {}) } };
    }
    if (a.base_ref !== undefined || a.committed_only !== undefined)
        return "base_ref and committed_only are only for target base-diff";
    return { target: { kind: "current-changes" }, ...(a.projection !== undefined ? { projection: str(a, "projection") } : {}) };
}
const invalid = (message) => fail("invalid_input", message);
function lensesOf(a) {
    const lenses = a.lenses;
    const reason = str(a, "lenses_reason");
    if (lenses === undefined && reason !== undefined)
        return "lenses_reason needs lenses";
    if (lenses !== undefined && reason === undefined)
        return "lenses needs lenses_reason";
    return { ...(lenses !== undefined ? { lenses } : {}), ...(reason !== undefined ? { lensesReason: reason } : {}) };
}
const defaultAssessor = (snapshot, repository) => assessRisk(snapshot, repository);
/**
 * START behind the pending-correction guard. A candidate that is the correction of a lineage still in
 * correction_required/validating must not open a second lineage: the pending lineage is returned instead.
 */
async function guardedStart(a, ctx, consent, expectedTargetIdentity) {
    const t = targetOf(a);
    if (typeof t === "string")
        return invalid(t);
    const l = lensesOf(a);
    if (typeof l === "string")
        return invalid(l);
    const cwd = cwdOf(a, ctx);
    const pending = pendingCorrectionLineage(cwd, snapshotTargetFor({ target: t.target, projection: t.projection }));
    if (pending !== undefined) {
        if ("unreadable" in pending) {
            return fail("authority_error", `lineage ${pending.unreadable} cannot be read safely; no new review is opened until it is repaired`, { lineage_id: pending.unreadable });
        }
        const r = pending.rec;
        return fail("correction_lineage_pending", `lineage ${r.lineage_id} is waiting for its correction (${r.state}); resume it with review_run and lineage_id instead of opening a new review`, {
            lineage: { lineage_id: r.lineage_id, state: r.state, revision: r.revision, target_identity: r.target_identity, projection: r.projection, risk_level: r.risk_level },
        });
    }
    const outcome = await startReview({
        cwd,
        target: t.target,
        ...(t.projection !== undefined ? { projection: t.projection } : {}),
        ...l,
        consent,
        ...(str(a, "locale") !== undefined ? { locale: str(a, "locale") } : {}),
        ...(expectedTargetIdentity !== undefined ? { expectedTargetIdentity } : {}),
        riskAssessor: ctx.deps.riskAssessor ?? defaultAssessor,
    });
    return outcome.status === "refused" ? fail(outcome.code, outcome.message, { ...(outcome.lineage_id !== undefined ? { lineage_id: outcome.lineage_id } : {}) }) : ok(encodeStartEnvelope(outcome));
}
/** A run outcome as a tool result: blocked / binding-drift are typed errors, every other outcome is a normal result. */
function runResult(out) {
    if (out.outcome === "blocked") {
        return fail(out.code, out.message, {
            ...(out.detail !== undefined ? { detail: out.detail } : {}),
            ...(out.errors !== undefined ? { errors: out.errors.slice(0, 20) } : {}),
            ...(out.slot !== undefined ? { slot: out.slot } : {}),
            ...(out.status_after !== undefined ? { status_after: out.status_after } : {}),
            ...(out.lineage_id !== undefined ? { lineage_id: out.lineage_id } : {}),
        });
    }
    if (out.outcome === "binding-drift")
        return fail("binding_drift", out.message, { ...(out.field !== undefined ? { field: out.field } : {}), ...(out.lineage_id !== undefined ? { lineage_id: out.lineage_id } : {}) });
    return ok(out);
}
function runInput(a, ctx, extra = {}) {
    const t = targetOf(a);
    if (typeof t === "string")
        return invalid(t);
    const l = lensesOf(a);
    if (typeof l === "string")
        return invalid(l);
    const bad = validateReviewerOptions({ model: a.model, effort: a.effort });
    if (bad !== null)
        return invalid(bad);
    return {
        cwd: cwdOf(a, ctx),
        target: t.target,
        ...(t.projection !== undefined ? { projection: t.projection } : {}),
        ...l,
        ...(str(a, "lineage_id") !== undefined ? { lineageId: str(a, "lineage_id") } : {}),
        ...(str(a, "locale") !== undefined ? { locale: str(a, "locale") } : {}),
        ...(str(a, "model") !== undefined ? { model: str(a, "model") } : {}),
        ...(str(a, "effort") !== undefined ? { effort: str(a, "effort") } : {}),
        ...(typeof a.timeout_ms === "number" ? { timeoutMs: a.timeout_ms } : {}),
        ...(bool(a, "reviewer_run_acknowledged") !== undefined ? { reviewerRunAcknowledged: bool(a, "reviewer_run_acknowledged") } : {}),
        ...(str(a, "reviewer_run_binding") !== undefined ? { reviewerRunBinding: str(a, "reviewer_run_binding") } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ...extra,
    };
}
const isResult = (v) => typeof v === "object" && v !== null && "content" in v;
const runDeps = (ctx, extra = {}) => ({
    ...(ctx.deps.runner !== undefined ? { runner: ctx.deps.runner } : {}),
    ...(ctx.deps.riskAssessor !== undefined ? { riskAssessor: ctx.deps.riskAssessor } : {}),
    ...(ctx.deps.concurrency !== undefined ? { concurrency: ctx.deps.concurrency } : {}),
    ...extra,
});
/**
 * review_capture / review_capture_group: admit the one reviewer batch status (or the run's forecast) issued, and stop. The
 * given bindings must be exactly the current collect set; a group is never partially selected or reordered.
 */
async function captureBatch(a, ctx, given, single) {
    const input = runInput(a, ctx, { lineageId: str(a, "lineage_id") });
    if (isResult(input))
        return input;
    const cwd = input.cwd;
    const lineage = str(a, "lineage_id");
    const repo = resolveRepository(cwd);
    const rec = readState(repo.commonDir, lineage);
    let expected;
    const status = reviewStatus(cwd, { target: input.target, projection: input.projection });
    const next = status.next_transition;
    if (status.authority?.lineage_id === lineage && next.kind === "collect") {
        const bindings = next.collect.inputs.map((i) => i.arguments.find((x) => x.name === "binding")?.value);
        if (bindings.some((b) => b === undefined))
            return fail("not_a_reviewer_collect", "the current collect needs no reviewer batch here; follow review_status or use review_run");
        expected = bindings;
    }
    else if (rec.state === "correction_required" || rec.state === "validating") {
        // The corrected candidate has another identity than the lineage target: status cannot route it, the lineage record does.
        for (const g of given) {
            const d = decodeBinding(g);
            if (!d.ok || (d.binding.role !== "correction" && d.binding.role !== "validator") || d.binding.lineage_id !== lineage || d.binding.revision !== rec.revision) {
                return fail("binding_mismatch", "the binding is not the correction validator binding of this lineage's current revision; take it from the review_run forecast");
            }
        }
        expected = given;
    }
    else {
        return fail("no_collect_pending", `lineage ${lineage} has no reviewer batch to capture (state ${rec.state}); call review_status`);
    }
    if (single && expected.length > 1)
        return fail("group_required", "the current collect issued several reviewer slots; use review_capture_group with every binding in order", { expected_count: expected.length });
    if (expected.length !== given.length || expected.some((b, i) => b !== given[i])) {
        return fail("binding_mismatch", "the bindings are not exactly the current collect set, in order", { expected_bindings: expected });
    }
    return runResult(await runReview(input, runDeps(ctx, { stopAfterBatch: true })));
}
// ---- tools ----
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const TOOLS = [
    {
        name: "review_assess",
        description: "Read-only: freeze the candidate in a private index and classify its risk (low/medium/high), with the reasons and changed paths. Starts nothing, creates no review lineage and writes nothing; it never touches the worktree.",
        inputSchema: object({ ...TARGET_PROPS }),
        annotations: readOnly,
        async run(a, ctx) {
            const t = targetOf(a);
            if (typeof t === "string")
                return invalid(t);
            const r = assessCandidate(cwdOf(a, ctx), snapshotTargetFor({ target: t.target, projection: t.projection }));
            if (r.status === "not_due")
                return ok({ outcome: "not_due", reason: r.reason, review_due: false, kind: r.kind, projection: r.projection });
            return ok({
                outcome: "assessed", risk_level: r.risk, review_due: r.reviewDue, reasons: r.reasons, evidence: r.evidence.slice(0, 50), ...(r.focusLens !== undefined ? { focus_lens: r.focusLens } : {}),
                kind: r.kind, projection: r.projection, target_identity: r.targetIdentity, base_tree: r.baseTree, candidate_tree: r.candidateTree,
                changed_lines: r.changedLines, changed_paths: r.changedPaths.slice(0, MAX_PATHS), changed_paths_total: r.changedPaths.length, changed_paths_truncated: r.changedPaths.length > MAX_PATHS,
            });
        },
    },
    {
        name: "review_inspect",
        description: "Read-only: list the review authority of this repository (lineages with state, risk, target identity, revision) and the RDD mode. Unreadable lineages are reported, never hidden.",
        inputSchema: object({ cwd: CWD, limit: { type: "integer", minimum: 1, maximum: 100, description: "Lineages to list (default 25)." } }),
        annotations: readOnly,
        async run(a, ctx) {
            const cwd = cwdOf(a, ctx);
            const repo = resolveRepository(cwd);
            const listing = listLineages(repo.commonDir, { limit: typeof a.limit === "number" ? a.limit : 25 });
            const lineages = [];
            const unreadable = [];
            for (const id of listing.lineages) {
                try {
                    const r = readState(repo.commonDir, id);
                    lineages.push({ lineage_id: id, state: r.state, risk_level: r.risk_level, projection: r.projection, target_identity: r.target_identity, revision: r.revision, burned: r.burned === true, updated_at: r.updated_at });
                }
                catch (e) {
                    unreadable.push({ lineage_id: id, error: e.name });
                }
            }
            const mode = readReviewMode(cwd, ctx.deps.modeOptions);
            return ok({ rdd_mode: { effective: mode.effective, source: mode.source, problems: mode.problems.slice(0, 10) }, lineages, unreadable, truncated: listing.truncated });
        },
    },
    {
        name: "review_start",
        description: "Start a review of the candidate. It ALWAYS relays consent: a medium/high-risk candidate returns the consent envelope untouched (show it to the human losslessly) and creates nothing; only review_answer_consent, with the human's explicit answer, can grant or decline. A low-risk candidate is approved at once and returns its one-shot acknowledgement. Refuses to open a second lineage while one waits for its correction.",
        inputSchema: object({
            ...TARGET_PROPS, ...LENS_PROPS,
            contract: { type: "string", const: REVIEW_CONTRACT },
            target_identity: { type: "string", pattern: SHA_PATTERN, description: "When given (status passes it), the candidate must still have exactly this identity (binding_drift otherwise)." },
        }),
        annotations: writes,
        run: (a, ctx) => guardedStart(a, ctx, "relay", str(a, "target_identity")),
    },
    {
        name: "review_status",
        description: "Read-only: the review status of the candidate. Follow ONLY the next_transition it returns (its `command` names the tool to call); never infer a step. Pass `acknowledgement` (from start/capture) to be offered the approval acknowledgement. Optional `detail`: \"full\" (default) or \"concise\" (smaller: drops only the projection detail and per-slot artifact subjects; keeps every id, binding, next_transition, forecast and repair)." + NOTE,
        inputSchema: object({
            ...TARGET_PROPS,
            detail: DETAIL,
            acknowledgement: object({
                lineage_id: { type: "string", pattern: LINEAGE_PATTERN }, target_identity: { type: "string", pattern: SHA_PATTERN },
                expected_revision: { type: "string", minLength: 1, maxLength: 200 }, token: { type: "string", minLength: 1, maxLength: 200 },
            }, ["lineage_id", "target_identity", "expected_revision", "token"]),
        }),
        annotations: readOnly,
        async run(a, ctx) {
            const t = targetOf(a);
            if (typeof t === "string")
                return invalid(t);
            const ack = a.acknowledgement;
            const status = reviewStatus(cwdOf(a, ctx), { target: t.target, projection: t.projection, ...(ack !== undefined ? { acknowledgement: ack } : {}) });
            return ok(str(a, "detail") === "concise" ? conciseStatus(status) : status);
        },
    },
    {
        name: "review_answer_consent",
        description: "Record the HUMAN's explicit answer to a consent question (granted or declined) for the exact candidate it was asked for. Call it only with the answer the human gave, never on your own judgment and never to 'relay'. target_identity must be the one in the consent envelope; if the candidate moved, nothing is recorded (binding_drift).",
        inputSchema: object({
            ...TARGET_PROPS, ...LENS_PROPS,
            contract: { type: "string", const: REVIEW_CONTRACT },
            target_identity: { type: "string", pattern: SHA_PATTERN, description: "target_identity of the consent envelope." },
            consent: { type: "string", enum: ["granted", "declined"], description: "The human's explicit answer." },
            consent_binding: { type: "string", pattern: SHA_PATTERN, description: "consent-binding of the chosen consent invocation: binds the answer to the target and the lens selection the human saw." },
        }, ["target_identity", "consent", "consent_binding"]),
        annotations: writes,
        async run(a, ctx) {
            const lenses = a.lenses;
            const asked = consentBinding(str(a, "target_identity"), lenses !== undefined ? { names: lenses, reason: str(a, "lenses_reason") ?? "" } : undefined);
            if (asked !== str(a, "consent_binding")) {
                return fail("binding_drift", "the answer is not bound to this candidate and lens selection: pass the arguments of the chosen consent invocation exactly as given", { field: "consent_binding" });
            }
            return guardedStart(a, ctx, str(a, "consent"), str(a, "target_identity"));
        },
    },
    {
        name: "review_capture",
        description: "Admit exactly one reviewer slot issued by review_status or a review_run forecast: pass its exact binding. First returns a forecast; call again with reviewer_run_acknowledged and its reviewer_run_binding to run the reviewer. Stops after the batch (never acknowledges or follows another transition); the result may carry the one-shot approval acknowledgement.",
        inputSchema: object({ cwd: CWD, ...TARGET_PROPS, lineage_id: { type: "string", pattern: LINEAGE_PATTERN }, binding: { type: "string", minLength: 1, maxLength: 8192 }, ...RUN_PROPS }, ["lineage_id", "binding"]),
        annotations: writes,
        run: (a, ctx) => captureBatch(a, ctx, [str(a, "binding")], true),
    },
    {
        name: "review_capture_group",
        description: "Admit one complete reviewer group: pass lineage_id and ALL bindings of the current collect, in order, never partial. First returns a forecast; call again with reviewer_run_acknowledged and its reviewer_run_binding. Reviewers run concurrently (bounded) and are admitted in order; stops after the batch.",
        inputSchema: object({ cwd: CWD, ...TARGET_PROPS, lineage_id: { type: "string", pattern: LINEAGE_PATTERN }, bindings: { type: "array", items: { type: "string", minLength: 1, maxLength: 8192 }, minItems: 1, maxItems: 8, uniqueItems: true }, ...RUN_PROPS }, ["lineage_id", "bindings"]),
        annotations: writes,
        run: (a, ctx) => captureBatch(a, ctx, a.bindings, false),
    },
    {
        name: "review_acknowledge_approved",
        description: "Acknowledge an approved review once (burns the lineage, writes the receipt). Needs the one-shot token returned when the review was approved, the exact revision and target identity.",
        inputSchema: object({
            cwd: CWD, lineage_id: { type: "string", pattern: LINEAGE_PATTERN }, target_identity: { type: "string", pattern: SHA_PATTERN },
            expected_revision: { type: "string", minLength: 1, maxLength: 200 }, token: { type: "string", minLength: 1, maxLength: 200 },
        }, ["lineage_id", "target_identity", "expected_revision", "token"]),
        annotations: writes,
        async run(a, ctx) {
            const repo = resolveRepository(cwdOf(a, ctx));
            try {
                const res = await acknowledgeApproved(repo.commonDir, { lineage: str(a, "lineage_id"), target: str(a, "target_identity"), expectedRevision: str(a, "expected_revision"), token: str(a, "token") });
                return ok(encodeAckEnvelope(res));
            }
            catch (e) {
                if (e instanceof AckRefusedError)
                    return fail(e.code, e.message);
                throw e;
            }
        },
    },
    {
        name: "review_complete",
        description: "Settle a fully reviewed lineage that status offers as `review.validate` (all lens results admitted). Needs the exact expected_revision from status.",
        inputSchema: object({ cwd: CWD, lineage_id: { type: "string", pattern: LINEAGE_PATTERN }, expected_revision: { type: "string", minLength: 1, maxLength: 200 } }, ["lineage_id", "expected_revision"]),
        annotations: writes,
        async run(a, ctx) {
            const repo = resolveRepository(cwdOf(a, ctx));
            const out = await completeReview(repo.commonDir, str(a, "lineage_id"), str(a, "expected_revision"));
            if (!out.ok)
                return fail(out.code, out.message, { ...(out.errors !== undefined ? { errors: out.errors.slice(0, 20) } : {}), ...(out.currentRevision !== undefined ? { current_revision: out.currentRevision } : {}) });
            return ok(encodeCaptureEnvelope(out));
        },
    },
    {
        name: "review_run",
        description: "Drive one review end to end by following status transitions: start, reviewers, capture, acknowledge. It returns a typed outcome: closed, not-due, consent-required (relay the envelope to the human; consent is never answered here), input-required (a correction is needed), forecast (reviewers cost money: call again with reviewer_run_acknowledged and the forecast's reviewer_run_binding), stopped, binding-drift, transition-limit or cancelled. Resume a consented or corrected review with lineage_id.",
        inputSchema: object({ ...TARGET_PROPS, ...LENS_PROPS, lineage_id: { type: "string", pattern: LINEAGE_PATTERN }, ...RUN_PROPS }),
        annotations: writes,
        async run(a, ctx) {
            const input = runInput(a, ctx);
            if (isResult(input))
                return input;
            return runResult(await runReview(input, runDeps(ctx)));
        },
    },
];
export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const COMMA_LISTS = new Set(["lenses"]);
/**
 * Status transitions carry every argument as a string. Before validation a string is coerced to the type its property declares:
 * boolean ("true"/"false"), integer (digits), array (a JSON array, or a comma list for `lenses`). Anything else is left as is and
 * fails validation.
 */
export function coerceArguments(schema, args) {
    if (typeof args !== "object" || args === null || Array.isArray(args))
        return args;
    // No prototype: a wire key such as "__proto__" (an own property after JSON.parse) must stay an ordinary, validated key.
    const out = Object.create(null);
    for (const [k, v] of Object.entries(args)) {
        const prop = Object.prototype.hasOwnProperty.call(schema.properties ?? {}, k) ? schema.properties[k] : undefined;
        out[k] = v;
        if (prop === undefined || typeof v !== "string")
            continue;
        if (prop.type === "boolean" && (v === "true" || v === "false"))
            out[k] = v === "true";
        else if (prop.type === "integer" && /^-?\d{1,15}$/.test(v))
            out[k] = Number(v);
        else if (prop.type === "array") {
            if (v.startsWith("[")) {
                try {
                    out[k] = JSON.parse(v);
                }
                catch {
                    /* left as a string: validation reports it */
                }
            }
            else if (COMMA_LISTS.has(k))
                out[k] = v.split(",").map((x) => x.trim()).filter((x) => x !== "");
        }
    }
    return out;
}
/** Validates the arguments against the tool's schema, then runs it. Never throws: failures are typed tool errors. */
export async function callTool(tool, rawArgs, ctx) {
    const args = coerceArguments(tool.inputSchema, rawArgs ?? {});
    const errors = validateSchema(tool.inputSchema, args);
    if (errors.length > 0)
        return fail("invalid_input", `invalid arguments for ${tool.name}`, { errors });
    try {
        return await tool.run((args ?? {}), ctx);
    }
    catch (e) {
        return errorResult(e);
    }
}
// The registry must be exactly the names the invocation strings use (consent.ts).
if (TOOLS.map((t) => t.name).join() !== [...REVIEW_TOOL_NAMES].join())
    throw new Error("review tool registry differs from REVIEW_TOOL_NAMES");
