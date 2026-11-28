"""Port of v9 review/contract.spec.ts (8 tests) plus extra cases."""
import base64
import json
import re
from pathlib import Path

import pytest
from odd_claude.review.ack import AckRefusedError
from odd_claude.review.canonical import domain_hash
from odd_claude.review.consent import CONSENT_SCHEMA, INVOCATION_PREFIX, REVIEW_CONTRACT, off_path_command, review_command
from odd_claude.review.contract import (
    ACK_SCHEMA, ACTIVE_REASON_CODES, BINDING_ROLES, CAPTURE_DRY_RUN_SCHEMA, CAPTURE_SCHEMA, FAILURE_SCHEMA, OUTCOME_SCHEMA, PROJECTION_SCHEMA,
    REASON_DESCRIPTIONS, RECOVERABLE_STOP_CODES, REPAIR_SCHEMA, STATUS_SCHEMA, TERMINAL_STOP_CODES, TRANSITION_KINDS, decode_binding, encode_ack_envelope,
    encode_binding, encode_capture_dry_run, encode_capture_envelope, encode_consent_envelope, encode_start_envelope, forecast_for, is_recoverable_stop,
    is_terminal_stop, verify_binding,
)
from odd_claude.review.schema import ValidateOptions, validate
from odd_claude.review.start import START_SCHEMA

from review.conftest import INTEGRATION_ROOT, clone

V2 = INTEGRATION_ROOT / "v2" / "schemas"
UPSTREAM = "-".join(["gentle", "ai"])  # vendored ids carry the upstream product prefix


def sha(c):
    return "sha256:" + c * 64


def rec(**over):
    return {"lineage_id": "review-0123456789abcdef", "revision": sha("a"), "target_identity": sha("b"), "state": "reviewing", "burned": False, **over}


BINDING = {"role": "lens", "lens": "risk", "target_identity": sha("b"), "lineage_id": "review-0123456789abcdef", "revision": sha("a")}


def failure_of(r):
    return None if r["ok"] else {"code": r["code"], "field": r.get("field")}


def load(i):
    return json.loads(Path(i).read_text(encoding="utf-8").replace(f"{UPSTREAM}.review", "odd-claude.review"))


def check(file, patch, value):
    path = str(V2 / file)
    schema = clone(load(path))
    patch(schema)
    return validate(schema, value, ValidateOptions(base=path, load=load))


def test_stop_reason_codes_terminal_and_recoverable_are_disjoint_typed_and_described():
    allc = [*TERMINAL_STOP_CODES, *RECOVERABLE_STOP_CODES]
    assert len(set(allc)) == len(allc)
    for c in TERMINAL_STOP_CODES:
        assert (is_terminal_stop(c), is_recoverable_stop(c)) == (True, False)
    for c in RECOVERABLE_STOP_CODES:
        assert (is_terminal_stop(c), is_recoverable_stop(c)) == (False, True)
    for c in ("not_due", "escalated", "invalidated", "target_already_acknowledged", "correction_budget_exhausted"):
        assert c in allc
    for code, text in REASON_DESCRIPTIONS.items():
        assert re.fullmatch(r"[a-z0-9_]+", code) and text != ""
    assert set(REASON_DESCRIPTIONS) == {*allc, *ACTIVE_REASON_CODES}
    assert forecast_for("stop", "escalated")["horizon"] == "terminal"
    assert forecast_for("collect", "reviewer_results_required")["steps"] == [
        {"step": 1, "kind": "collect", "reason_code": "reviewer_results_required", "description": REASON_DESCRIPTIONS["reviewer_results_required"]}
    ]
    assert forecast_for("execute", "fresh_target_ready")["horizon"] == "partial"
    assert TRANSITION_KINDS == ("execute", "collect", "stop") and BINDING_ROLES[0] == "start" and len(BINDING_ROLES) == 7


