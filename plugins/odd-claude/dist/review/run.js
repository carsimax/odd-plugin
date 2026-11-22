// Run loop / relay (U12): drives ONE ordinary review end to end over the verified modules.
//
// Routing comes only from `reviewStatus` (status.ts): its `next_transition` is followed, never invented. The loop starts
// a fresh target (start.ts), runs the reviewer slots status offers (runner.ts), admits their outputs through capture.ts
// and acknowledges an approval (ack.ts). It is bounded (`MAX_TRANSITIONS`) and ends in a typed outcome:
//   closed | not-due | consent-required | input-required | forecast | stopped | blocked | binding-drift |
//   transition-limit | cancelled.
//
// Invariants:
//  - Consent is never answered here: a consent envelope is returned untouched, a declined candidate is a typed stop.
//    The user's answer is a direct START call; the run resumes afterwards (by `lineageId`, or by the candidate).
//  - Reviewers cost money: the first time a reviewer batch is due the run returns a `forecast` and runs nothing. It runs
//    that batch only when called again with `reviewerRunAcknowledged: true` AND the `reviewerRunBinding` of the forecast.
//  - A group runs concurrently (bounded) but is admitted strictly in provider order. The candidate is re-frozen and the
//    slot bindings re-verified before the first admission; a moved candidate is `binding-drift` and nothing is captured.
//  - A failed or malformed reviewer output never reaches acknowledgement: the run stops with a typed `blocked`, re-reads
//    status once for the report and never replays a slot. Slots admitted before the failure stay admitted (resumable).
//  - model/effort are validated here (`validateReviewerOptions`), before anything starts: the runner would ignore an
//    unknown model silently.
//
// Resume after a correction is the one place status cannot route: the corrected candidate has another identity than
// the lineage's target, so `reviewStatus` would see a fresh target. With a `lineageId` whose state is correction_required
// or validating, this module routes from the lineage record directly. From correction_required the forecast and the
// acknowledged run write NOTHING until the validator answered: the attempt is recorded in the same transition as the
// validator result (`captureCorrectionResult`), so a forecast, a refined correction or a runner failure never spends the
// single correction attempt. Once the validator passed, the lineage's candidate IS the corrected one (state.ts `approve`)
// and the acknowledgement/receipt bind that identity; the reviewed original never counts as consumed.
// The corrected snapshot must keep the lineage's projection, and its base must be the reviewed base OR the reviewed
// candidate (upstream compact.go: commit the reviewed work, then correct in the worktree); any other base is binding-drift
// (field `base`), nothing written. After a correction on the candidate-as-base shape the lineage keeps its original base_tree.
// Without a `lineageId`, a candidate that is the correction of a lineage still in correction_required/validating is
// reported (`blocked correction_lineage_pending`, with that lineage_id) instead of silently opening a new review; an unreadable (corrupt/forged) correction lineage with the same base and
// projection is reported too (`blocked authority_error` with that lineage_id), never skipped.
//
// `startReview` called directly (not through `runReview`) while a lineage is in correction_required/validating would open a
// second lineage for the corrected candidate (its identity differs from the lineage's target, so START sees a fresh target).
// The MCP start tools (src/mcp/tools.ts) therefore call the exported `pendingCorrectionLineage` first and return the pending
// lineage instead of starting; the lineage-id-less run reports `correction_lineage_pending` for the same case.
//
// Cancellation: an `AbortSignal` is checked between steps and raced against a running batch. The runner exposes no
// abort, so a child already spawned finishes (or times out) on its own bound and its output is discarded; but once the
// run is aborted, or any slot failed, or the batch returned, no QUEUED reviewer is started, and nothing is captured or
// acknowledged after an abort.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { domainHash } from "./canonical.js";
import { acknowledgeApproved, AckRefusedError } from "./ack.js";
import { manifestFor, refuterRequestHash, targetedValidationRequestHash, treeDiffPaths } from "./artifact.js";
import { captureCorrectionResult, captureLensResult, captureRefuterResult, captureValidatorResult, completeReview, planCorrection, previewCorrectionValidation, } from "./capture.js";
import { encodeAckEnvelope, encodeBinding, encodeCaptureEnvelope, forecastFor, isTerminalStop, REASON_DESCRIPTIONS, verifyBinding } from "./contract.js";
import { StoreLockContended, StoreLockError } from "./lock.js";
import { assessRisk } from "./risk.js";
import { buildReviewerPrompt, parseReviewerOutput, runReviewer } from "./runner.js";
import { digestPaths, freezeSnapshot, resolveRepository, SnapshotError, snapshotIdentity } from "./snapshot.js";
import { readProfile } from "../lib/profiles.js";
import { reviewerRoute } from "./reviewer-model.js";
import { startReview } from "./start.js";
import { blockingFindingIds } from "./state.js";
import { reviewStatus } from "./status.js";
import { listLineages, readState, StoreAlreadyExistsError, StoreConcurrentUpdateError, StoreCorruptError, StoreInvalidLineageError, StoreInvalidRecordError, StoreIoError, StoreNotFoundError, storeRootFor, StoreTransitionRefusedError, } from "./store.js";
/** Bound of the status-driven loop (same as the reference relay). */
const MAX_RAW_STATE_BYTES = 1 << 20;
/**
 * Secure bounded read of a state file for the lenient pending-correction look. Returns the record; undefined for a content
 * problem that upstream skips (absent, oversized regular file, not JSON, not an object); "unsafe" for a symlink, FIFO,
 * directory, hardlink, open error or read error (the lineage is corrupt or unreadable: fail closed).
 */
