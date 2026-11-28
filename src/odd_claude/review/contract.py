"""Contract surface of the review engine: stop reason codes, opaque transition bindings and the envelope encoders for the
start / consent / capture / acknowledge results. Port of v9 review/contract.ts; records and outcomes are plain dicts in v9's JSON
shape (`current` of `verify_binding` uses v9's camelCase keys `targetIdentity`, `lineage`, `commonDir`). A missing key is JS
`undefined`: an encoder leaves out the output key it would have filled with it."""
import base64
import re
from typing import Any

from ..lib.js import js_json_loads, js_stringify
from .ack import AckRefusedError
from .artifact import lens_artifact_subject
from .canonical import _js_string, canonical_json, domain_hash
from .consent import CONSENT_SCHEMA, REVIEW_CONTRACT, build_consent_envelope
from .start import js_spread

STATUS_SCHEMA = "odd-claude.review-integration.status/v5"
PROJECTION_SCHEMA = "odd-claude.review-integration.projection/v1"
REPAIR_SCHEMA = "odd-claude.review-authority-repair-assessment/v1"
CAPTURE_SCHEMA = "odd-claude.review-integration.capture/v1"
CAPTURE_DRY_RUN_SCHEMA = "odd-claude.review-capture-result-dry-run/v1"
ACK_SCHEMA = "odd-claude.review-integration.review-acknowledged/v1"
OUTCOME_SCHEMA = "odd-claude.review-integration.start-outcome/v1"
FAILURE_SCHEMA = "odd-claude.review-integration.failure/v2"

_U: Any = object()  # JS `undefined`

# ---- transition kinds and reason codes ----

TRANSITION_KINDS = ("execute", "collect", "stop")

#: Stops nothing can recover from for this candidate: the answer will not change by retrying.
TERMINAL_STOP_CODES = (
    "not_due",
    "escalated",
    "target_already_acknowledged",
    "correction_budget_exhausted",
    "role_capacity_exceeded",
    "manual_intervention_required",
)

#: Stops the operator or the next candidate can lift (a new change, a token, a decision, a repair).
RECOVERABLE_STOP_CODES = (
    "invalidated",
    "consent_declined",
    "acknowledgement_token_unavailable",
    "corrupted_or_unverifiable_authority",
)

#: Reason codes of the non-stop heads (execute / collect).
ACTIVE_REASON_CODES = (
    "fresh_target_ready",
    "native_low_risk_verification",
    "reviewer_results_required",
    "refuter_results_available",
    "review_completion_required",
    "correction_required",
    "validator_result_required",
    "approved_acknowledgement_required",
)

REASON_DESCRIPTIONS = {
    "not_due": "The candidate has no changes, so no review is due",
    "escalated": "The review was escalated and needs a human decision",
    "target_already_acknowledged": "This candidate was already reviewed and acknowledged",
    "correction_budget_exhausted": "The correction attempts are already used",
    "role_capacity_exceeded": "The admitted role results are full",
    "manual_intervention_required": "Manual intervention is required to proceed",
    "invalidated": "The review authority was invalidated; change the candidate and start again",
    "consent_declined": "Review was declined for this candidate; a different candidate asks again",
    "acknowledgement_token_unavailable": "The approval is pending but its one-shot acknowledgement token was not supplied",
    "corrupted_or_unverifiable_authority": "Review authority is corrupted or unverifiable",
    "fresh_target_ready": "Target is unreviewed and ready for initial review start",
    "native_low_risk_verification": "Low risk candidate eligible for native verification",
    "reviewer_results_required": "Reviewer lens artifacts required for current revision",
    "refuter_results_available": "Blocking findings can be challenged by an optional refuter before correction",
    "review_completion_required": "Every lens result is admitted; the review must be settled",
    "correction_required": "A correction of the blocking findings is required",
    "validator_result_required": "A validator result is required for the corrected candidate",
    "approved_acknowledgement_required": "Approved review awaits its one-shot acknowledgement",
}