def test_schema_constants():
    assert (STATUS_SCHEMA, PROJECTION_SCHEMA, REPAIR_SCHEMA, CAPTURE_SCHEMA, CAPTURE_DRY_RUN_SCHEMA, ACK_SCHEMA, OUTCOME_SCHEMA, FAILURE_SCHEMA) == (
        "odd-claude.review-integration.status/v5", "odd-claude.review-integration.projection/v1", "odd-claude.review-authority-repair-assessment/v1",
        "odd-claude.review-integration.capture/v1", "odd-claude.review-capture-result-dry-run/v1", "odd-claude.review-integration.review-acknowledged/v1",
        "odd-claude.review-integration.start-outcome/v1", "odd-claude.review-integration.failure/v2",
    )


def test_binding_round_trip_opaque_deterministic_signed_with_a_domain_hash():
    s = encode_binding(BINDING)
    assert re.fullmatch(r"odd1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}", s)
    assert encode_binding(dict(BINDING)) == s
    d = decode_binding(s)
    assert d["ok"] and d["binding"] == BINDING
    assert verify_binding(s, {"targetIdentity": sha("b"), "lineage": rec()})["ok"] is True
    payload = s.split(".")[1]
    assert s.split(".")[2] == domain_hash("transition-binding", 1, payload)[7:]
    assert base64.urlsafe_b64decode(payload + "==") == json.dumps(BINDING, sort_keys=True, separators=(",", ":")).encode()


def test_binding_tampering_foreign_strings_and_malformed_payloads_are_invalid_binding():
    s = encode_binding(BINDING)
    p, payload, tag = s.split(".")
    forged = base64.urlsafe_b64encode(json.dumps({**BINDING, "revision": sha("c")}).encode()).rstrip(b"=").decode()
    for bad in (f"{p}.{forged}.{tag}", f"{p}.{payload}.{'0' * 64}", "nope", f"{p}.{payload}", 5, None, f"gentle1.{payload}.{tag}", f"{p}.{payload}\n.{tag}"):
        r = decode_binding(bad)
        assert r["ok"] is False and r["code"] == "invalid_binding", str(bad)
    assert decode_binding(encode_binding({"role": "lens", "target_identity": sha("b")}))["ok"] is False
    assert decode_binding(encode_binding({**BINDING, "extra": 1}))["ok"] is False


def test_binding_failure_messages_are_exact():
    msg = lambda v: decode_binding(v)["message"]  # noqa: E731
    assert msg(5) == "the binding must be a string"
    assert msg("nope") == "the binding is not an odd-claude transition binding"
    s = encode_binding(BINDING)
    assert msg(s[:-1] + "0") == "the binding signature does not verify"
    assert msg(encode_binding({**BINDING, "extra": 1})) == 'unknown binding field "extra"'
    assert msg(encode_binding({"role": "lens", "target_identity": sha("b")})) == "a lineage binding needs lineage_id and revision"
    assert msg(encode_binding({**BINDING, "role": "x"})) == "the binding role is unknown"
    assert msg(encode_binding({**BINDING, "target_identity": "x"})) == "the binding target is malformed"
    assert msg(encode_binding({**BINDING, "revision": "x"})) == "the binding revision is malformed"
    assert msg(encode_binding({**BINDING, "subject_hash": "x"})) == "the binding subject is malformed"
    assert msg(encode_binding({**BINDING, "lens": ""})) == "the binding lens is malformed"
    # a correctly tagged payload that is not an object / not JSON
    for raw, want in ((b"[1]", "the binding payload is not an object"), (b"nope", "the binding payload is not JSON")):
        pl = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
        assert msg(f"odd1.{pl}.{domain_hash('transition-binding', 1, pl)[7:]}") == want


