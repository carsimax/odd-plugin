// Review STATUS (U10): the status envelope (shape of the vendored status-v5 under odd-claude ids) computed from the
// repository and the authority store. Read-only: nothing is written, no lock is taken.
//
// `next_transition` is one of: execute (start a fresh target, settle a review, acknowledge an approval), collect
// (pending lens / refuter / validator / corrected-candidate slots, each with an opaque, signed binding) or stop
// (a typed reason code, terminal or recoverable, see contract.ts).
import { createHash } from "node:crypto";
import { isTargetConsumed, type ConsumedResult, type ConsumptionStatus } from "./ack.js";
import { lensArtifactSubject } from "./artifact.js";
import {
  encodeBinding, forecastFor, PROJECTION_SCHEMA, REPAIR_SCHEMA, REVIEW_CONTRACT, STATUS_SCHEMA,
  type BindingRole, type Forecast, type ReasonCode, type TransitionKind,
} from "./contract.js";
import { readDecline, reviewCommand } from "./consent.js";
import { assessRisk } from "./risk.js";
import { digestPaths, freezeSnapshot, snapshotIdentity, type Snapshot, type SnapshotOptions, type SnapshotTarget } from "./snapshot.js";
import { blockingFindingIds, MAX_ADMITTED_ROLE_RESULTS, MAX_CORRECTION_ATTEMPTS, type Projection, type StateRecord } from "./state.js";
import { findLineage, hasRole, lensesPending } from "./lineage.js";
import type { StartTarget } from "./start.js";

export const REVIEWER_RESULT_SCHEMA = "odd-claude.review-reviewer-result/v1";

export interface StatusAcknowledgement {
  lineage_id: string;
  target_identity: string;
  expected_revision: string;
  token: string;
}

export interface StatusOptions extends SnapshotOptions {
  target?: StartTarget;
  /** `current-changes` only. */
  projection?: Projection;
  /** The one-shot approval token, only the caller holds it; without it an approval cannot be offered for acknowledgement. */
  acknowledgement?: StatusAcknowledgement;
  /** Bounds of the consumption scan (store.listLineages). */
  limit?: number;
  maxScan?: number;
}

export interface TransitionArgument {
  name: string;
  value: string;
  token: string;
}
export interface TransitionInput {
  name: string;
  schema: string;
  capture_operation: string;
  /** Extension: the review tool that takes this input, and `arguments` are literally its (string-valued) properties. */
  command: string;
  arguments: TransitionArgument[];
  artifact_subject?: unknown;
  base_tree?: string;
  candidate_tree?: string;
}
export interface NextTransition {
  kind: TransitionKind;
  reason_code: ReasonCode;
  execute?: {
    operation: string;
    command: string;
    arguments: TransitionArgument[];
    preconditions: { name: string; value: string }[];
    binding: { lineage_id?: string; revision?: string; target_identity: string };
  };
  /**
   * Extension: `command` is the review tool that admits this collect and `arguments` its literal (string-valued) properties:
   * review_capture for one reviewer slot, review_capture_group for several (`bindings` is a JSON array of the slots' bindings, in
   * order), review_run for the correction and validator steps. `inputs` describe each slot.
   */
  collect?: { inputs: TransitionInput[]; command: string; arguments: TransitionArgument[] };
}

export interface StatusEnvelope {
  schema: typeof STATUS_SCHEMA;
  contract: typeof REVIEW_CONTRACT;
  operation: "review.status";
  applicability: "current_target";
  action: "start" | "validate" | "stop";
  replayability: "not_replayable" | "exact_replay_safe" | "status_required";
  authority?: { version: "compact-v2"; lineage_id: string; state: string; generation: number; revision: string };
  frozen?: { tier: string; original_changed_lines: number; correction_budget: number };
  target_identity: string;
  projection: Record<string, unknown>;
  repair: Record<string, unknown>;
  candidates: string[];
  next_transition: NextTransition;
  forecast: Forecast;
  /** Extension: consumption of this candidate. `unknown` (or a truncated scan) is NOT consumed (ack.isTargetConsumed), and is reported. */
  consumed: { status: ConsumptionStatus; truncated: boolean; problems: { lineage: string; code: string; message: string }[] };
}

