// Review START (U5): freeze the candidate, classify risk, pick lenses, relay consent, create the authority.
//
// Pure orchestration over the verified modules (snapshot, state, store, lock); no CLI/MCP wiring (U15).
// Risk classification is INJECTED (`riskAssessor`): U9 provides the real one. Lens policy: low 0 lenses
// (approved at once with the one-shot token), medium 1, high 4. An explicit lens selection is honored
// as the policy of state.ts allows (medium: exactly one lens; high: one to four distinct lenses).
import { randomBytes } from "node:crypto";
import { buildConsentEnvelope, recordDecline, REVIEW_CONTRACT, type ConsentEnvelope } from "./consent.js";
import { createState, StoreAlreadyExistsError } from "./store.js";
import { findLineage } from "./lineage.js";
import { withStoreLock } from "./lock.js";
import { freezeSnapshot, resolveRepository, type RepositoryIdentity, type Snapshot, type SnapshotTarget } from "./snapshot.js";
import { LENSES, start as startTransition, type Projection, type RiskLevel, type StateRecord } from "./state.js";
import { join } from "node:path";

export const START_SCHEMA = "odd-claude.review-integration.start/v4";
export { REVIEW_CONTRACT };

export const MAX_LENS_REASON = 500;

export interface RiskReason {
  code: string;
  signal?: string;
  path?: string;
  old_mode?: string;
  new_mode?: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  /** At least one reason (the start contract requires it). */
  reasons: RiskReason[];
  /** Human evidence lines for the consent question. */
  evidence: string[];
  /** Medium risk: the lens to run when the caller names none. Defaults to `risk`. */
  focusLens?: string;
}
export type RiskAssessor = (snapshot: Snapshot, repository: RepositoryIdentity) => RiskAssessment | Promise<RiskAssessment>;

export type StartTarget = { kind: "current-changes" } | { kind: "base-diff"; baseRef: string; committedOnly?: boolean };

export interface StartInput {
  cwd: string;
  target: StartTarget;
  /** Used by `current-changes`; base targets report the projection of their snapshot. */
  projection?: Projection;
  lenses?: string[];
  lensesReason?: string;
  consent: "relay" | "granted" | "declined";
  locale?: string;
  /** Accepted for the future CLI/MCP surface (U10/U15); not persisted by START. */
  requestContext?: string;
  /**
   * The consent binding: the target identity the human answered for. When set, START refuses (`binding_drift`, nothing written)
   * unless the candidate it freezes now has exactly this identity.
   */
  expectedTargetIdentity?: string;
  riskAssessor: RiskAssessor;
  /** Test seams. */
  now?: () => string;
  randomToken?: () => string;
  randomLineage?: () => string;
}

export type StartRefusalCode =
  | "invalid_input"
  | "invalid_lenses"
  | "invalid_risk_assessment"
  | "target_already_acknowledged"
  | "binding_drift";

export interface Acknowledgement {
  lineage_id: string;
  target_identity: string;
  expected_revision: string;
  /** Returned once; only its hash is stored. */
  token: string;
}

export interface StartResult {
  schema: typeof START_SCHEMA;
  contract: typeof REVIEW_CONTRACT;
  operation: "review.start";
  action: "created" | "replayed" | "closed";
  lenses_required: boolean;
  lineage_id: string;
  state: StateRecord["state"];
  risk_level: RiskLevel;
  selected_lenses: string[];
  projection: Projection;
  target_identity: string;
  base_tree: string;
  candidate_tree: string;
  changed_files: number;
  changed_lines: number;
  correction_budget: number;
  risk_reasons: RiskReason[];
  artifact_subjects: [];
  acknowledgement?: Acknowledgement;
}

export type StartOutcome =
  | { status: "not_due"; reason: "no_changes"; kind: string; projection: Projection }
  | { status: "consent_required"; envelope: ConsentEnvelope }
  | { status: "declined"; target_identity: string; projection: Projection; risk_level: "medium" | "high"; record_path: string }
  | { status: "started"; result: StartResult }
  | { status: "refused"; code: StartRefusalCode; message: string; lineage_id?: string };

const refuse = (code: StartRefusalCode, message: string, extra: { lineage_id?: string } = {}): StartOutcome => ({ status: "refused", code, message, ...extra });
const LEVELS: readonly string[] = ["low", "medium", "high"];

function snapshotTarget(input: StartInput): { target: SnapshotTarget; targetArgs: string[] } | string {
  const t = input.target as { kind?: unknown; baseRef?: unknown; committedOnly?: unknown } | null;
  if (!t || typeof t !== "object") return "target is required";
  if (t.kind === "current-changes") {
    const projection = input.projection ?? "workspace";
    if (projection !== "workspace" && projection !== "staged") return "projection must be workspace or staged";
    return { target: { kind: "current-changes", projection }, targetArgs: ["--target", "current-changes"] };
  }
  if (t.kind === "base-diff") {
    if (typeof t.baseRef !== "string" || t.baseRef.trim() === "") return "base-diff needs a non-empty baseRef";
    const args = ["--target", "base-diff", "--base-ref", t.baseRef];
    if (t.committedOnly === true) return { target: { kind: "base-diff", baseRef: t.baseRef }, targetArgs: [...args, "--committed-only", "true"] };
    return { target: { kind: "base-workspace-overlay", baseRef: t.baseRef }, targetArgs: args };
  }
  return "target kind must be current-changes or base-diff";
}

