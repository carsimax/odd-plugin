"""Review START: freeze the candidate, classify risk, pick lenses, relay consent, create the authority. Port of v9 review/start.ts.

Pure orchestration over the verified modules (snapshot, state, store, lock). Inputs and outcomes are plain dicts in v9's JSON shape
(camelCase input keys, snake_case result keys); a missing key is JS `undefined`. `riskAssessor(snapshot, repository)` is a
synchronous callable returning `{level, reasons, evidence, focusLens?}`; `now`, `randomToken` and `randomLineage` are optional
test seams (callables). Lens policy: low 0 lenses (approved at once with the one-shot token), medium 1, high 4.
"""
import os
import secrets
from typing import Any, Callable

from ..lib.js import js_stringify, js_trim, utf16_len
from ._paths import js_join
from .ack import _iso_now
from .consent import REVIEW_CONTRACT, build_consent_envelope, record_decline
from .lineage import find_lineage
from .lock import with_store_lock
from .snapshot import freeze_snapshot, resolve_repository
from .state import LENSES
from .state import start as start_transition
from .store import StoreAlreadyExistsError, create_state

START_SCHEMA = "odd-claude.review-integration.start/v4"
MAX_LENS_REASON = 500
_LEVELS = ["low", "medium", "high"]
_U: Any = object()  # JS `undefined`