// Convention (all transitions): an argument's `name` is EXACTLY a property of the review tool the transition names (snake_case), its
// `value` the string form of that property (the server coerces "true"/"false", integers and JSON arrays to the declared type), so a
// transition taken literally is accepted by the tool.
const arg = (name: string, value: string): TransitionArgument => ({ name, value, token: `--${name}=${value}` });

function mapTarget(opts: StatusOptions): { target: SnapshotTarget; targetArgs: TransitionArgument[] } {
  const t = opts.target ?? { kind: "current-changes" as const };
  if (t.kind === "current-changes") {
    const projection = opts.projection ?? "workspace";
    return { target: { kind: "current-changes", projection }, targetArgs: [arg("target", "current-changes"), arg("projection", projection)] };
  }
  const args = [arg("target", "base-diff"), arg("base_ref", t.baseRef)];
  if (t.committedOnly === true) return { target: { kind: "base-diff", baseRef: t.baseRef }, targetArgs: [...args, arg("committed_only", "true")] };
  return { target: { kind: "base-workspace-overlay", baseRef: t.baseRef }, targetArgs: args };
}

const REPAIR = {
  schema: REPAIR_SCHEMA,
  status: "unsupported",
  counts: { lineages: 0, compact_lineages: 0, legacy_lineages: 0, events: 0, bytes: 0, eligible_candidates: 0, unsupported_lineages: 0, conflicts: 0 },
  supported_operations: ["review/complete-fix", "review/validate-fix"],
  authorization_schema: "odd-claude.review-repair-authorization/v1",
} as const;

interface Head {
  next: NextTransition;
  action: StatusEnvelope["action"];
  replayability: StatusEnvelope["replayability"];
}

const stop = (reason: ReasonCode): Head => ({ next: { kind: "stop", reason_code: reason }, action: "stop", replayability: "not_replayable" });

interface Ctx {
  root: string;
  targetArgs: TransitionArgument[];
}

const bindingOf = (i: TransitionInput): string => i.arguments.find((a) => a.name === "binding")!.value;

function collectHead(reason: ReasonCode, inputs: TransitionInput[], ctx: Ctx): Head {
  const first = inputs[0]!;
  const reviewers = inputs.every((i) => i.command === reviewCommand("capture"));
  const lineage = first.arguments.find((a) => a.name === "lineage_id")!;
  let command: string;
  let args: TransitionArgument[];
  if (!reviewers) {
    command = first.command;
    args = first.arguments;
  } else if (inputs.length === 1) {
    command = reviewCommand("capture");
    args = first.arguments;
  } else {
    command = reviewCommand("capture-group");
    args = [arg("cwd", ctx.root), lineage, arg("bindings", JSON.stringify(inputs.map(bindingOf))), ...ctx.targetArgs];
  }
  return { next: { kind: "collect", reason_code: reason, collect: { inputs, command, arguments: args } }, action: "validate", replayability: "status_required" };
}

function roleInput(record: StateRecord, ctx: Ctx, role: BindingRole, name: string, captureOperation: string, extra: Partial<TransitionInput> = {}, binding: { lens?: string; subject_hash?: string } = {}): TransitionInput {
  const bound = encodeBinding({
    role,
    target_identity: record.target_identity,
    lineage_id: record.lineage_id,
    revision: record.revision,
    ...(binding.lens !== undefined ? { lens: binding.lens } : {}),
    ...(binding.subject_hash !== undefined ? { subject_hash: binding.subject_hash } : {}),
  });
  // lens and refuter slots are admitted by review_capture(_group); the correction and validator steps by review_run (it plans the
  // correction, runs the validator on the corrected candidate and verifies its own bindings).
  const reviewer = role === "lens" || role === "refuter";
  return {
    name,
    schema: REVIEWER_RESULT_SCHEMA,
    capture_operation: captureOperation,
    command: reviewCommand(reviewer ? "capture" : "run"),
    arguments: [arg("cwd", ctx.root), arg("lineage_id", record.lineage_id), ...(reviewer ? [arg("binding", bound)] : []), ...ctx.targetArgs],
    ...extra,
  };
}