def is_terminal_stop(code: Any) -> bool:
    return code in TERMINAL_STOP_CODES


def is_recoverable_stop(code: Any) -> bool:
    return code in RECOVERABLE_STOP_CODES


def _obj(*pairs: tuple[str, Any]) -> dict:
    """An object literal: a key whose value is `undefined` is left out."""
    return {k: v for k, v in pairs if v is not _U}


def forecast_for(kind: Any, reason_code: Any) -> dict:
    """One-step forecast of a head transition; a stop is the terminal horizon."""
    # JS property lookup: "__proto__" reaches Object.prototype (an empty object once JSON-encoded); the other inherited names are functions
    description = ({} if reason_code == "__proto__" else REASON_DESCRIPTIONS.get(reason_code, _U)) if isinstance(reason_code, str) else _U
    return {
        "horizon": "terminal" if kind == "stop" else "partial",
        "steps": [_obj(("step", 1), ("kind", kind), ("reason_code", reason_code), ("description", description))],
    }


# ---- opaque transition binding ----

BINDING_ROLES = ("start", "lens", "refuter", "complete", "correction", "validator", "acknowledge")

_SHA_RE = re.compile(r"sha256:[0-9a-f]{64}")
_PAYLOAD_RE = re.compile(r"[A-Za-z0-9_-]+", re.ASCII)
_BINDING_PREFIX = "odd1"
_BINDING_KEYS = {"target_identity", "lineage_id", "revision", "role", "lens", "subject_hash"}


def _tag_of(payload: str) -> str:
    return domain_hash("transition-binding", 1, payload)[len("sha256:"):]


def encode_binding(binding: dict) -> str:
    """`odd1.<base64url(canonical JSON)>.<hex domain-hash tag>`: opaque to callers, verified before use."""
    payload = base64.urlsafe_b64encode(canonical_json(binding).encode("utf-8")).rstrip(b"=").decode("ascii")
    return f"{_BINDING_PREFIX}.{payload}.{_tag_of(payload)}"


def _bad(message: str) -> dict:
    return {"ok": False, "code": "invalid_binding", "message": message}


def _b64url_lenient(s: str) -> bytes:
    """Node's `Buffer.from(s, "base64url")` for an alphabet-only string: unpadded, a dangling sixth bit is dropped."""
    if len(s) % 4 == 1:
        s = s[:-1]
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _is_sha(v: Any) -> bool:
    return isinstance(v, str) and _SHA_RE.fullmatch(v) is not None


