"""Review STATUS: the status envelope (shape of the vendored status-v5 under odd-claude ids) computed from the repository and the
authority store (port of v9 review/status.ts). Read-only: nothing is written, no lock is taken.

`next_transition` is one of: execute (start a fresh target, settle a review, acknowledge an approval), collect (pending lens /
refuter / validator / corrected-candidate slots, each with an opaque, signed binding) or stop (a typed reason code).
Inputs are v9's camelCase option dicts (`target`, `projection`, `acknowledgement`, `limit`, `maxScan`, `gitTimeoutMs`...); the
envelope is a plain dict in v9's JSON shape. A missing key is JS `undefined`.
Public API: `REVIEWER_RESULT_SCHEMA`, `review_status(cwd, opts=None)` (raises SnapshotError when the candidate cannot be frozen).
"""
import hashlib
import math
from typing import Any

from ..lib.js import js_number_to_string, js_stringify
from .ack import is_target_consumed
from .artifact import lens_artifact_subject
from .consent import REVIEW_CONTRACT, read_decline, review_command
from .contract import PROJECTION_SCHEMA, REPAIR_SCHEMA, STATUS_SCHEMA, encode_binding, forecast_for
from .lineage import find_lineage, has_role, lenses_pending
from .risk import assess_risk
from .snapshot import digest_paths, freeze_snapshot, snapshot_identity
from .start import snapshot_target_of
from .state import MAX_ADMITTED_ROLE_RESULTS, MAX_CORRECTION_ATTEMPTS, blocking_finding_ids

REVIEWER_RESULT_SCHEMA = "odd-claude.review-reviewer-result/v1"

_U: Any = object()  # JS `undefined`


def _prop(v: Any, key: str) -> Any:
    return v.get(key, _U) if isinstance(v, dict) else _U


def _to_string(v: Any) -> str:
    """The JS template-literal string of a JSON value."""
    if v is _U:
        return "undefined"
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return js_number_to_string(v)
    if isinstance(v, list):
        return ",".join("" if x is None else _to_string(x) for x in v)
    return v if isinstance(v, str) else "[object Object]"


def _truthy(v: Any) -> bool:
    if v is _U or v is None or v is False or v == "":
        return False
    return not (isinstance(v, (int, float)) and not isinstance(v, bool) and (v == 0 or math.isnan(v)))


# Convention (all transitions): an argument's `name` is EXACTLY a property of the review tool the transition names (snake_case), its
# `value` the string form of that property, so a transition taken literally is accepted by the tool.
def _arg(name: str, value: Any) -> dict:
    out = {"name": name}
    if value is not _U:
        out["value"] = value
    out["token"] = f"--{name}={_to_string(value)}"
    return out


def _map_target(opts: dict) -> tuple[dict, list[dict]]:
    t = opts.get("target")
    if t is None:
        t = {"kind": "current-changes"}
    if _prop(t, "kind") == "current-changes":
        p = opts.get("projection")
        projection = "workspace" if p is None else p
        return snapshot_target_of({"target": t, "projection": projection}), [_arg("target", "current-changes"), _arg("projection", projection)]
    args = [_arg("target", "base-diff"), _arg("base_ref", _prop(t, "baseRef"))]
    return snapshot_target_of({"target": t}), [*args, _arg("committed_only", "true")] if _prop(t, "committedOnly") is True else args


def _repair() -> dict:
    return {
        "schema": REPAIR_SCHEMA,
        "status": "unsupported",
        "counts": {"lineages": 0, "compact_lineages": 0, "legacy_lineages": 0, "events": 0, "bytes": 0, "eligible_candidates": 0, "unsupported_lineages": 0, "conflicts": 0},
        "supported_operations": ["review/complete-fix", "review/validate-fix"],
        "authorization_schema": "odd-claude.review-repair-authorization/v1",
    }


def _stop(reason: str) -> dict:
    return {"next": {"kind": "stop", "reason_code": reason}, "action": "stop", "replayability": "not_replayable"}


def _binding_of(i: dict) -> str:
    return next(a for a in i["arguments"] if a["name"] == "binding")["value"]


def _collect_head(reason: str, inputs: list[dict], ctx: dict) -> dict:
    first = inputs[0]
    reviewers = all(i["command"] == review_command("capture") for i in inputs)
    lineage = next(a for a in first["arguments"] if a["name"] == "lineage_id")
    if not reviewers:
        command, args = first["command"], first["arguments"]
    elif len(inputs) == 1:
        command, args = review_command("capture"), first["arguments"]
    else:
        command = review_command("capture-group")
        args = [_arg("cwd", ctx["root"]), lineage, _arg("bindings", js_stringify([_binding_of(i) for i in inputs])), *ctx["targetArgs"]]
    return {"next": {"kind": "collect", "reason_code": reason, "collect": {"inputs": inputs, "command": command, "arguments": args}}, "action": "validate", "replayability": "status_required"}