function liveHead(commonDir: string, record: StateRecord, ack: StatusAcknowledgement | undefined, ctx: Ctx): Head {
  const root = ctx.root;
  switch (record.state) {
    case "escalated":
      return stop("escalated");
    case "invalidated":
      return stop("invalidated");
    case "reviewing": {
      const pending = lensesPending(record);
      if (pending.length > 0) {
        if (record.admitted_role_results.length + pending.length > MAX_ADMITTED_ROLE_RESULTS) return stop("role_capacity_exceeded");
        const inputs = pending.map((lens) => {
          const subject = lensArtifactSubject(commonDir, record, lens);
          if (subject === null) throw new Error(`lens ${lens} has no artifact subject`);
          return roleInput(
            record, ctx, "lens", `reviewer_result_${lens}`, "review.capture-result",
            { artifact_subject: subject, base_tree: record.base_tree, candidate_tree: record.candidate_tree },
            { lens, subject_hash: subject.subject_hash },
          );
        });
        return collectHead("reviewer_results_required", inputs, ctx);
      }
      if (blockingFindingIds(record).length > 0 && !hasRole(record, "refuter") && record.admitted_role_results.length < MAX_ADMITTED_ROLE_RESULTS) {
        return collectHead("refuter_results_available", [roleInput(record, ctx, "refuter", "refuter_result", "review.capture-refuter-result")], ctx);
      }
      return {
        next: {
          kind: "execute",
          reason_code: "review_completion_required",
          execute: {
            operation: "review.validate",
            command: reviewCommand("complete"),
            arguments: [arg("cwd", root), arg("lineage_id", record.lineage_id), arg("expected_revision", record.revision)],
            preconditions: [{ name: "state", value: "reviewing" }],
            binding: { lineage_id: record.lineage_id, revision: record.revision, target_identity: record.target_identity },
          },
        },
        action: "validate",
        replayability: "status_required",
      };
    }
    case "correction_required":
      if (record.correction_attempts >= MAX_CORRECTION_ATTEMPTS) return stop("correction_budget_exhausted");
      return collectHead("correction_required", [roleInput(record, ctx, "correction", "corrected_candidate", "review.begin-correction-validation")], ctx);
    case "validating":
      if (hasRole(record, "validator")) return stop("corrupted_or_unverifiable_authority");
      return collectHead("validator_result_required", [roleInput(record, ctx, "validator", "validator_result", "review.capture-validator-result")], ctx);
    case "approved": {
      if (!ack) return stop("acknowledgement_token_unavailable");
      if (ack.lineage_id !== record.lineage_id || ack.target_identity !== record.target_identity || ack.expected_revision !== record.revision) {
        return stop("corrupted_or_unverifiable_authority");
      }
      return {
        next: {
          kind: "execute",
          reason_code: "approved_acknowledgement_required",
          execute: {
            operation: "review.acknowledge-approved",
            command: reviewCommand("acknowledge-approved"),
            arguments: [arg("cwd", root), arg("lineage_id", record.lineage_id), arg("target_identity", record.target_identity), arg("expected_revision", record.revision), arg("token", ack.token)],
            preconditions: [{ name: "state", value: "approved" }],
            binding: { lineage_id: record.lineage_id, revision: record.revision, target_identity: record.target_identity },
          },
        },
        action: "validate",
        replayability: "not_replayable",
      };
    }
  }
}

const generationOf = (r: StateRecord): number => 1 + r.admitted_role_results.length + r.correction_attempts + (r.burned ? 1 : 0);

function projectionOf(snapshot: { kind: string; projection: string; baseTree: string; candidateTree: string; paths: readonly string[]; pathsDigest: string; intendedUntracked: readonly string[]; intendedUntrackedProof: string; identity: string }, record?: StateRecord): Record<string, unknown> {
  return {
    schema: PROJECTION_SCHEMA,
    kind: snapshot.kind,
    projection: snapshot.projection,
    base_tree: snapshot.baseTree,
    initial_review_tree: record?.original_candidate_tree ?? record?.candidate_tree ?? snapshot.candidateTree,
    current_candidate_tree: snapshot.candidateTree,
    paths_digest: snapshot.pathsDigest,
    paths: [...snapshot.paths],
    intended_untracked: [...snapshot.intendedUntracked],
    intended_untracked_proof: snapshot.intendedUntrackedProof,
    initial_snapshot_identity: record?.original_target_identity ?? record?.target_identity ?? snapshot.identity,
    current_snapshot_identity: snapshot.identity,
  };
}