function readRawState(path) {
    let fd;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    catch (e) {
        return e.code === "ENOENT" ? undefined : "unsafe";
    }
    try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.nlink > 1)
            return "unsafe";
        if (st.size > MAX_RAW_STATE_BYTES)
            return undefined;
        const buf = Buffer.alloc(st.size);
        let got = 0;
        while (got < buf.length) {
            let n;
            try {
                n = readSync(fd, buf, got, buf.length - got, null);
            }
            catch {
                return "unsafe";
            }
            if (n === 0)
                break;
            got += n;
        }
        try {
            const parsed = JSON.parse(buf.subarray(0, got).toString("utf8"));
            return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
        }
        catch {
            return undefined;
        }
    }
    catch {
        return "unsafe";
    }
    finally {
        closeSync(fd);
    }
}
export const MAX_TRANSITIONS = 24;
/** Reviewers of one group running at the same time. */
export const DEFAULT_CONCURRENCY = 2;
export const REVIEWER_MODELS = ["fable", "opus", "sonnet", "haiku"];
export const REVIEWER_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/**
 * Error text for a user-supplied model/effort the runner cannot honour, or null when valid. Stricter than the runner on
 * purpose (it silently ignores what it does not know): only a known family, an effort only with a family that has levels.
 */
export function validateReviewerOptions(opts) {
    const { model, effort } = opts;
    if (model !== undefined && (typeof model !== "string" || !REVIEWER_MODELS.includes(model))) {
        return `model must be one of ${REVIEWER_MODELS.join(", ")}`;
    }
    if (effort !== undefined && effort !== "") {
        if (typeof effort !== "string" || !REVIEWER_EFFORTS.includes(effort))
            return `effort must be one of ${REVIEWER_EFFORTS.join(", ")}`;
        if (model === undefined)
            return "effort needs a model";
        if (model === "haiku")
            return "haiku has no effort levels";
    }
    return null;
}
const isStoreError = (e) => e instanceof StoreInvalidLineageError || e instanceof StoreNotFoundError || e instanceof StoreAlreadyExistsError || e instanceof StoreCorruptError ||
    e instanceof StoreConcurrentUpdateError || e instanceof StoreTransitionRefusedError || e instanceof StoreInvalidRecordError || e instanceof StoreIoError ||
    e instanceof StoreLockContended || e instanceof StoreLockError;
/**
 * Starts tasks in index order, at most `limit` at a time; every returned promise settles (tasks must not reject).
 * `skip` is asked at the moment a queued task would start: a defined answer is its result and the task never runs.
 */