def _role_input(record: dict, ctx: dict, role: str, name: str, capture_operation: str, extra: dict | None = None, binding: dict | None = None) -> dict:
    binding = binding or {}
    bound = encode_binding({
        "role": role, "target_identity": record["target_identity"], "lineage_id": record["lineage_id"], "revision": record["revision"],
        **({"lens": binding["lens"]} if "lens" in binding else {}),
        **({"subject_hash": binding["subject_hash"]} if "subject_hash" in binding else {}),
    })
    # lens and refuter slots are admitted by review_capture(_group); the correction and validator steps by review_run.
    reviewer = role in ("lens", "refuter")
    return {
        "name": name,
        "schema": REVIEWER_RESULT_SCHEMA,
        "capture_operation": capture_operation,
        "command": review_command("capture" if reviewer else "run"),
        "arguments": [_arg("cwd", ctx["root"]), _arg("lineage_id", record["lineage_id"]), *([_arg("binding", bound)] if reviewer else []), *ctx["targetArgs"]],
        **(extra or {}),
    }


def _live_head(common_dir: str, record: dict, ack: Any, ctx: dict) -> dict:
    root = ctx["root"]
    state = record["state"]
    if state == "escalated":
        return _stop("escalated")
    if state == "invalidated":
        return _stop("invalidated")
    if state == "reviewing":
        pending = lenses_pending(record)
        if len(pending) > 0:
            if len(record["admitted_role_results"]) + len(pending) > MAX_ADMITTED_ROLE_RESULTS:
                return _stop("role_capacity_exceeded")
            inputs = []
            for lens in pending:
                subject = lens_artifact_subject(common_dir, record, lens)
                if subject is None:
                    raise Exception(f"lens {lens} has no artifact subject")  # noqa: TRY002
                inputs.append(_role_input(
                    record, ctx, "lens", f"reviewer_result_{lens}", "review.capture-result",
                    {"artifact_subject": subject, "base_tree": record["base_tree"], "candidate_tree": record["candidate_tree"]},
                    {"lens": lens, "subject_hash": subject["subject_hash"]},
                ))
            return _collect_head("reviewer_results_required", inputs, ctx)
        if len(blocking_finding_ids(record)) > 0 and not has_role(record, "refuter") and len(record["admitted_role_results"]) < MAX_ADMITTED_ROLE_RESULTS:
            return _collect_head("refuter_results_available", [_role_input(record, ctx, "refuter", "refuter_result", "review.capture-refuter-result")], ctx)
        return {
            "next": {
                "kind": "execute",
                "reason_code": "review_completion_required",
                "execute": {
                    "operation": "review.validate",
                    "command": review_command("complete"),
                    "arguments": [_arg("cwd", root), _arg("lineage_id", record["lineage_id"]), _arg("expected_revision", record["revision"])],
                    "preconditions": [{"name": "state", "value": "reviewing"}],
                    "binding": {"lineage_id": record["lineage_id"], "revision": record["revision"], "target_identity": record["target_identity"]},
                },
            },
            "action": "validate",
            "replayability": "status_required",
        }
    if state == "correction_required":
        if record["correction_attempts"] >= MAX_CORRECTION_ATTEMPTS:
            return _stop("correction_budget_exhausted")
        return _collect_head("correction_required", [_role_input(record, ctx, "correction", "corrected_candidate", "review.begin-correction-validation")], ctx)
    if state == "validating":
        if has_role(record, "validator"):
            return _stop("corrupted_or_unverifiable_authority")
        return _collect_head("validator_result_required", [_role_input(record, ctx, "validator", "validator_result", "review.capture-validator-result")], ctx)
    if state == "approved":
        if not _truthy(ack):
            return _stop("acknowledgement_token_unavailable")
        if _prop(ack, "lineage_id") != record["lineage_id"] or _prop(ack, "target_identity") != record["target_identity"] or _prop(ack, "expected_revision") != record["revision"]:
            return _stop("corrupted_or_unverifiable_authority")
        return {
            "next": {
                "kind": "execute",
                "reason_code": "approved_acknowledgement_required",
                "execute": {
                    "operation": "review.acknowledge-approved",
                    "command": review_command("acknowledge-approved"),
                    "arguments": [
                        _arg("cwd", root), _arg("lineage_id", record["lineage_id"]), _arg("target_identity", record["target_identity"]),
                        _arg("expected_revision", record["revision"]), _arg("token", _prop(ack, "token")),
                    ],
                    "preconditions": [{"name": "state", "value": "approved"}],
                    "binding": {"lineage_id": record["lineage_id"], "revision": record["revision"], "target_identity": record["target_identity"]},
                },
            },
            "action": "validate",
            "replayability": "not_replayable",
        }
    raise TypeError("Cannot read properties of undefined (reading 'action')")  # a validated record always has one of the states above


def _generation_of(r: dict) -> int:
    return 1 + len(r["admitted_role_results"]) + r["correction_attempts"] + (1 if r["burned"] else 0)


def _first(*values: Any) -> Any:
    """`a ?? b ?? c`."""
    return next((v for v in values if v is not None), None)