const sha = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/** Status of the current candidate. Throws SnapshotError when the candidate cannot be frozen. */
export function reviewStatus(cwd: string, opts: StatusOptions = {}): StatusEnvelope {
  const { target, targetArgs } = mapTarget(opts);
  const frozen = freezeSnapshot(cwd, target, opts);
  const root = frozen.repository.root;
  const commonDir = frozen.repository.commonDir;
  const finish = (head: Head, snapshotView: Parameters<typeof projectionOf>[0], identity: string, consumed: StatusEnvelope["consumed"], record?: StateRecord): StatusEnvelope => ({
    schema: STATUS_SCHEMA,
    contract: REVIEW_CONTRACT,
    operation: "review.status",
    applicability: "current_target",
    action: head.action,
    replayability: head.replayability,
    ...(record
      ? {
          authority: { version: "compact-v2" as const, lineage_id: record.lineage_id, state: record.state, generation: generationOf(record), revision: record.revision },
          frozen: { tier: record.risk_level, original_changed_lines: record.original_changed_lines, correction_budget: record.correction_budget },
        }
      : {}),
    target_identity: identity,
    projection: projectionOf(snapshotView, record),
    repair: { ...REPAIR, counts: { ...REPAIR.counts }, supported_operations: [...REPAIR.supported_operations] },
    candidates: [],
    next_transition: head.next,
    forecast: forecastFor(head.next.kind, head.next.reason_code),
    consumed,
  });
  const notConsumed: StatusEnvelope["consumed"] = { status: "not_consumed", truncated: false, problems: [] };

  if (frozen.status === "empty") {
    const digest = digestPaths([]);
    const identity = snapshotIdentity(frozen.kind, frozen.projection, frozen.baseTree, frozen.candidateTree, digest);
    return finish(
      stop("not_due"),
      { kind: frozen.kind, projection: frozen.projection, baseTree: frozen.baseTree, candidateTree: frozen.candidateTree, paths: [], pathsDigest: digest, intendedUntracked: [], intendedUntrackedProof: sha("empty"), identity },
      identity,
      notConsumed,
    );
  }

  const snapshot: Snapshot = frozen.snapshot;
  const scan: ConsumedResult = isTargetConsumed(commonDir, snapshot.identity, { limit: opts.limit, maxScan: opts.maxScan });
  const consumed: StatusEnvelope["consumed"] = { status: scan.status, truncated: scan.truncated, problems: scan.problems.map((p) => ({ ...p })) };
  const lineage = findLineage(commonDir, snapshot.identity, snapshot.projection, { limit: opts.limit, maxScan: opts.maxScan });

  if (scan.consumed === true || lineage.burned) return finish(stop("target_already_acknowledged"), snapshot, snapshot.identity, consumed, lineage.burned ?? lineage.live);
  if (lineage.live) return finish(liveHead(commonDir, lineage.live, opts.acknowledgement, { root, targetArgs }), snapshot, snapshot.identity, consumed, lineage.live);
  if (readDecline(commonDir, snapshot.identity)) return finish(stop("consent_declined"), snapshot, snapshot.identity, consumed);

  const risk = assessRisk(snapshot, frozen.repository, opts).risk_level;
  const reason: ReasonCode = risk === "low" ? "native_low_risk_verification" : "fresh_target_ready";
  const head: Head = {
    next: {
      kind: "execute",
      reason_code: reason,
      execute: {
        operation: "review.start",
        command: reviewCommand("start"),
        arguments: [arg("cwd", root), arg("contract", REVIEW_CONTRACT), arg("target_identity", snapshot.identity), ...targetArgs],
        preconditions: [{ name: "state", value: "unreviewed" }],
        binding: { target_identity: snapshot.identity },
      },
    },
    action: "start",
    replayability: "exact_replay_safe",
  };
  return finish(head, snapshot, snapshot.identity, consumed);
}