def decode_binding(value: Any) -> dict:
    if not isinstance(value, str):
        return _bad("the binding must be a string")
    parts = value.split(".")
    if len(parts) != 3 or parts[0] != _BINDING_PREFIX:
        return _bad("the binding is not an odd-claude transition binding")
    _, payload, tag = parts
    if not _PAYLOAD_RE.fullmatch(payload) or tag != _tag_of(payload):
        return _bad("the binding signature does not verify")
    try:
        o = js_json_loads(_b64url_lenient(payload).decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        return _bad("the binding payload is not JSON")
    if not isinstance(o, dict):
        return _bad("the binding payload is not an object")
    for k in o:
        if k not in _BINDING_KEYS:
            return _bad(f"unknown binding field {js_stringify(k)}")
    if not _is_sha(o.get("target_identity")):
        return _bad("the binding target is malformed")
    if not isinstance(o.get("role"), str) or o["role"] not in BINDING_ROLES:
        return _bad("the binding role is unknown")
    if "revision" in o and not _is_sha(o["revision"]):
        return _bad("the binding revision is malformed")
    if "subject_hash" in o and not _is_sha(o["subject_hash"]):
        return _bad("the binding subject is malformed")
    for k in ("lineage_id", "lens"):
        if k in o and (not isinstance(o[k], str) or o[k] == ""):
            return _bad(f"the binding {k} is malformed")
    if o["role"] != "start" and ("lineage_id" not in o or "revision" not in o):
        return _bad("a lineage binding needs lineage_id and revision")
    return {"ok": True, "binding": o}


_STATE_FOR_ROLE = {
    "lens": ("reviewing",),
    "refuter": ("reviewing",),
    "complete": ("reviewing",),
    "correction": ("correction_required",),
    "validator": ("validating",),
    "acknowledge": ("approved",),
}


def _drift(field: str, message: str) -> dict:
    return {"ok": False, "code": "binding_drift", "field": field, "message": message}


def _truthy(v: Any) -> bool:
    return not (v is _U or v is None or v is False or v == 0 or v == "")


def verify_binding(value: Any, current: dict) -> dict:
    """Decodes the binding and refuses it when the candidate, the lineage revision, the state or the artifact subject moved."""
    decoded = decode_binding(value)
    if not decoded["ok"]:
        return decoded
    b = decoded["binding"]
    if b["target_identity"] != current.get("targetIdentity"):
        return _drift("target", "the candidate changed since the binding was issued")
    lineage = current.get("lineage")
    if b["role"] == "start":
        return _drift("lineage", "a lineage now exists for this candidate") if _truthy(lineage) else decoded
    if not _truthy(lineage) or lineage.get("lineage_id") != b.get("lineage_id"):
        return _drift("lineage", "the lineage of the binding is not the current one")
    if lineage.get("revision") != b.get("revision"):
        return _drift("revision", "the lineage revision changed since the binding was issued")
    if lineage.get("state") not in _STATE_FOR_ROLE[b["role"]] or (b["role"] == "acknowledge" and _truthy(lineage.get("burned"))):
        return _drift("state", f"the lineage is {'undefined' if lineage.get('state', _U) is _U else _js_string(lineage['state'])}, which no longer matches the {b['role']} binding")
    if "subject_hash" in b:
        if "lens" not in b or "commonDir" not in current:
            return _drift("subject", "the artifact subject cannot be re-derived without its lens and repository")
        try:
            subject = lens_artifact_subject(current["commonDir"], lineage, b["lens"])
        except Exception:  # noqa: BLE001
            subject = None
        if subject is None or subject.get("subject_hash") != b["subject_hash"]:
            return _drift("subject", "the artifact subject changed since the binding was issued")
    return decoded


# ---- envelope encoders ----


def encode_consent_envelope(input: dict) -> dict:
    """Consent v3 envelope. The invocations are built from the one command constant of consent.py."""
    return build_consent_envelope(input)


def _prefixed(lens: str) -> str:
    return lens if lens.startswith("review-") else f"review-{lens}"


def encode_start_envelope(outcome: dict) -> dict | None:
    """Start outcome -> envelope. A started review is the start/v4 result; the others carry the outcome schema."""
    g = lambda k: outcome.get(k, _U)  # noqa: E731
    status = g("status")
    if status == "started":
        return js_spread(g("result"))
    if status == "consent_required":
        return js_spread(g("envelope"))
    if status == "not_due":
        return _obj(
            ("schema", OUTCOME_SCHEMA), ("contract", REVIEW_CONTRACT), ("operation", "review.start"), ("outcome", "not_due"), ("reason_code", "not_due"),
            ("reason", g("reason")), ("kind", g("kind")), ("projection", g("projection")),
        )
    if status == "declined":
        return _obj(
            ("schema", OUTCOME_SCHEMA), ("contract", REVIEW_CONTRACT), ("operation", "review.start"), ("outcome", "declined"), ("reason_code", "consent_declined"),
            ("target_identity", g("target_identity")), ("projection", g("projection")), ("risk_level", g("risk_level")),
        )
    if status == "refused":
        return _obj(
            ("schema", FAILURE_SCHEMA), ("contract", REVIEW_CONTRACT), ("operation", "review.start"), ("outcome", "refused"), ("code", g("code")), ("message", g("message")),
            ("lineage_id", g("lineage_id")),
        )
    return None


def encode_capture_envelope(outcome: dict) -> dict:
    """Capture outcome -> envelope (success carries the state, the next step and the one-shot acknowledgement, if issued)."""
    g = lambda k: outcome.get(k, _U)  # noqa: E731
    if not _truthy(g("ok")):
        errors = g("errors")
        return _obj(
            ("schema", FAILURE_SCHEMA), ("contract", REVIEW_CONTRACT), ("operation", "review.capture-result"), ("outcome", "refused"), ("code", g("code")), ("message", g("message")),
            ("errors", _U if errors is _U else list(errors)), ("current_revision", g("currentRevision")),
        )
    r = outcome["record"]
    refutation, token = g("pending_refutation"), g("ackToken")
    return _obj(
        ("schema", CAPTURE_SCHEMA), ("contract", REVIEW_CONTRACT), ("operation", "review.capture-result"), ("outcome", "captured"),
        ("lineage_id", r.get("lineage_id", _U)), ("target_identity", r.get("target_identity", _U)), ("state", g("state")), ("next", g("next")), ("revision", g("revision")),
        ("pending_lenses", [_prefixed(x) for x in outcome["pending_lenses"]]),
        ("pending_refutation", _U if refutation is _U else list(refutation)),
        ("acknowledgement", _U if token is _U else _obj(("lineage_id", r.get("lineage_id", _U)), ("target_identity", r.get("target_identity", _U)), ("expected_revision", g("revision")), ("token", token))),
    )


def encode_capture_dry_run(input: dict) -> dict:
    """The capture-result dry-run acceptance (admission validated, nothing persisted)."""
    g = lambda k: input.get(k, _U)  # noqa: E731
    return _obj(
        ("schema", CAPTURE_DRY_RUN_SCHEMA), ("operation", "review/capture-result"), ("validation", "accepted"), ("lineage_id", g("lineage_id")),
        ("lens", _prefixed(input["lens"])), ("selected_order", g("selected_order")), ("subject_hash", g("subject_hash")), ("admission_decision", "completed"),
    )


def encode_ack_envelope(result: dict | AckRefusedError) -> dict:
    """Acknowledge result (or typed refusal) -> envelope. The refusal code is the AckRefusalCode."""
    if isinstance(result, AckRefusedError):
        return {"schema": FAILURE_SCHEMA, "contract": REVIEW_CONTRACT, "operation": "review.acknowledge-approved", "outcome": "refused", "code": result.code, "message": str(result)}
    receipt = result["receipt"]
    record = result["record"]
    return _obj(
        ("schema", ACK_SCHEMA), ("contract", REVIEW_CONTRACT), ("operation", "review.acknowledge-approved"), ("outcome", "acknowledged"),
        ("lineage_id", record.get("lineage_id", _U)), ("target_identity", record.get("target_identity", _U)), ("state", record.get("state", _U)), ("burned", record.get("burned", _U)),
        ("receipt", {**receipt, "selected_lenses": list(receipt["selected_lenses"])}),
    )


__all__ = [
    "REVIEW_CONTRACT", "CONSENT_SCHEMA", "STATUS_SCHEMA", "PROJECTION_SCHEMA", "REPAIR_SCHEMA", "CAPTURE_SCHEMA", "CAPTURE_DRY_RUN_SCHEMA", "ACK_SCHEMA", "OUTCOME_SCHEMA", "FAILURE_SCHEMA",
    "TRANSITION_KINDS", "TERMINAL_STOP_CODES", "RECOVERABLE_STOP_CODES", "ACTIVE_REASON_CODES", "REASON_DESCRIPTIONS", "BINDING_ROLES",
    "is_terminal_stop", "is_recoverable_stop", "forecast_for", "encode_binding", "decode_binding", "verify_binding", "encode_consent_envelope",
    "encode_start_envelope", "encode_capture_envelope", "encode_capture_dry_run", "encode_ack_envelope",
]
