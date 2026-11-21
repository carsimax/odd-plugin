// Review START (U5): freeze the candidate, classify risk, pick lenses, relay consent, create the authority.
//
// Pure orchestration over the verified modules (snapshot, state, store, lock); no CLI/MCP wiring (U15).
// Risk classification is INJECTED (`riskAssessor`): U9 provides the real one. Lens policy: low 0 lenses
// (approved at once with the one-shot token), medium 1, high 4. An explicit lens selection is honored
// as the policy of state.ts allows (medium: exactly one lens; high: one to four distinct lenses).
import { randomBytes } from "node:crypto";
import { buildConsentEnvelope, recordDecline, REVIEW_CONTRACT } from "./consent.js";
import { createState, StoreAlreadyExistsError } from "./store.js";
import { findLineage } from "./lineage.js";
import { withStoreLock } from "./lock.js";
import { freezeSnapshot, resolveRepository } from "./snapshot.js";
import { LENSES, start as startTransition } from "./state.js";
import { join } from "node:path";
export const START_SCHEMA = "odd-claude.review-integration.start/v4";
export { REVIEW_CONTRACT };
export const MAX_LENS_REASON = 500;
const refuse = (code, message, extra = {}) => ({ status: "refused", code, message, ...extra });
const LEVELS = ["low", "medium", "high"];
function snapshotTarget(input) {
    const t = input.target;
    if (!t || typeof t !== "object")
        return "target is required";
    if (t.kind === "current-changes") {
        const projection = input.projection ?? "workspace";
        if (projection !== "workspace" && projection !== "staged")
            return "projection must be workspace or staged";
        return { target: { kind: "current-changes", projection }, targetArgs: ["--target", "current-changes"] };
    }
    if (t.kind === "base-diff") {
        if (typeof t.baseRef !== "string" || t.baseRef.trim() === "")
            return "base-diff needs a non-empty baseRef";
        const args = ["--target", "base-diff", "--base-ref", t.baseRef];
        if (t.committedOnly === true)
            return { target: { kind: "base-diff", baseRef: t.baseRef }, targetArgs: [...args, "--committed-only", "true"] };
        return { target: { kind: "base-workspace-overlay", baseRef: t.baseRef }, targetArgs: args };
    }
    return "target kind must be current-changes or base-diff";
}
/** Lens policy. Returns the short lens names, or a refusal. */
function selectLenses(input, assessment) {
    const level = assessment.level;
    const given = input.lenses;
    if (given === undefined) {
        if (input.lensesReason !== undefined)
            return refuse("invalid_lenses", "a lens reason needs an explicit lens selection");
        if (level === "low")
            return { lenses: [] };
        if (level === "high")
            return { lenses: [...LENSES] };
        const focus = assessment.focusLens ?? "risk";
        if (!LENSES.includes(focus))
            return refuse("invalid_risk_assessment", `focusLens ${JSON.stringify(focus)} is not a known lens`);
        return { lenses: [focus] };
    }
    if (level === "low")
        return refuse("invalid_lenses", "an explicit lens selection needs a medium or high risk review, not low");
    if (!Array.isArray(given) || given.length === 0 || given.length > LENSES.length)
        return refuse("invalid_lenses", "an explicit lens selection names one to four lenses");
    const names = [];
    for (const raw of given) {
        const name = typeof raw === "string" ? raw.replace(/^review-/, "") : "";
        if (!LENSES.includes(name))
            return refuse("invalid_lenses", `unknown review lens ${JSON.stringify(raw)}`);
        names.push(name);
    }
    const order = names.map((n) => LENSES.indexOf(n));
    for (let i = 1; i < order.length; i++)
        if (order[i] <= order[i - 1])
            return refuse("invalid_lenses", "explicit lenses must be unique and in canonical order");
    const reason = input.lensesReason;
    if (typeof reason !== "string" || reason.trim() === "" || reason.length > MAX_LENS_REASON) {
        return refuse("invalid_lenses", `an explicit lens selection needs a non-empty reason of at most ${MAX_LENS_REASON} characters`);
    }
    if (level === "medium" && names.length !== 1)
        return refuse("invalid_lenses", "medium risk reviews exactly one lens");
    return { lenses: names, explicit: { names, reason } };
}
const isOutcome = (v) => typeof v === "object" && v !== null && "status" in v;
function resultFrom(record, snapshot, assessment, action, ack) {
    const result = {
        schema: START_SCHEMA,
        contract: REVIEW_CONTRACT,
        operation: "review.start",
        action,
        lenses_required: record.selected_lenses.length > 0,
        lineage_id: record.lineage_id,
        state: record.state,
        risk_level: record.risk_level,
        selected_lenses: record.selected_lenses.map((l) => `review-${l}`),
        projection: record.projection,
        target_identity: record.target_identity,
        base_tree: record.base_tree,
        candidate_tree: record.candidate_tree,
        changed_files: snapshot.paths.length,
        changed_lines: record.original_changed_lines,
        correction_budget: record.correction_budget,
        risk_reasons: assessment.reasons.map((r) => ({ ...r })),
        artifact_subjects: [],
    };
    if (ack !== undefined) {
        result.acknowledgement = { lineage_id: record.lineage_id, target_identity: record.target_identity, expected_revision: record.revision, token: ack };
    }
    return result;
}
const newLineage = () => `review-${randomBytes(8).toString("hex")}`;
export async function startReview(input) {
    if (typeof input.riskAssessor !== "function")
        return refuse("invalid_input", "riskAssessor is required");
    if (input.consent !== "relay" && input.consent !== "granted" && input.consent !== "declined")
        return refuse("invalid_input", "consent must be relay, granted or declined");
    const mapped = snapshotTarget(input);
    if (typeof mapped === "string")
        return refuse("invalid_input", mapped);
    const repository = resolveRepository(input.cwd);
    const frozen = freezeSnapshot(input.cwd, mapped.target);
    if (frozen.status === "empty")
        return { status: "not_due", reason: "no_changes", kind: frozen.kind, projection: frozen.projection };
    const { snapshot } = frozen;
    if (input.expectedTargetIdentity !== undefined && input.expectedTargetIdentity !== snapshot.identity) {
        return refuse("binding_drift", "the candidate is no longer the one the consent was asked for; nothing was started");
    }
    const commonDir = frozen.repository.commonDir;
    const assessment = await input.riskAssessor(snapshot, repository);
    if (!assessment || !LEVELS.includes(assessment.level) || !Array.isArray(assessment.reasons) || assessment.reasons.length === 0 ||
        !Array.isArray(assessment.evidence)) {
        return refuse("invalid_risk_assessment", "the risk assessment needs a low/medium/high level, at least one reason and an evidence list");
    }
    const selection = selectLenses(input, assessment);
    if (isOutcome(selection))
        return selection;
    const existing = findLineage(commonDir, snapshot.identity, snapshot.projection);
    if (existing.live)
        return { status: "started", result: resultFrom(existing.live, snapshot, assessment, "replayed") };
    if (existing.burned)
        return refuse("target_already_acknowledged", "this candidate was already reviewed and acknowledged", { lineage_id: existing.burned.lineage_id });
    const needsConsent = assessment.level !== "low";
    if (needsConsent && input.consent === "relay") {
        return {
            status: "consent_required",
            envelope: buildConsentEnvelope({
                cwd: repository.root,
                targetIdentity: snapshot.identity,
                projection: snapshot.projection,
                riskLevel: assessment.level,
                changedFiles: snapshot.paths.length,
                changedLines: snapshot.changedLines,
                riskEvidence: assessment.evidence,
                targetArgs: mapped.targetArgs,
                lenses: selection.explicit,
                locale: input.locale,
            }),
        };
    }
    const now = (input.now ?? (() => new Date().toISOString()))();
    if (needsConsent && input.consent === "declined") {
        const { path } = recordDecline(commonDir, {
            target_identity: snapshot.identity,
            projection: snapshot.projection,
            risk_level: assessment.level,
            declined_at: now,
        });
        return { status: "declined", target_identity: snapshot.identity, projection: snapshot.projection, risk_level: assessment.level, record_path: path };
    }
    // granted (or low risk, which needs no consent): serialize STARTs per repository so one candidate gets one lineage.
    const startLockRoot = join(commonDir, "odd-plugin", "start");
    return withStoreLock(startLockRoot, async () => {
        const again = findLineage(commonDir, snapshot.identity, snapshot.projection);
        if (again.live)
            return { status: "started", result: resultFrom(again.live, snapshot, assessment, "replayed") };
        if (again.burned)
            return refuse("target_already_acknowledged", "this candidate was already reviewed and acknowledged", { lineage_id: again.burned.lineage_id });
        for (let attempt = 0;; attempt++) {
            const lineageId = (input.randomLineage ?? newLineage)();
            const started = startTransition({
                lineageId,
                targetIdentity: snapshot.identity,
                projection: snapshot.projection,
                baseTree: snapshot.baseTree,
                candidateTree: snapshot.candidateTree,
                riskLevel: assessment.level,
                selectedLenses: selection.lenses,
                originalChangedLines: snapshot.changedLines,
                now,
                randomToken: input.randomToken,
            });
            if (!started.ok)
                return refuse("invalid_input", started.refusal.message);
            try {
                const record = await createState(commonDir, started.record);
                return { status: "started", result: resultFrom(record, snapshot, assessment, assessment.level === "low" ? "closed" : "created", started.ackToken) };
            }
            catch (e) {
                if (e instanceof StoreAlreadyExistsError && attempt < 2)
                    continue;
                throw e;
            }
        }
    });
}