def js_spread(v: Any) -> dict:
    """`{...v}`: own enumerable properties of an object, array or string; nothing for other values."""
    if isinstance(v, dict):
        return dict(v)
    if isinstance(v, list):
        return {str(i): x for i, x in enumerate(v)}
    if isinstance(v, str):
        u = v.encode("utf-16-le", "surrogatepass")
        return {str(i): u[2 * i : 2 * i + 2].decode("utf-16-le", "surrogatepass") for i in range(len(u) // 2)}
    return {}


def _refuse(code: str, message: str, **extra: Any) -> dict:
    return {"status": "refused", "code": code, "message": message, **extra}


def _prop(v: Any, key: str) -> Any:
    """`v[key]` (a JS property read): `undefined` unless `v` is an object holding it."""
    return v.get(key, _U) if isinstance(v, dict) else _U


def snapshot_target_of(input: dict) -> dict:
    """The snapshot target a start/status/run input freezes."""
    t = input.get("target")
    if t is None:
        t = {"kind": "current-changes"}
    if _prop(t, "kind") == "current-changes":
        p = input.get("projection")
        return {"kind": "current-changes", "projection": "workspace" if p is None else p}
    ref = _prop(t, "baseRef")
    return {"kind": "base-diff" if _prop(t, "committedOnly") is True else "base-workspace-overlay", **({} if ref is _U else {"baseRef": ref})}


def _snapshot_target(input: dict) -> dict | str:
    t = input.get("target")
    if not isinstance(t, (dict, list)):
        return "target is required"
    kind = t.get("kind", _U) if isinstance(t, dict) else _U
    if kind == "current-changes":
        projection = input.get("projection")
        projection = "workspace" if projection is None else projection
        if projection != "workspace" and projection != "staged":
            return "projection must be workspace or staged"
        return {"target": snapshot_target_of({"target": {"kind": "current-changes"}, "projection": projection}), "targetArgs": ["--target", "current-changes"]}
    if kind == "base-diff":
        base_ref = t.get("baseRef")
        if not isinstance(base_ref, str) or js_trim(base_ref) == "":
            return "base-diff needs a non-empty baseRef"
        args = ["--target", "base-diff", "--base-ref", base_ref]
        committed = t.get("committedOnly") is True
        return {
            "target": snapshot_target_of({"target": {"kind": "base-diff", "baseRef": base_ref, "committedOnly": committed}}),
            "targetArgs": [*args, "--committed-only", "true"] if committed else args,
        }
    return "target kind must be current-changes or base-diff"


def _select_lenses(input: dict, assessment: dict) -> dict:
    """Returns `{"lenses", "explicit"?}`, or a refused outcome (it has `status`)."""
    level = assessment["level"]
    given = input.get("lenses", _U)
    reason_given = input.get("lensesReason", _U)
    if given is _U:
        if reason_given is not _U:
            return _refuse("invalid_lenses", "a lens reason needs an explicit lens selection")
        if level == "low":
            return {"lenses": []}
        if level == "high":
            return {"lenses": list(LENSES)}
        focus = assessment.get("focusLens")
        focus = "risk" if focus is None else focus
        if not (isinstance(focus, str) and focus in LENSES):
            return _refuse("invalid_risk_assessment", f"focusLens {js_stringify(focus)} is not a known lens")
        return {"lenses": [focus]}
    if level == "low":
        return _refuse("invalid_lenses", "an explicit lens selection needs a medium or high risk review, not low")
    if not isinstance(given, list) or len(given) == 0 or len(given) > len(LENSES):
        return _refuse("invalid_lenses", "an explicit lens selection names one to four lenses")
    names: list[str] = []
    for raw in given:
        name = raw.removeprefix("review-") if isinstance(raw, str) else ""
        if name not in LENSES:
            return _refuse("invalid_lenses", f"unknown review lens {js_stringify(raw)}")
        names.append(name)
    order = [LENSES.index(n) for n in names]
    if any(order[i] <= order[i - 1] for i in range(1, len(order))):
        return _refuse("invalid_lenses", "explicit lenses must be unique and in canonical order")
    reason = reason_given
    if not isinstance(reason, str) or js_trim(reason) == "" or utf16_len(reason) > MAX_LENS_REASON:
        return _refuse("invalid_lenses", f"an explicit lens selection needs a non-empty reason of at most {MAX_LENS_REASON} characters")
    if level == "medium" and len(names) != 1:
        return _refuse("invalid_lenses", "medium risk reviews exactly one lens")
    return {"lenses": names, "explicit": {"names": names, "reason": reason}}


def _result_from(record: dict, snapshot: dict, assessment: dict, action: str, ack: str | None = None) -> dict:
    result = {
        "schema": START_SCHEMA,
        "contract": REVIEW_CONTRACT,
        "operation": "review.start",
        "action": action,
        "lenses_required": len(record["selected_lenses"]) > 0,
        "lineage_id": record["lineage_id"],
        "state": record["state"],
        "risk_level": record["risk_level"],
        "selected_lenses": [f"review-{x}" for x in record["selected_lenses"]],
        "projection": record["projection"],
        "target_identity": record["target_identity"],
        "base_tree": record["base_tree"],
        "candidate_tree": record["candidate_tree"],
        "changed_files": len(snapshot["paths"]),
        "changed_lines": record["original_changed_lines"],
        "correction_budget": record["correction_budget"],
        "risk_reasons": [js_spread(r) for r in assessment["reasons"]],
        "artifact_subjects": [],
    }
    if ack is not None:
        result["acknowledgement"] = {"lineage_id": record["lineage_id"], "target_identity": record["target_identity"], "expected_revision": record["revision"], "token": ack}
    return result


def _existing_outcome(found: dict, snapshot: dict, assessment: dict) -> dict | None:
    if found.get("live"):
        return {"status": "started", "result": _result_from(found["live"], snapshot, assessment, "replayed")}
    if found.get("burned"):
        return _refuse("target_already_acknowledged", "this candidate was already reviewed and acknowledged", lineage_id=found["burned"]["lineage_id"])
    if "unreadable" in found:
        u = found["unreadable"]
        return _refuse("authority_error", f"lineage {u} cannot be read safely; no new review is opened until it is repaired", lineage_id=u)
    return None


def _new_lineage() -> str:
    return f"review-{secrets.token_hex(8)}"


def start_review(input: dict) -> dict:
    if not callable(input.get("riskAssessor")):
        return _refuse("invalid_input", "riskAssessor is required")
    consent = input.get("consent")
    if consent != "relay" and consent != "granted" and consent != "declined":
        return _refuse("invalid_input", "consent must be relay, granted or declined")
    mapped = _snapshot_target(input)
    if isinstance(mapped, str):
        return _refuse("invalid_input", mapped)

    repository = resolve_repository(input.get("cwd"))
    frozen = freeze_snapshot(input.get("cwd"), mapped["target"])
    if frozen["status"] == "empty":
        return {"status": "not_due", "reason": "no_changes", "kind": frozen["kind"], "projection": frozen["projection"]}
    snapshot = frozen["snapshot"]
    expected = input.get("expectedTargetIdentity", _U)
    if expected is not _U and expected != snapshot["identity"]:
        return _refuse("binding_drift", "the candidate is no longer the one the consent was asked for; nothing was started")
    common_dir = frozen["repository"]["commonDir"]

    assessment = input["riskAssessor"](snapshot, repository)
    if (
        not isinstance(assessment, dict) or assessment.get("level") not in _LEVELS or not isinstance(assessment.get("reasons"), list)
        or len(assessment["reasons"]) == 0 or not isinstance(assessment.get("evidence"), list)
    ):
        return _refuse("invalid_risk_assessment", "the risk assessment needs a low/medium/high level, at least one reason and an evidence list")
    selection = _select_lenses(input, assessment)
    if "status" in selection:
        return selection

    existing = _existing_outcome(find_lineage(common_dir, snapshot["identity"], snapshot["projection"]), snapshot, assessment)
    if existing:
        return existing

    needs_consent = assessment["level"] != "low"
    if needs_consent and consent == "relay":
        return {
            "status": "consent_required",
            "envelope": build_consent_envelope({
                "cwd": repository["root"],
                "targetIdentity": snapshot["identity"],
                "projection": snapshot["projection"],
                "riskLevel": assessment["level"],
                "changedFiles": len(snapshot["paths"]),
                "changedLines": snapshot["changedLines"],
                "riskEvidence": assessment["evidence"],
                "targetArgs": mapped["targetArgs"],
                "lenses": selection.get("explicit"),
                "locale": input.get("locale"),
            }),
        }
    now = (input.get("now") or _iso_now)()
    if needs_consent and consent == "declined":
        path = record_decline(common_dir, {"target_identity": snapshot["identity"], "projection": snapshot["projection"], "risk_level": assessment["level"], "declined_at": now})["path"]
        return {"status": "declined", "target_identity": snapshot["identity"], "projection": snapshot["projection"], "risk_level": assessment["level"], "record_path": path}

    # granted (or low risk, which needs no consent): serialize STARTs per repository so one candidate gets one lineage.
    def locked() -> dict:
        again = _existing_outcome(find_lineage(common_dir, snapshot["identity"], snapshot["projection"]), snapshot, assessment)
        if again:
            return again
        attempt = 0
        while True:
            lineage_id = (input.get("randomLineage") or _new_lineage)()
            started = start_transition({
                "lineageId": lineage_id,
                "targetIdentity": snapshot["identity"],
                "projection": snapshot["projection"],
                "baseTree": snapshot["baseTree"],
                "candidateTree": snapshot["candidateTree"],
                "riskLevel": assessment["level"],
                "selectedLenses": selection["lenses"],
                "originalChangedLines": snapshot["changedLines"],
                "now": now,
                "randomToken": input.get("randomToken"),
            })
            if not started["ok"]:
                return _refuse("invalid_input", started["refusal"]["message"])
            try:
                record = create_state(common_dir, started["record"])
                return {"status": "started", "result": _result_from(record, snapshot, assessment, "closed" if assessment["level"] == "low" else "created", started.get("ackToken"))}
            except StoreAlreadyExistsError:
                if attempt < 2:
                    attempt += 1
                    continue
                raise

    return with_store_lock(js_join(common_dir, "odd-plugin", "start"), locked)