function boundedAll(count, limit, task, skip) {
    let active = 0;
    const queue = [];
    const acquire = () => active < limit
        ? (active++, Promise.resolve())
        : new Promise((resolve) => queue.push(() => { active++; resolve(); }));
    const release = () => {
        active--;
        queue.shift()?.();
    };
    return Array.from({ length: count }, (_, i) => acquire().then(() => skip() ?? task(i)).finally(release));
}
function snapshotTargetOf(input) {
    const t = input.target ?? { kind: "current-changes" };
    if (t.kind === "current-changes")
        return { kind: "current-changes", projection: input.projection ?? "workspace" };
    return t.committedOnly === true ? { kind: "base-diff", baseRef: t.baseRef } : { kind: "base-workspace-overlay", baseRef: t.baseRef };
}
const slotView = (s) => ({ role: s.role, ...(s.lens !== undefined ? { lens: s.lens } : {}), binding: s.binding });
/**
 * Best-effort look at an unreadable state file (read only, same discipline as the store's secure reader: O_NOFOLLOW |
 * O_NONBLOCK, regular single-link file checked on the open fd, size cap). true: the raw record claims a pending
 * correction on this base/projection, or the file is unsafe (symlink/FIFO/directory/hardlink or an IO error: fail
 * closed); otherwise skipped (absent, oversized, not JSON: content errors upstream skips too, or another candidate).
 */
function rawCorrectionMatches(commonDir, id, baseTree, projection) {
    const raw = readRawState(join(storeRootFor(commonDir), id, "review-state.json"));
    if (raw === "unsafe")
        return true;
    if (raw === undefined)
        return false;
    return (raw.state === "correction_required" || raw.state === "validating") && (raw.base_tree === baseTree || raw.candidate_tree === baseTree) && raw.projection === projection;
}
/**
 * A lineage still waiting for its correction whose reviewed base is this candidate's base (newest first). A lineage
 * the store cannot read (corrupt or forged) fails closed: when its raw record says correction_required/validating
 * with this base and projection it is reported as `unreadable`, never skipped (a new review would hide it).
 * Read-only. Used by `runReview` and by the MCP start tools, so a direct START cannot duplicate a lineage.
 */