/** Lens policy. Returns the short lens names, or a refusal. */
function selectLenses(input: StartInput, assessment: RiskAssessment): { lenses: string[]; explicit?: { names: string[]; reason: string } } | StartOutcome {
  const level = assessment.level;
  const given = input.lenses;
  if (given === undefined) {
    if (input.lensesReason !== undefined) return refuse("invalid_lenses", "a lens reason needs an explicit lens selection");
    if (level === "low") return { lenses: [] };
    if (level === "high") return { lenses: [...LENSES] };
    const focus = assessment.focusLens ?? "risk";
    if (!(LENSES as readonly string[]).includes(focus)) return refuse("invalid_risk_assessment", `focusLens ${JSON.stringify(focus)} is not a known lens`);
    return { lenses: [focus] };
  }
  if (level === "low") return refuse("invalid_lenses", "an explicit lens selection needs a medium or high risk review, not low");
  if (!Array.isArray(given) || given.length === 0 || given.length > LENSES.length) return refuse("invalid_lenses", "an explicit lens selection names one to four lenses");
  const names: string[] = [];
  for (const raw of given) {
    const name = typeof raw === "string" ? raw.replace(/^review-/, "") : "";
    if (!(LENSES as readonly string[]).includes(name)) return refuse("invalid_lenses", `unknown review lens ${JSON.stringify(raw)}`);
    names.push(name);
  }
  const order = names.map((n) => LENSES.indexOf(n as (typeof LENSES)[number]));
  for (let i = 1; i < order.length; i++) if (order[i]! <= order[i - 1]!) return refuse("invalid_lenses", "explicit lenses must be unique and in canonical order");
  const reason = input.lensesReason;
  if (typeof reason !== "string" || reason.trim() === "" || reason.length > MAX_LENS_REASON) {
    return refuse("invalid_lenses", `an explicit lens selection needs a non-empty reason of at most ${MAX_LENS_REASON} characters`);
  }
  if (level === "medium" && names.length !== 1) return refuse("invalid_lenses", "medium risk reviews exactly one lens");
  return { lenses: names, explicit: { names, reason } };
}

const isOutcome = (v: unknown): v is StartOutcome => typeof v === "object" && v !== null && "status" in v;

function resultFrom(record: StateRecord, snapshot: Snapshot, assessment: RiskAssessment, action: StartResult["action"], ack?: string): StartResult {
  const result: StartResult = {
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

export async function startReview(input: StartInput): Promise<StartOutcome> {
  if (typeof input.riskAssessor !== "function") return refuse("invalid_input", "riskAssessor is required");
  if (input.consent !== "relay" && input.consent !== "granted" && input.consent !== "declined") return refuse("invalid_input", "consent must be relay, granted or declined");
  const mapped = snapshotTarget(input);
  if (typeof mapped === "string") return refuse("invalid_input", mapped);

  const repository = resolveRepository(input.cwd);
  const frozen = freezeSnapshot(input.cwd, mapped.target);
  if (frozen.status === "empty") return { status: "not_due", reason: "no_changes", kind: frozen.kind, projection: frozen.projection };
  const { snapshot } = frozen;
  if (input.expectedTargetIdentity !== undefined && input.expectedTargetIdentity !== snapshot.identity) {
    return refuse("binding_drift", "the candidate is no longer the one the consent was asked for; nothing was started");
  }
  const commonDir = frozen.repository.commonDir;

  const assessment = await input.riskAssessor(snapshot, repository);
  if (
    !assessment || !LEVELS.includes(assessment.level) || !Array.isArray(assessment.reasons) || assessment.reasons.length === 0 ||
    !Array.isArray(assessment.evidence)
  ) {
    return refuse("invalid_risk_assessment", "the risk assessment needs a low/medium/high level, at least one reason and an evidence list");
  }
  const selection = selectLenses(input, assessment);
  if (isOutcome(selection)) return selection;

  const existing = findLineage(commonDir, snapshot.identity, snapshot.projection);
  if (existing.live) return { status: "started", result: resultFrom(existing.live, snapshot, assessment, "replayed") };
  if (existing.burned) return refuse("target_already_acknowledged", "this candidate was already reviewed and acknowledged", { lineage_id: existing.burned.lineage_id });

  const needsConsent = assessment.level !== "low";
  if (needsConsent && input.consent === "relay") {
    return {
      status: "consent_required",
      envelope: buildConsentEnvelope({
        cwd: repository.root,
        targetIdentity: snapshot.identity,
        projection: snapshot.projection,
        riskLevel: assessment.level as "medium" | "high",
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
      risk_level: assessment.level as "medium" | "high",
      declined_at: now,
    });
    return { status: "declined", target_identity: snapshot.identity, projection: snapshot.projection, risk_level: assessment.level as "medium" | "high", record_path: path };
  }

  // granted (or low risk, which needs no consent): serialize STARTs per repository so one candidate gets one lineage.
  const startLockRoot = join(commonDir, "odd-plugin", "start");
  return withStoreLock(startLockRoot, async (): Promise<StartOutcome> => {
    const again = findLineage(commonDir, snapshot.identity, snapshot.projection);
    if (again.live) return { status: "started", result: resultFrom(again.live, snapshot, assessment, "replayed") };
    if (again.burned) return refuse("target_already_acknowledged", "this candidate was already reviewed and acknowledged", { lineage_id: again.burned.lineage_id });
    for (let attempt = 0; ; attempt++) {
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
      if (!started.ok) return refuse("invalid_input", started.refusal.message);
      try {
        const record = await createState(commonDir, started.record);
        return { status: "started", result: resultFrom(record, snapshot, assessment, assessment.level === "low" ? "closed" : "created", started.ackToken) };
      } catch (e) {
        if (e instanceof StoreAlreadyExistsError && attempt < 2) continue;
        throw e;
      }
    }
  });
}