def _projection_of(s: dict, record: dict | None = None) -> dict:
    rec = record or {}
    return {
        "schema": PROJECTION_SCHEMA,
        "kind": s["kind"],
        "projection": s["projection"],
        "base_tree": s["baseTree"],
        "initial_review_tree": _first(rec.get("original_candidate_tree"), rec.get("candidate_tree"), s["candidateTree"]),
        "current_candidate_tree": s["candidateTree"],
        "paths_digest": s["pathsDigest"],
        "paths": list(s["paths"]),
        "intended_untracked": list(s["intendedUntracked"]),
        "intended_untracked_proof": s["intendedUntrackedProof"],
        "initial_snapshot_identity": _first(rec.get("original_target_identity"), rec.get("target_identity"), s["identity"]),
        "current_snapshot_identity": s["identity"],
    }


def _sha(text: str) -> str:
    return f"sha256:{hashlib.sha256(text.encode('utf-8')).hexdigest()}"


def review_status(cwd: str, opts: dict | None = None) -> dict:
    """Status of the current candidate. Raises SnapshotError when the candidate cannot be frozen."""
    opts = opts if opts is not None else {}
    target, target_args = _map_target(opts)
    frozen = freeze_snapshot(cwd, target, opts)
    root = frozen["repository"]["root"]
    common_dir = frozen["repository"]["commonDir"]

    def finish(head: dict, view: dict, identity: str, consumed: dict, record: dict | None = None) -> dict:
        return {
            "schema": STATUS_SCHEMA,
            "contract": REVIEW_CONTRACT,
            "operation": "review.status",
            "applicability": "current_target",
            "action": head["action"],
            "replayability": head["replayability"],
            **(
                {
                    "authority": {"version": "compact-v2", "lineage_id": record["lineage_id"], "state": record["state"], "generation": _generation_of(record), "revision": record["revision"]},
                    "frozen": {"tier": record["risk_level"], "original_changed_lines": record["original_changed_lines"], "correction_budget": record["correction_budget"]},
                }
                if record
                else {}
            ),
            "target_identity": identity,
            "projection": _projection_of(view, record),
            "repair": _repair(),
            "candidates": [],
            "next_transition": head["next"],
            "forecast": forecast_for(head["next"]["kind"], head["next"]["reason_code"]),
            "consumed": consumed,
        }

    not_consumed = {"status": "not_consumed", "truncated": False, "problems": []}

    if frozen["status"] == "empty":
        digest = digest_paths([])
        identity = snapshot_identity(frozen["kind"], frozen["projection"], frozen["baseTree"], frozen["candidateTree"], digest)
        return finish(
            _stop("not_due"),
            {"kind": frozen["kind"], "projection": frozen["projection"], "baseTree": frozen["baseTree"], "candidateTree": frozen["candidateTree"], "paths": [], "pathsDigest": digest,
             "intendedUntracked": [], "intendedUntrackedProof": _sha("empty"), "identity": identity},
            identity,
            not_consumed,
        )

    snapshot = frozen["snapshot"]
    # v9 `options.limit === undefined ? all : Math.max(0, limit)`: an explicit null is 0 there, while the Python store reads None as unset
    bounds = {"limit": 0 if "limit" in opts and opts["limit"] is None else opts.get("limit"), "maxScan": opts.get("maxScan")}
    scan = is_target_consumed(common_dir, snapshot["identity"], bounds)
    consumed = {"status": scan["status"], "truncated": scan["truncated"], "problems": [dict(p) for p in scan["problems"]]}
    lineage = find_lineage(common_dir, snapshot["identity"], snapshot["projection"], bounds)

    if scan["consumed"] is True or lineage.get("burned"):
        return finish(_stop("target_already_acknowledged"), snapshot, snapshot["identity"], consumed, lineage.get("burned") or lineage.get("live"))
    if lineage.get("live"):
        head = _live_head(common_dir, lineage["live"], opts.get("acknowledgement"), {"root": root, "targetArgs": target_args})
        return finish(head, snapshot, snapshot["identity"], consumed, lineage["live"])
    if "unreadable" in lineage:
        return finish(_stop("corrupted_or_unverifiable_authority"), snapshot, snapshot["identity"], consumed)
    if read_decline(common_dir, snapshot["identity"]) is not None:
        return finish(_stop("consent_declined"), snapshot, snapshot["identity"], consumed)

    risk = assess_risk(snapshot, frozen["repository"], opts)["risk_level"]
    reason = "native_low_risk_verification" if risk == "low" else "fresh_target_ready"
    head = {
        "next": {
            "kind": "execute",
            "reason_code": reason,
            "execute": {
                "operation": "review.start",
                "command": review_command("start"),
                "arguments": [_arg("cwd", root), _arg("contract", REVIEW_CONTRACT), _arg("target_identity", snapshot["identity"]), *target_args],
                "preconditions": [{"name": "state", "value": "unreviewed"}],
                "binding": {"target_identity": snapshot["identity"]},
            },
        },
        "action": "start",
        "replayability": "exact_replay_safe",
    }
    return finish(head, snapshot, snapshot["identity"], consumed)