export function pendingCorrectionLineage(cwd, target) {
    const frozen = freezeSnapshot(cwd, target);
    if (frozen.status !== "frozen")
        return undefined;
    const commonDir = frozen.repository.commonDir;
    let found;
    let unreadable;
    for (const id of listLineages(commonDir).lineages) {
        let rec;
        try {
            rec = readState(commonDir, id);
        }
        catch {
            if (unreadable === undefined && rawCorrectionMatches(commonDir, id, frozen.snapshot.baseTree, frozen.snapshot.projection))
                unreadable = id;
            continue;
        }
        if (rec.state !== "correction_required" && rec.state !== "validating")
            continue;
        if ((rec.base_tree !== frozen.snapshot.baseTree && rec.candidate_tree !== frozen.snapshot.baseTree) || rec.projection !== frozen.snapshot.projection)
            continue;
        if (found === undefined || rec.updated_at > found.updated_at)
            found = rec;
    }
    if (unreadable !== undefined)
        return { unreadable };
    return found === undefined ? undefined : { rec: found };
}
/** The snapshot target a run/start input freezes (same mapping `runReview` uses). */
export const snapshotTargetFor = (input) => snapshotTargetOf(input);
/** Drives one review. Never throws for typed failures; see the module header for the outcomes. */
export async function runReview(input, deps = {}) {
    let lineage = input.lineageId;
    let target;
    let transitions = 0;
    let ack;
    let batches = 0;
    const maxTransitions = deps.maxTransitions ?? MAX_TRANSITIONS;
    const aborted = () => input.signal?.aborted === true;
    const finish = (body) => ({
        ...body,
        ...(lineage !== undefined ? { lineage_id: lineage } : {}),
        ...(target !== undefined ? { target_identity: target } : {}),
        transitions,
    });
    const blocked = (code, message, extra = {}) => finish({ outcome: "blocked", code, message, ...extra });
    const drift = (field, message) => finish({ outcome: "binding-drift", field, message });
    const cancelled = () => finish({ outcome: "cancelled" });
    const stopped = (reason) => finish({ outcome: "stopped", reason_code: reason, terminal: isTerminalStop(reason), description: REASON_DESCRIPTIONS[reason] });
    const optionsError = validateReviewerOptions(input);
    if (optionsError !== null)
        return blocked("invalid_option", optionsError);
    if (aborted())
        return cancelled();
    const snapTarget = snapshotTargetOf(input);
    const startTarget = input.target ?? { kind: "current-changes" };
    const statusOf = () => reviewStatus(input.cwd, { target: startTarget, projection: input.projection, acknowledgement: ack });
    try {
        const repo = resolveRepository(input.cwd);
        const commonDir = repo.commonDir;
        const run = deps.runner ?? runReviewer;
        const runnerOpts = {
            ...(input.claudePath !== undefined ? { claudePath: input.claudePath } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.effort !== undefined ? { effort: input.effort } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        };
        // S3: without an explicit caller model every reviewer child follows the active profile route of its role. The profile is
        // read once per run (readProfile never throws: unreadable state is the balanced default).
        const profile = input.model === undefined ? readProfile(deps.profileState) : undefined;
        const optionsFor = (slot) => profile === undefined ? runnerOpts : { ...runnerOpts, ...reviewerRoute(profile, slot.role, slot.lens) };
        /** Whether the candidate is exactly `identity` now (the frozen world the slots were issued for). */
        const currentIdentity = () => {
            const frozen = freezeSnapshot(input.cwd, snapTarget);
            return frozen.status === "frozen" ? frozen.snapshot.identity : undefined;
        };
        const rememberAck = (last) => {
            if (last.ackToken !== undefined) {
                ack = { lineage_id: last.record.lineage_id, target_identity: last.record.target_identity, expected_revision: last.revision, token: last.ackToken };
            }
        };
        /** One batch of reviewer slots: forecast gate, prompts, bounded concurrent runs, ordered admission. */
        const runBatch = async (slots, ctx) => {
            const out = (outcome) => ({ done: false, outcome });
            // model/effort are part of what the user authorized: a forecast for haiku never runs opus/max.
            const batchBinding = domainHash("run-reviewer-batch", 2, {
                lineage_id: ctx.lineage,
                bindings: slots.map((s) => s.binding),
                model: input.model ?? "",
                effort: input.effort ?? "",
            });
            if (input.reviewerRunAcknowledged !== true || batches > 0) {
                return out(finish({
                    outcome: "forecast",
                    forecast: ctx.forecast,
                    reviewer_run_binding: batchBinding,
                    reviewers: slots.map(slotView),
                    ...(input.model !== undefined ? { model: input.model } : {}),
                    ...(input.effort !== undefined ? { effort: input.effort } : {}),
                }));
            }
            if (input.reviewerRunBinding === undefined)
                return out(blocked("invalid_input", "reviewerRunAcknowledged needs the reviewerRunBinding of the forecast"));
            if (input.reviewerRunBinding !== batchBinding)
                return out(drift("forecast", "the acknowledged forecast is not the reviewer batch that is due now"));
            batches++;
            const prompts = [];
            for (const slot of slots) {
                const built = buildReviewerPrompt({ commonDir, role: slot.role, ...(slot.lens !== undefined ? { lens: slot.lens } : {}), ...slot.prompt });
                if (!built.ok)
                    return out(blocked("reviewer_prompt_unavailable", built.message, { detail: built.code, slot: { role: slot.role, ...(slot.lens !== undefined ? { lens: slot.lens } : {}) } }));
                prompts.push(built.prompt);
            }
            const failure = (slot, code, message, detail, errors) => {
                let after;
                try {
                    after = ctx.recheck();
                }
                catch {
                    after = undefined;
                }
                return out(blocked(code, message, {
                    slot: { role: slot.role, ...(slot.lens !== undefined ? { lens: slot.lens } : {}) },
                    ...(detail !== undefined ? { detail } : {}),
                    ...(errors !== undefined ? { errors } : {}),
                    ...(after !== undefined ? { status_after: after } : {}),
                }));
            };
            const limit = Math.max(1, Math.floor(deps.concurrency ?? DEFAULT_CONCURRENCY));
            // No queued reviewer starts once the run is aborted, a slot failed, or the batch returned (`halted`).
            let halted = false;
            const notStarted = { ok: false, code: "nonzero_exit", message: "the reviewer was not started: the run stopped first", elapsedMs: 0 };
            const results = boundedAll(slots.length, limit, async (i) => {
                try {
                    const out = await run(prompts[i], optionsFor(slots[i]));
                    if (!out.ok)
                        halted = true;
                    return out;
                }
                catch (e) {
                    halted = true;
                    return { ok: false, code: "claude_unavailable", message: `the reviewer runner failed: ${e.message}`, elapsedMs: 0 };
                }
            }, () => (halted || aborted() ? notStarted : undefined));
            let onAbort;
            const abortSignal = new Promise((resolve) => {
                if (input.signal === undefined)
                    return;
                if (input.signal.aborted)
                    return resolve("aborted");
                onAbort = () => resolve("aborted");
                input.signal.addEventListener("abort", onAbort, { once: true });
            });
            try {
                let revision = ctx.revision;
                let last;
                for (let i = 0; i < slots.length; i++) {
                    const slot = slots[i];
                    const got = await Promise.race([results[i], abortSignal]);
                    if (got === "aborted" || aborted())
                        return out(cancelled());
                    if (!got.ok)
                        return failure(slot, "reviewer_failed", got.message, got.code);
                    // The candidate and the slot bindings must still be the world the slots were issued for.
                    if (currentIdentity() !== ctx.expectedIdentity)
                        return out(drift("target", "the candidate changed while the reviewers ran; nothing was captured"));
                    const rec = readState(commonDir, ctx.lineage);
                    if (i === 0) {
                        for (const s of slots) {
                            const v = verifyBinding(s.binding, { targetIdentity: ctx.expectedIdentity, lineage: rec, commonDir });
                            if (!v.ok)
                                return out(v.code === "binding_drift" ? drift(v.field ?? "revision", v.message) : blocked("invalid_binding", v.message));
                        }
                    }
                    else if (rec.revision !== revision) {
                        return out(drift("revision", "the review changed while the reviewers ran; nothing more was captured"));
                    }
                    const parsed = parseReviewerOutput(got.stdout, slot.role, slot.echo);
                    if (!parsed.ok)
                        return failure(slot, "reviewer_output_invalid", parsed.message, parsed.code, parsed.errors);
                    deps.hooks?.beforeCapture?.();
                    if (aborted())
                        return out(cancelled());
                    const captured = await slot.capture(revision, parsed.value);
                    if (!captured.ok)
                        return failure(slot, "capture_refused", captured.message, captured.code, captured.errors);
                    revision = captured.revision;
                    last = captured;
                }
                return { done: true, last: last };
            }
            finally {
                halted = true;
                if (onAbort !== undefined)
                    input.signal?.removeEventListener("abort", onAbort);
            }
        };
        const acknowledge = async (lineageId, targetIdentity, revision, token) => {
            deps.hooks?.beforeAcknowledge?.();
            if (aborted())
                return cancelled();
            const res = await acknowledgeApproved(commonDir, { lineage: lineageId, target: targetIdentity, expectedRevision: revision, token });
            target = res.record.target_identity;
            return finish({ outcome: "closed", risk_level: res.record.risk_level, acknowledgement: encodeAckEnvelope(res) });
        };
        /**
         * Resume after the correction: the candidate is no longer the lineage's target, so the lineage record routes.
         * correction_required: preview (no write), then ONE transition that records the attempt with the validator result;
         * validating (an older run opened it): run the targeted validator.
         */
        const afterCorrection = async (rec) => {
            lineage = rec.lineage_id;
            target = rec.target_identity;
            if (rec.state === "escalated" || rec.state === "invalidated")
                return stopped(rec.state);
            const frozen = freezeSnapshot(input.cwd, snapTarget);
            if (frozen.status === "empty")
                return blocked("correction_unavailable", "the corrected candidate has no changes");
            const snap = frozen.snapshot;
            // the corrected snapshot must be the same kind of candidate as the reviewed one: same projection and the same base
            if (snap.projection !== rec.projection)
                return drift("projection", `the corrected candidate is a ${snap.projection} snapshot, the lineage reviewed a ${rec.projection} one`);
            // upstream accepts a correction whose base is the reviewed base, or the reviewed candidate itself (the reviewed work was
            // committed, then corrected in the worktree); any other base is drift. The lineage keeps its original base_tree.
            if (snap.baseTree !== rec.base_tree && snap.baseTree !== rec.candidate_tree)
                return drift("base", "the corrected candidate is based on neither the reviewed base nor the reviewed candidate");
            // Reference (compact.go BuildCorrectedCandidate): the corrected candidate is the INITIAL snapshot's base plus the corrected
            // tree. When the worktree snapshot used another base (the reviewed candidate), its identity is recomputed from the
            // lineage's base_tree so the adopted identity, the receipt's base/candidate trees and the validator echo agree.
            let correctedIdentity = snap.identity;
            if (snap.baseTree !== rec.base_tree) {
                try {
                    correctedIdentity = snapshotIdentity(snap.kind, snap.projection, rec.base_tree, snap.candidateTree, digestPaths(treeDiffPaths(commonDir, rec.base_tree, snap.candidateTree)));
                }
                catch (e) {
                    if (e instanceof SnapshotError || e instanceof RangeError)
                        return blocked("correction_unavailable", `the corrected candidate cannot be compared with the reviewed base: ${e.message}`);
                    throw e;
                }
            }
            const corrected = { candidateTree: snap.candidateTree, identity: correctedIdentity };
            const lineageId = rec.lineage_id;
            let validating;
            let capture;
            let bindingRole;
            if (rec.state === "correction_required") {
                const preview = previewCorrectionValidation(repo, lineageId, rec.revision, corrected);
                if (!preview.ok)
                    return blocked("correction_refused", preview.message, { detail: preview.code, ...(preview.errors !== undefined ? { errors: preview.errors } : {}) });
                validating = preview.record;
                bindingRole = "correction";
                capture = (revision, value) => captureCorrectionResult(repo, lineageId, revision, corrected, { result: value });
            }
            else if (rec.state === "validating") {
                if (correctedIdentity !== rec.correction_target_identity)
                    return drift("target", "the candidate is not the corrected candidate under validation");
                validating = rec;
                bindingRole = "validator";
                capture = (revision, value) => captureValidatorResult(commonDir, lineageId, revision, { result: value, correctionCandidateTree: snap.candidateTree });
            }
            else {
                return drift("state", `the lineage is ${rec.state}, not awaiting a validator`);
            }
            const requestHash = targetedValidationRequestHash(validating);
            if (requestHash === null)
                return drift("state", "the lineage has no correction target to validate");
            const echo = { targeted_validation_request_hash: requestHash, correction_target_identity: correctedIdentity };
            const fixed = new Set(rec.fix_finding_ids);
            const slot = {
                role: "validator",
                binding: encodeBinding({ role: bindingRole, target_identity: snap.identity, lineage_id: lineageId, revision: rec.revision }),
                echo,
                prompt: {
                    subject: { ...echo, lineage_id: lineageId },
                    binding: echo,
                    baseTree: rec.candidate_tree,
                    candidateTree: snap.candidateTree,
                    paths: treeDiffPaths(commonDir, rec.candidate_tree, snap.candidateTree),
                    findings: rec.findings.filter((f) => fixed.has(f.id)),
                },
                capture,
            };
            const batch = await runBatch([slot], {
                lineage: lineageId,
                revision: rec.revision,
                expectedIdentity: snap.identity,
                forecast: forecastFor("collect", "validator_result_required"),
                recheck: () => {
                    const st = readState(commonDir, lineageId).state;
                    return { kind: "collect", reason_code: st === "validating" ? "validator_result_required" : st === "correction_required" ? "correction_required" : "corrupted_or_unverifiable_authority" };
                },
            });
            if (!batch.done)
                return batch.outcome;
            const last = batch.last;
            if (deps.stopAfterBatch === true)
                return finish({ outcome: "captured", capture: encodeCaptureEnvelope(last) });
            // the validator passed: the lineage's candidate is now the corrected one, and that identity is what is acknowledged
            if (last.next === "approved" && last.ackToken !== undefined)
                return acknowledge(lineageId, last.record.target_identity, last.revision, last.ackToken);
            if (last.next === "escalated")
                return stopped("escalated");
            return blocked("unexpected_state", `the validator left the lineage ${last.state}`);
        };
        // ---- resume by lineage ----
        if (lineage !== undefined) {
            if (input.requestContextPath !== undefined)
                return blocked("request_context_requires_fresh_review", "a request context is only accepted when a fresh review starts");
            let rec;
            try {
                rec = readState(commonDir, lineage);
            }
            catch (e) {
                if (e instanceof StoreNotFoundError || e instanceof StoreInvalidLineageError)
                    return blocked("unknown_lineage", `no review authority exists for lineage ${lineage}`);
                throw e;
            }
            if (currentIdentity() !== rec.target_identity) {
                if (rec.state === "correction_required" || rec.state === "validating")
                    return await afterCorrection(rec);
                target = rec.target_identity;
                return drift("target", "the candidate changed since this lineage was started");
            }
        }
        let started = false;
        for (let count = 0; count < maxTransitions; count++) {
            if (aborted())
                return cancelled();
            const env = statusOf();
            transitions++;
            const offered = env.authority?.lineage_id;
            if (offered !== undefined) {
                if (lineage !== undefined && lineage !== offered)
                    return drift("lineage", "status offered another lineage than the one this run follows");
                lineage = offered;
            }
            if (target !== undefined && target !== env.target_identity)
                return drift("target", "the candidate changed during the run");
            target = env.target_identity;
            const next = env.next_transition;
            if (input.requestContextPath !== undefined && !started && env.authority !== undefined) {
                return blocked("request_context_requires_fresh_review", "a review already exists for this candidate; a request context needs a fresh review");
            }
            if (next.kind === "stop")
                return next.reason_code === "not_due" ? finish({ outcome: "not-due" }) : stopped(next.reason_code);
            if (next.kind === "execute") {
                const exec = next.execute;
                if (exec.operation === "review.start") {
                    if (started || lineage !== undefined)
                        return blocked("unexpected_start", "status offered a start for a candidate that already has a lineage");
                    const pending = pendingCorrectionLineage(input.cwd, snapTarget);
                    if (pending !== undefined) {
                        if ("unreadable" in pending) {
                            lineage = pending.unreadable;
                            return blocked("authority_error", `lineage ${pending.unreadable} cannot be read safely; no new review is opened until it is repaired`, { detail: "StoreCorruptError" });
                        }
                        lineage = pending.rec.lineage_id;
                        return blocked("correction_lineage_pending", `lineage ${pending.rec.lineage_id} is waiting for its correction (${pending.rec.state}); resume it with lineageId instead of opening a new review`);
                    }
                    started = true;
                    const outcome = await startReview({
                        cwd: input.cwd,
                        target: startTarget,
                        ...(input.projection !== undefined ? { projection: input.projection } : {}),
                        ...(input.lenses !== undefined ? { lenses: input.lenses } : {}),
                        ...(input.lensesReason !== undefined ? { lensesReason: input.lensesReason } : {}),
                        consent: "relay",
                        ...(input.locale !== undefined ? { locale: input.locale } : {}),
                        ...(input.requestContextPath !== undefined ? { requestContext: input.requestContextPath } : {}),
                        riskAssessor: deps.riskAssessor ?? ((snapshot, repository) => assessRisk(snapshot, repository)),
                    });
                    switch (outcome.status) {
                        case "consent_required":
                            return finish({ outcome: "consent-required", envelope: outcome.envelope });
                        case "not_due":
                            return finish({ outcome: "not-due" });
                        case "declined":
                            return stopped("consent_declined");
                        case "refused":
                            return blocked("start_refused", outcome.message, { detail: outcome.code });
                        case "started": {
                            lineage = outcome.result.lineage_id;
                            target = outcome.result.target_identity;
                            if (outcome.result.acknowledgement !== undefined)
                                ack = { ...outcome.result.acknowledgement };
                            break;
                        }
                    }
                    continue;
                }
                if (exec.operation === "review.validate") {
                    const done = await completeReview(commonDir, exec.binding.lineage_id, exec.binding.revision);
                    if (!done.ok)
                        return blocked("capture_refused", done.message, { detail: done.code });
                    rememberAck(done);
                    continue;
                }
                if (exec.operation === "review.acknowledge-approved") {
                    if (ack === undefined)
                        return stopped("acknowledgement_token_unavailable");
                    return await acknowledge(exec.binding.lineage_id, exec.binding.target_identity, exec.binding.revision, ack.token);
                }
                return blocked("unsupported_transition", `status offered the unsupported operation ${exec.operation}`);
            }
            // collect
            const inputs = next.collect.inputs;
            if (lineage === undefined)
                return blocked("unsupported_transition", "status offered a collect without a lineage");
            const lineageId = lineage;
            if (inputs.some((i) => i.name === "corrected_candidate")) {
                const plan = planCorrection(commonDir, lineageId);
                if (!plan.ok)
                    return blocked("correction_unavailable", plan.message, { detail: plan.code });
                return finish({ outcome: "input-required", correction: plan });
            }
            if (inputs.some((i) => i.name === "validator_result"))
                return await afterCorrection(readState(commonDir, lineageId));
            const rec = readState(commonDir, lineageId);
            const manifest = manifestFor(commonDir, rec).paths;
            const slots = [];
            for (const inp of inputs) {
                const binding = inp.arguments.find((a) => a.name === "binding")?.value;
                if (binding === undefined)
                    return blocked("unsupported_transition", `status offered ${inp.name} without a binding`);
                if (inp.name.startsWith("reviewer_result_")) {
                    const subject = inp.artifact_subject;
                    const echo = { subject_hash: subject.subject_hash };
                    slots.push({
                        role: "lens",
                        lens: subject.lens,
                        binding,
                        echo,
                        prompt: { subject: subject, binding: echo, baseTree: inp.base_tree, candidateTree: inp.candidate_tree, paths: manifest },
                        capture: (revision, value) => captureLensResult(commonDir, lineageId, revision, { lens: subject.lens, subject, result: value }),
                    });
                }
                else if (inp.name === "refuter_result") {
                    const echo = { refuter_request_hash: refuterRequestHash(rec) };
                    const blocking = new Set(blockingFindingIds(rec));
                    slots.push({
                        role: "refuter",
                        binding,
                        echo,
                        prompt: {
                            subject: { ...echo, lineage_id: lineageId, target_identity: rec.target_identity },
                            binding: echo,
                            baseTree: rec.base_tree,
                            candidateTree: rec.candidate_tree,
                            paths: manifest,
                            findings: rec.findings.filter((f) => blocking.has(f.id)),
                        },
                        capture: (revision, value) => captureRefuterResult(commonDir, lineageId, revision, { result: value }),
                    });
                }
                else {
                    return blocked("unsupported_transition", `status offered the unsupported collect input ${inp.name}`);
                }
            }
            const batch = await runBatch(slots, {
                lineage: lineageId,
                revision: rec.revision,
                expectedIdentity: env.target_identity,
                forecast: env.forecast,
                recheck: () => {
                    const after = statusOf().next_transition;
                    return { kind: after.kind, reason_code: after.reason_code };
                },
            });
            if (!batch.done)
                return batch.outcome;
            if (deps.stopAfterBatch === true)
                return finish({ outcome: "captured", capture: encodeCaptureEnvelope(batch.last) });
            rememberAck(batch.last);
        }
        return finish({ outcome: "transition-limit", limit: maxTransitions });
    }
    catch (e) {
        if (e instanceof SnapshotError)
            return blocked("snapshot_error", e.message, { detail: e.code });
        if (e instanceof AckRefusedError)
            return blocked("acknowledge_refused", e.message, { detail: e.code });
        if (isStoreError(e))
            return blocked("authority_error", e.message, { detail: e.name });
        throw e;
    }
}