def test_binding_drift_target_lineage_revision_state_and_subject_are_refused_with_a_typed_field():
    s = encode_binding(BINDING)
    cur = {"targetIdentity": sha("b"), "lineage": rec()}
    assert failure_of(verify_binding(s, {**cur, "targetIdentity": sha("d")})) == {"code": "binding_drift", "field": "target"}
    assert failure_of(verify_binding(s, {**cur, "lineage": None})) == {"code": "binding_drift", "field": "lineage"}
    assert failure_of(verify_binding(s, {**cur, "lineage": rec(lineage_id="review-ffffffffffffffff")})) == {"code": "binding_drift", "field": "lineage"}
    assert failure_of(verify_binding(s, {**cur, "lineage": rec(revision=sha("e"))})) == {"code": "binding_drift", "field": "revision"}
    assert failure_of(verify_binding(s, {**cur, "lineage": rec(state="escalated")})) == {"code": "binding_drift", "field": "state"}
    with_subject = encode_binding({**BINDING, "subject_hash": sha("9")})
    assert failure_of(verify_binding(with_subject, cur)) == {"code": "binding_drift", "field": "subject"}
    assert failure_of(verify_binding(with_subject, {**cur, "commonDir": "/nonexistent-odd-claude-dir"})) == {"code": "binding_drift", "field": "subject"}
    ack = encode_binding({**BINDING, "role": "acknowledge"})
    assert verify_binding(ack, {**cur, "lineage": rec(state="approved")})["ok"] is True
    assert failure_of(verify_binding(ack, {**cur, "lineage": rec(state="approved", burned=True)})) == {"code": "binding_drift", "field": "state"}
    start_b = encode_binding({"role": "start", "target_identity": sha("b")})
    assert verify_binding(start_b, {"targetIdentity": sha("b")})["ok"] is True
    assert failure_of(verify_binding(start_b, cur)) == {"code": "binding_drift", "field": "lineage"}
    assert verify_binding("junk", cur)["code"] == "invalid_binding"


def test_consent_envelope_one_command_constant_invocations_derive_from_it():
    assert INVOCATION_PREFIX == "review_answer_consent"
    assert review_command("start") == "review_start"
    assert re.fullmatch(r"node .*[\\/]dist[\\/]cli[\\/]review-mode\.js disable", off_path_command())
    assert "<plugin>" not in off_path_command()
    env = encode_consent_envelope({"cwd": "/r", "targetIdentity": sha("b"), "projection": "workspace", "riskLevel": "high", "changedFiles": 1, "changedLines": 2, "riskEvidence": ["e"], "targetArgs": ["--target", "current-changes"]})
    assert env["schema"] == CONSENT_SCHEMA
    for c in env["choices"]:
        assert c["invocation"].startswith(f"{INVOCATION_PREFIX} --contract {REVIEW_CONTRACT} ")

    def patch(s):
        s["properties"]["off_path"]["properties"]["command"]["const"] = off_path_command()
        s["$defs"]["choice"]["properties"]["invocation"]["pattern"] = "^review_answer_consent --contract odd-claude\\.review-integration/v2 .+ --consent (granted|declined)$"

    assert check("consent-v3.schema.json", patch, encode_start_envelope({"status": "consent_required", "envelope": env})) == []


START_RESULT = {
    "schema": START_SCHEMA, "contract": REVIEW_CONTRACT, "operation": "review.start", "action": "created", "lenses_required": True, "lineage_id": "review-0123456789abcdef", "state": "reviewing",
    "risk_level": "high", "selected_lenses": ["review-risk"], "projection": "workspace", "target_identity": sha("b"), "base_tree": "1" * 40, "candidate_tree": "2" * 40,
    "changed_files": 1, "changed_lines": 2, "correction_budget": 2, "risk_reasons": [{"code": "shell_source"}], "artifact_subjects": [],
}


def test_start_envelopes_started_is_the_start_v4_result_other_outcomes_are_typed():
    out = encode_start_envelope({"status": "started", "result": START_RESULT})
    assert out == START_RESULT and out is not START_RESULT
    nd = encode_start_envelope({"status": "not_due", "reason": "no_changes", "kind": "current-changes", "projection": "workspace"})
    assert nd == {"schema": OUTCOME_SCHEMA, "contract": REVIEW_CONTRACT, "operation": "review.start", "outcome": "not_due", "reason_code": "not_due", "reason": "no_changes", "kind": "current-changes", "projection": "workspace"}
    dec = encode_start_envelope({"status": "declined", "target_identity": sha("b"), "projection": "workspace", "risk_level": "high", "record_path": "/p"})
    assert dec == {"schema": OUTCOME_SCHEMA, "contract": REVIEW_CONTRACT, "operation": "review.start", "outcome": "declined", "reason_code": "consent_declined", "target_identity": sha("b"), "projection": "workspace", "risk_level": "high"}
    refused = encode_start_envelope({"status": "refused", "code": "target_already_acknowledged", "message": "m", "lineage_id": "review-0123456789abcdef"})
    assert (refused["code"], refused["lineage_id"], refused["outcome"], refused["schema"]) == ("target_already_acknowledged", "review-0123456789abcdef", "refused", FAILURE_SCHEMA)
    assert "lineage_id" not in encode_start_envelope({"status": "refused", "code": "invalid_input", "message": "m"})
    assert encode_start_envelope({"status": "weird"}) is None


def test_capture_envelopes_dry_run_validates_against_the_vendored_schema_results_and_refusals_are_typed():
    dry = encode_capture_dry_run({"lineage_id": "review-0123456789abcdef", "lens": "risk", "selected_order": 0, "subject_hash": sha("1")})
    assert dry["schema"] == CAPTURE_DRY_RUN_SCHEMA and dry["lens"] == "review-risk"
    assert check("capture-result-dry-run.schema.json", lambda s: None, dry) == []
    assert encode_capture_dry_run({"lineage_id": "x", "lens": "review-risk", "selected_order": 1, "subject_hash": "h"})["lens"] == "review-risk"
    ok = encode_capture_envelope({"ok": True, "state": "approved", "next": "approved", "ackToken": "f" * 64, "revision": sha("a"), "record": rec(state="approved"), "pending_lenses": ["resilience"]})
    assert [ok["outcome"], ok["state"], ok["next"], ok["pending_lenses"]] == ["captured", "approved", "approved", ["review-resilience"]]
    assert ok["acknowledgement"] == {"lineage_id": "review-0123456789abcdef", "target_identity": sha("b"), "expected_revision": sha("a"), "token": "f" * 64}
    no_token = encode_capture_envelope({"ok": True, "state": "reviewing", "next": "collect", "revision": sha("a"), "record": rec(), "pending_lenses": []})
    assert "acknowledgement" not in no_token and "pending_refutation" not in no_token
    ref = encode_capture_envelope({"ok": True, "state": "reviewing", "next": "collect", "revision": sha("a"), "record": rec(), "pending_lenses": [], "pending_refutation": ["f1"]})
    assert ref["pending_refutation"] == ["f1"]
    refused = encode_capture_envelope({"ok": False, "code": "concurrent_update", "message": "m", "currentRevision": sha("c")})
    assert [refused["outcome"], refused["code"], refused["current_revision"]] == ["refused", "concurrent_update", sha("c")]
    with_errors = encode_capture_envelope({"ok": False, "code": "invalid_input", "message": "m", "errors": ["e1"]})
    assert with_errors["errors"] == ["e1"] and "current_revision" not in with_errors


def test_acknowledge_envelopes_acknowledged_carries_the_receipt_refusals_keep_the_typed_code():
    receipt = {
        "schema": "odd-claude.review-receipt/v1", "lineage_id": "review-0123456789abcdef", "target_identity": sha("b"), "projection": "workspace", "base_tree": "1" * 40, "candidate_tree": "2" * 40,
        "approved_revision": sha("a"), "burned_at": "2026-11-19T10:00:00.000Z", "selected_lenses": ["risk"], "risk_level": "high", "ledger_hash": sha("3"), "evidence_hash": sha("4"),
        "burn_receipt": sha("5"), "receipt_hash": sha("6"),
    }
    env = encode_ack_envelope({"ok": True, "record": rec(state="approved", burned=True), "receipt": receipt})
    assert [env["schema"], env["outcome"], env["burned"], env["operation"]] == [ACK_SCHEMA, "acknowledged", True, "review.acknowledge-approved"]
    assert env["receipt"] == receipt and env["receipt"] is not receipt and env["receipt"]["selected_lenses"] is not receipt["selected_lenses"]
    refused = encode_ack_envelope(AckRefusedError("wrong_token", "bad"))
    assert refused == {"schema": FAILURE_SCHEMA, "contract": REVIEW_CONTRACT, "operation": "review.acknowledge-approved", "outcome": "refused", "code": "wrong_token", "message": "acknowledge refused (wrong_token): bad"}
