"""Port of v9 review/state.spec.ts (47 tests; the loops expand to more cases here)."""
import hashlib
import json
import re

import pytest
from odd_claude.review.canonical import domain_hash
from odd_claude.review.state import (
    MAX_ADMITTED_ROLE_RESULTS,
    MAX_CORRECTION_ATTEMPTS,
    MAX_CORRECTION_CHANGED_LINES,
    STATE_SCHEMA,
    admit_lens_result,
    admit_refuter_result,
    admit_validator_result,
    approve,
    begin_validation,
    blocking_finding_ids,
    burn,
    correction_budget,
    escalate,
    finding_disposition,
    finding_id_prefix_for_lens,
    inconclusive_finding_ids,
    invalidate,
    reopen_correction,
    require_correction,
    start,
    state_revision,
    validate_state_record,
)

from review.conftest import clone

T0 = "2026-11-19T10:00:00.000Z"
T1 = "2026-11-19T10:05:00.000Z"
FIXED_TOKEN = "ab" * 32
CORRECTED_TREE = "d" * 40


def hex_(c, n=64):
    return (c * n)[:n]


def sha(c):
    return f"sha256:{hex_(c)}"


def start_input(**over):
    base = {
        "lineageId": f"review-{hex_('a', 16)}", "targetIdentity": sha("1"), "projection": "workspace", "baseTree": hex_("b", 40),
        "candidateTree": hex_("c", 40), "riskLevel": "medium", "selectedLenses": ["reliability"], "originalChangedLines": 8, "now": T0,
    }
    return {**base, **over}


def ok(r):
    assert r["ok"] is True, json.dumps(r)
    return r


def clean(lens, n="1"):
    return {"lens": lens, "findings": [], "resultHash": sha(n), "now": T0}


def severe(lens, id_):
    return {"id": id_, "lens": lens, "severity": "CRITICAL", "location": "a.ts:1", "claim": "boom"}


def start_reviewing():
    return ok(start(start_input()))["record"]


def start_approved():
    return ok(approve(ok(admit_lens_result(start_reviewing(), clean("reliability")))["record"], {"now": T1, "randomToken": lambda: FIXED_TOKEN}))


def to_correction_required():
    a = ok(admit_lens_result(start_reviewing(), {"lens": "reliability", "findings": [severe("reliability", "R3-001")], "resultHash": sha("2"), "now": T0}))["record"]
    return ok(require_correction(a, {"fixFindingIds": ["R3-001"], "now": T1}))["record"]


def to_validating():
    return ok(begin_validation(to_correction_required(), {"actualCorrectionLines": 2, "now": T1}))["record"]


STATE_BUILDERS = {
    "reviewing": start_reviewing,
    "correction_required": to_correction_required,
    "validating": to_validating,
    "approved": lambda: start_approved()["record"],
    "escalated": lambda: ok(escalate(start_reviewing(), {"reason": "x", "now": T1}))["record"],
    "invalidated": lambda: ok(invalidate(start_reviewing(), {"reason": "x", "now": T1}))["record"],
}


def mutate(rec, fn, reseal=True):
    o = clone(rec)
    fn(o)
    if reseal:
        o["revision"] = state_revision(o)
    return o


def rejects(input_, needle):
    v = validate_state_record(input_)
    assert v["ok"] is False
    assert any(re.search(needle, e) for e in v["errors"]), " | ".join(v["errors"])


def code_of(r):
    return "ok" if r["ok"] else r["refusal"]["code"]


# ---- budget vectors ----


@pytest.mark.parametrize("lines,budget", [(0, 0), (1, 2), (2, 2), (3, 2), (4, 2), (5, 3), (8, 4), (399, 200), (400, 200), (401, 200), (100000, 200)])
def test_correction_budget_vectors(lines, budget):
    assert correction_budget(lines) == budget


def test_correction_budget_rejects_negative_and_non_integer():
    for bad in (-1, 1.5):
        with pytest.raises(ValueError, match="original changed lines must be a non-negative integer"):
            correction_budget(bad)


def test_constants():
    assert (MAX_CORRECTION_ATTEMPTS, MAX_ADMITTED_ROLE_RESULTS, MAX_CORRECTION_CHANGED_LINES) == (2, 6, 200)
    assert STATE_SCHEMA == "odd-claude.review-state/v2"


def test_finding_id_prefixes_per_lens():
    assert [finding_id_prefix_for_lens(x) for x in ("risk", "readability", "reliability", "resilience", "nope")] == ["R1-", "R2-", "R3-", "R4-", ""]


# ---- start ----


def test_start_medium_reviewing_record_with_frozen_budget_and_valid_revision():
    r = ok(start(start_input()))
    rec = r["record"]
    assert rec["schema"] == STATE_SCHEMA
    assert rec["state"] == "reviewing"
    assert rec["correction_budget"] == 4
    assert rec["correction_budget_policy"] == "floor_two"
    assert rec["correction_attempts"] == 0
    assert rec["burned"] is False
    assert rec["revision"] == state_revision(rec)
    assert "ackToken" not in r
    assert validate_state_record(rec) == {"ok": True, "record": rec}


def test_start_low_risk_directly_approved_with_token_hash_never_the_raw_token():
    r = ok(start(start_input(riskLevel="low", selectedLenses=[], randomToken=lambda: FIXED_TOKEN)))
    assert r["record"]["state"] == "approved"
    assert r["ackToken"] == FIXED_TOKEN
    assert r["record"]["approved_ack_token_hash"] == domain_hash("approved-ack-token", 1, FIXED_TOKEN)
    assert FIXED_TOKEN not in json.dumps(r["record"])
    assert validate_state_record(r["record"])["ok"] is True


def test_start_high_risk_accepts_one_to_four_distinct_lenses_in_canonical_order():
    all_ = ["risk", "resilience", "readability", "reliability"]
    assert len(ok(start(start_input(riskLevel="high", selectedLenses=all_)))["record"]["selected_lenses"]) == 4
    for good in (["risk"], ["risk", "reliability"], ["resilience", "readability", "reliability"]):
        r = ok(start(start_input(riskLevel="high", selectedLenses=good)))
        assert r["record"]["selected_lenses"] == good
        assert r["record"]["state"] == "reviewing"
        assert validate_state_record(r["record"]) == {"ok": True, "record": r["record"]}
    for bad in ([], list(reversed(all_)), [*all_[:3], "risk"], ["risk", "risk"], ["risk", "bogus"], ["review-risk"], [*all_, "risk"]):
        assert start(start_input(riskLevel="high", selectedLenses=bad))["ok"] is False, bad


def test_lens_counts_per_risk():
    assert start(start_input(riskLevel="medium", selectedLenses=["risk", "reliability"]))["ok"] is False
    assert start(start_input(riskLevel="medium", selectedLenses=[]))["ok"] is False
    assert start(start_input(riskLevel="low", selectedLenses=["risk"]))["ok"] is False
    rejects(mutate(start_reviewing(), lambda o: o.update(selected_lenses=["risk", "reliability"])), "selected_lenses")
    high = ok(start(start_input(riskLevel="high", selectedLenses=["risk", "reliability"])))["record"]
    assert validate_state_record(high)["ok"] is True
    rejects(mutate(high, lambda o: o.update(selected_lenses=[])), "selected_lenses")
    rejects(mutate(high, lambda o: o.update(selected_lenses=["reliability", "risk"])), "selected_lenses")


@pytest.mark.parametrize("case", [
    {"lineageId": "review-xyz"}, {"targetIdentity": "sha256:abc"}, {"projection": "head"}, {"baseTree": "zz"},
    {"riskLevel": "medium", "selectedLenses": []}, {"riskLevel": "low", "selectedLenses": ["risk"]},
    {"riskLevel": "medium", "selectedLenses": ["bogus"]}, {"originalChangedLines": -1}, {"now": "yesterday"},
])
def test_start_rejects_bad_inputs_with_typed_refusals(case):
    r = start(start_input(**case))
    assert r["ok"] is False
    assert r["refusal"]["code"] == "invalid_input"


def test_start_refusal_messages_are_v9s():
    cases = {
        "lineageId": ("review-xyz", "lineageId must match review-<16 hex>"),
        "targetIdentity": ("x", "targetIdentity must be sha256:<64 hex>"),
        "projection": ("head", "projection must be workspace or staged"),
        "baseTree": ("zz", "baseTree must be a 40 or 64 hex tree id"),
        "candidateTree": ("zz", "candidateTree must be a 40 or 64 hex tree id"),
        "originalChangedLines": (-1, "originalChangedLines must be a non-negative integer"),
        "now": ("yesterday", "now must be a UTC RFC 3339 timestamp"),
        "riskLevel": ("extreme", "risk_level must be low, medium or high"),
    }
    for k, (v, msg) in cases.items():
        assert start(start_input(**{k: v}))["refusal"]["message"] == msg
    assert start(start_input(riskLevel="medium", selectedLenses=[]))["refusal"]["message"] == "selected_lenses must hold exactly 1 lenses for medium risk"
    assert start(start_input(riskLevel="high", selectedLenses=[]))["refusal"]["message"] == "selected_lenses must hold 1 to 4 lenses for high risk"


# ---- validation ----


@pytest.mark.parametrize("name", list(STATE_BUILDERS))
def test_validate_accepts_every_state_fixture(name):
    v = validate_state_record(json.loads(json.dumps(STATE_BUILDERS[name]())))
    assert v["ok"] is True, v


def test_validate_rejects_non_objects_unknown_fields_and_a_stale_revision():
    for x in (None, 3, "s", []):
        assert validate_state_record(x) == {"ok": False, "errors": ["record must be an object"]}
    rejects(mutate(start_reviewing(), lambda o: o.update(extra=1)), "unknown field")
    rejects(mutate(start_reviewing(), lambda o: o.update(state="approved"), False), "revision")
    rejects(mutate(start_reviewing(), lambda o: o.pop("lineage_id")), "lineage_id")


def test_validate_rejects_bad_enums_and_formats():
    base = start_reviewing()
    for key, value, needle in [
        ("schema", "other.review-state/v2", "schema"), ("state", "unreviewed", "state"), ("lineage_id", "review-ABCDEF0123456789", "lineage_id"),
        ("target_identity", "sha256:ABC", "target_identity"), ("projection", "committed", "projection"), ("base_tree", "nothex", "base_tree"),
        ("risk_level", "extreme", "risk_level"), ("selected_lenses", ["reliability", "reliability"], "selected_lenses"),
        ("selected_lenses", ["review-risk"], "selected_lenses"), ("created_at", "nope", "created_at"),
        ("updated_at", "2026-11-19T09:00:00.000Z", "updated_at"), ("correction_budget", 99, "correction_budget"),
        ("correction_budget_policy", "legacy", "correction_budget_policy"),
    ]:
        rejects(mutate(base, lambda o, k=key, v=value: o.update({k: v})), needle)


def test_validate_empty_lens_set_only_for_low_risk():
    rejects(mutate(start_reviewing(), lambda o: o.update(selected_lenses=[])), "selected_lenses")
    low = ok(start(start_input(riskLevel="low", selectedLenses=[])))["record"]
    assert validate_state_record(low)["ok"] is True


def test_validate_token_burn_attempts_and_capacity_rules():
    approved = start_approved()["record"]
    rejects(mutate(approved, lambda o: o.pop("approved_ack_token_hash")), "approved_ack_token_hash")
    rejects(mutate(approved, lambda o: o.update(approved_ack_token_hash="raw-token")), "approved_ack_token_hash")
    rejects(mutate(approved, lambda o: o.update(burned=True)), "burn_receipt")
    rejects(mutate(start_reviewing(), lambda o: o.update(burned=True, burn_receipt=sha("9"))), "burned")
    rejects(mutate(start_reviewing(), lambda o: o.update(approved_ack_token_hash=sha("9"))), "approved_ack_token_hash")
    rejects(mutate(to_validating(), lambda o: o.update(correction_attempts=3)), "correction_attempts")
    rejects(mutate(start_reviewing(), lambda o: o.update(admitted_role_results=[
        {"role": "refuter", "lens": "reliability", "result_hash": sha(str(i)), "artifact_digest": sha("f")} for i in range(7)])), "admitted_role_results")
    rejects(mutate(approved, lambda o: o.update(evidence_hash=sha("0"))), "evidence_hash")


def test_validate_state_specific_invariants():
    rejects(mutate(to_correction_required(), lambda o: o.update(fix_finding_ids=[])), "fix_finding_ids")
    rejects(mutate(to_validating(), lambda o: o.update(actual_correction_lines=999)), "actual_correction_lines")
    rejects(mutate(STATE_BUILDERS["escalated"](), lambda o: o.pop("escalation_reason")), "escalation_reason")
    rejects(mutate(STATE_BUILDERS["invalidated"](), lambda o: o.pop("invalidation_reason")), "invalidation_reason")
    rejects(mutate(start_reviewing(), lambda o: o.update(escalation_reason="x")), "escalation_reason")
    rejects(mutate(to_correction_required(), lambda o: o.pop("ledger_hash")), "ledger_hash")


def test_validate_findings_bound_to_selected_lens_prefix_and_unique():
    a = ok(admit_lens_result(start_reviewing(), {"lens": "reliability", "findings": [severe("reliability", "R3-001")], "resultHash": sha("2"), "now": T0}))["record"]
    rejects(mutate(a, lambda o: o["findings"][0].update(id="R1-001")), "findings")
    rejects(mutate(a, lambda o: o.update(findings=o["findings"] + o["findings"])), "findings")
    rejects(mutate(a, lambda o: o["findings"][0].update(severity="WHATEVER")), "findings")
    rejects(mutate(a, lambda o: o["findings"][0].update(extra=1)), "unknown field")


def test_validate_error_texts_are_v9s_for_a_few_known_breakages():
    base = start_reviewing()
    v = validate_state_record(mutate(base, lambda o: o.update(created_at="nope", correction_budget=99), True))
    assert v["errors"] == ["correction_budget does not match original_changed_lines", "created_at must be a UTC RFC 3339 timestamp"]
    assert validate_state_record(mutate(base, lambda o: o.update(extra=1)))["errors"] == ["record: unknown field extra"]
    assert validate_state_record(mutate(base, lambda o: o.pop("findings")))["errors"][0] == "record: missing field findings"
    assert validate_state_record(mutate(base, lambda o: o.update(state="approved"), False))["errors"][-1] == "revision does not match the record content"


# ---- revision ----


def test_state_revision_ignores_key_order_and_the_revision_field_itself():
    rec = start_reviewing()
    reversed_ = dict(reversed(list(rec.items())))
    assert state_revision(reversed_) == state_revision(rec)
    rest = {k: v for k, v in rec.items() if k != "revision"}
    assert state_revision(rec) == domain_hash("review-state", 2, rest)
    assert state_revision({**rec, "revision": sha("0")}) == rec["revision"]
    assert state_revision({**rec, "updated_at": T1}) != rec["revision"]
    assert validate_state_record(reversed_)["ok"] is True


# ---- transitions: legality table ----

OPS = {
    "admit_lens_result": (lambda r: admit_lens_result(r, clean("reliability")), ["reviewing"]),
    "admit_validator_result": (lambda r: admit_validator_result(r, {"resultHash": sha("7"), "now": T1}), ["validating"]),
    "require_correction": (lambda r: require_correction(r, {"fixFindingIds": ["R3-001"], "now": T1}), ["reviewing"]),
    "begin_validation": (lambda r: begin_validation(r, {"actualCorrectionLines": 2, "now": T1}), ["correction_required"]),
    "approve": (lambda r: approve(r, {"now": T1}), ["reviewing", "validating"]),
    "escalate": (lambda r: escalate(r, {"reason": "r", "now": T1}), ["reviewing", "correction_required", "validating"]),
    "invalidate": (lambda r: invalidate(r, {"reason": "r", "now": T1}), ["reviewing", "correction_required", "validating", "approved"]),
    "burn": (lambda r: burn(r, {"token": FIXED_TOKEN, "now": T1}), ["approved"]),
}


@pytest.mark.parametrize("op_name", list(OPS))
@pytest.mark.parametrize("state_name", list(STATE_BUILDERS))
def test_legality_table(op_name, state_name):
    run, legal = OPS[op_name]
    inp = STATE_BUILDERS[state_name]()
    before = json.dumps(inp)
    r = run(inp)
    assert json.dumps(inp) == before, "input never mutated"
    if state_name in legal:
        assert r["ok"] or r["refusal"]["code"] != "illegal_state"
    else:
        assert r["ok"] is False
        assert r["refusal"]["code"] == "illegal_state"


def test_illegal_state_messages():
    assert admit_lens_result(to_validating(), clean("reliability"))["refusal"]["message"] == "cannot admit a lens result from validating"
    assert burn(start_reviewing(), {"token": FIXED_TOKEN, "now": T1})["refusal"]["message"] == "cannot burn from reviewing"


# ---- transitions: behavior ----


def test_admit_lens_result_freezes_findings_binds_prefixes_and_refuses_bad_input():
    rec = start_reviewing()
    bad = [
        clean("risk"),
        {"lens": "reliability", "findings": [severe("reliability", "R1-001")], "resultHash": sha("2"), "now": T0},
        {"lens": "reliability", "findings": [severe("reliability", "R3-001"), severe("reliability", "R3-001")], "resultHash": sha("2"), "now": T0},
        {"lens": "reliability", "findings": [], "resultHash": "nope", "now": T0},
        {"lens": "reliability", "findings": [{**severe("reliability", "R3-001"), "severity": "??"}], "resultHash": sha("2"), "now": T0},
    ]
    for b in bad:
        assert admit_lens_result(rec, b)["ok"] is False
    a = ok(admit_lens_result(rec, {"lens": "reliability", "findings": [severe("reliability", "R3-001")], "resultHash": sha("2"), "now": T1}))["record"]
    assert len(a["admitted_role_results"]) == 1
    assert a["admitted_role_results"][0]["role"] == "lens"
    assert len(a["findings"]) == 1
    assert a["updated_at"] == T1
    assert a["revision"] == state_revision(a)
    dup = admit_lens_result(a, clean("reliability", "3"))
    assert dup["ok"] is False
    assert dup["refusal"]["code"] == "lens_already_admitted"


def test_approve_from_reviewing_needs_all_lenses_and_no_open_severe_findings():
    none = approve(start_reviewing(), {"now": T1})
    assert none["refusal"]["code"] == "lenses_incomplete"
    sev = ok(admit_lens_result(start_reviewing(), {"lens": "reliability", "findings": [severe("reliability", "R3-001")], "resultHash": sha("2"), "now": T0}))["record"]
    assert approve(sev, {"now": T1})["refusal"]["code"] == "severe_findings_open"


def test_approve_issues_the_raw_token_once_and_stores_only_its_domain_hash():
    a = start_approved()
    assert a["ackToken"] == FIXED_TOKEN
    assert a["record"]["approved_ack_token_hash"] == domain_hash("approved-ack-token", 1, FIXED_TOKEN)
    assert FIXED_TOKEN not in json.dumps(a["record"])
    assert a["record"]["ledger_hash"] and a["record"]["evidence_hash"]
    assert validate_state_record(a["record"])["ok"] is True


def test_approve_default_token_is_random_256_bit_hex_unique_per_call():
    base = ok(admit_lens_result(start_reviewing(), clean("reliability")))["record"]
    t1 = ok(approve(base, {"now": T1}))["ackToken"]
    t2 = ok(approve(base, {"now": T1}))["ackToken"]
    assert re.fullmatch(r"[0-9a-f]{64}", t1)
    assert t1 != t2
    assert approve(base, {"now": T1, "randomToken": lambda: "short"})["refusal"]["message"] == "acknowledgement token must be 256 bits of lowercase hex"


def test_correction_flow_severe_finding_to_approved():
    cr = to_correction_required()
    assert cr["state"] == "correction_required"
    assert cr["fix_finding_ids"] == ["R3-001"]
    assert cr["ledger_hash"]
    v = to_validating()
    assert v["correction_attempts"] == 1
    assert v["actual_correction_lines"] == 2
    assert approve(v, {"now": T1})["refusal"]["code"] == "validator_missing"
    with_v = ok(admit_validator_result(v, {"resultHash": sha("7"), "now": T1}))["record"]
    assert len(with_v["admitted_role_results"]) == 2
    assert admit_validator_result(with_v, {"resultHash": sha("8"), "now": T1})["refusal"]["code"] == "validator_already_admitted"
    done = ok(approve(with_v, {"now": T1, "randomToken": lambda: FIXED_TOKEN}))
    assert done["record"]["state"] == "approved"
    assert validate_state_record(done["record"])["ok"] is True


def test_require_correction_refusals():
    assert require_correction(start_reviewing(), {"fixFindingIds": ["R3-001"], "now": T1})["ok"] is False
    a = ok(admit_lens_result(start_reviewing(), {
        "lens": "reliability", "findings": [severe("reliability", "R3-001"), {"id": "R3-002", "lens": "reliability", "severity": "MINOR", "location": "a:1", "claim": "c"}],
        "resultHash": sha("2"), "now": T0}))["record"]
    for ids in ([], ["R3-999"], ["R3-002"], ["R3-001", "R3-001"]):
        assert require_correction(a, {"fixFindingIds": ids, "now": T1})["ok"] is False, ids
    zero = ok(start(start_input(originalChangedLines=0)))["record"]
    z = ok(admit_lens_result(zero, {"lens": "reliability", "findings": [severe("reliability", "R3-001")], "resultHash": sha("2"), "now": T0}))["record"]
    assert require_correction(z, {"fixFindingIds": ["R3-001"], "now": T1})["refusal"]["code"] == "correction_unavailable"


def test_begin_validation_refuses_over_budget_and_invalid_line_counts():
    cr = to_correction_required()
    over = begin_validation(cr, {"actualCorrectionLines": cr["correction_budget"] + 1, "now": T1})
    assert over["refusal"]["code"] == "correction_over_budget"
    assert over["refusal"]["message"] == "correction of 5 lines exceeds the budget of 4"
    assert begin_validation(cr, {"actualCorrectionLines": -1, "now": T1})["ok"] is False
    assert begin_validation(cr, {"actualCorrectionLines": 1.5, "now": T1})["ok"] is False
    assert ok(begin_validation(cr, {"actualCorrectionLines": cr["correction_budget"], "now": T1}))["record"]["state"] == "validating"


def test_escalate_and_invalidate_record_reasons_and_require_them():
    assert escalate(start_reviewing(), {"reason": "  ", "now": T1})["ok"] is False
    assert invalidate(start_reviewing(), {"reason": "", "now": T1})["ok"] is False
    e = ok(escalate(to_validating(), {"reason": "validator failed", "now": T1}))["record"]
    assert e["state"] == "escalated"
    assert e["escalation_reason"] == "validator failed"
    i = ok(invalidate(start_approved()["record"], {"reason": "scope changed", "now": T1}))["record"]
    assert i["state"] == "invalidated"
    assert i["invalidation_reason"] == "scope changed"
    assert "approved_ack_token_hash" not in i
    assert validate_state_record(i)["ok"] is True


def test_invalidate_refuses_a_burned_approval():
    a = start_approved()
    burned = ok(burn(a["record"], {"token": a["ackToken"], "now": T1}))["record"]
    r = invalidate(burned, {"reason": "x", "now": T1})
    assert r["refusal"]["code"] == "already_burned"


# ---- burn ----


def test_burn_with_the_right_token_marks_burned_with_a_receipt():
    a = start_approved()
    b = ok(burn(a["record"], {"token": a["ackToken"], "now": T1}))["record"]
    assert b["burned"] is True
    assert b["state"] == "approved"
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", b["burn_receipt"])
    assert b["updated_at"] == T1
    assert a["ackToken"] not in json.dumps(b)
    assert validate_state_record(b)["ok"] is True
    assert a["record"]["burned"] is False, "input not mutated"
    assert b["burn_receipt"] == domain_hash("review-burn-receipt", 1, {"lineage_id": b["lineage_id"], "token_hash": a["record"]["approved_ack_token_hash"], "burned_at": T1})


def test_burn_binds_the_pre_burn_revision_as_approved_revision():
    a = start_approved()
    b = ok(burn(a["record"], {"token": a["ackToken"], "now": T1}))["record"]
    assert b["approved_revision"] == a["record"]["revision"]
    assert validate_state_record(b)["ok"] is True
    assert "approved_revision" not in a["record"]
    assert validate_state_record(a["record"])["ok"] is True
    rejects(mutate(a["record"], lambda o: o.update(approved_revision=sha("9"))), "approved_revision")
    rejects(mutate(b, lambda o: o.update(approved_revision="nope")), "approved_revision")


def test_burn_with_a_wrong_or_malformed_token_is_refused_and_changes_nothing():
    a = start_approved()
    wrong = burn(a["record"], {"token": "cd" * 32, "now": T1})
    assert wrong["refusal"]["code"] == "token_mismatch"
    for t in ("", "abc", "AB" * 32, "zz" * 32, FIXED_TOKEN + "00", sha("a")):
        r = burn(a["record"], {"token": t, "now": T1})
        assert r["refusal"]["code"] == "token_malformed", t
    assert a["record"]["burned"] is False


def test_burn_twice_is_refused():
    a = start_approved()
    b = ok(burn(a["record"], {"token": a["ackToken"], "now": T1}))["record"]
    assert burn(b, {"token": a["ackToken"], "now": T1})["refusal"]["code"] == "already_burned"


def test_the_token_hash_is_a_plain_sha256_of_the_domain_separated_token():
    manual = hashlib.sha256(f'odd-claude.approved-ack-token/v1\0{json.dumps(FIXED_TOKEN)}'.encode()).hexdigest()
    assert domain_hash("approved-ack-token", 1, FIXED_TOKEN) == f"sha256:{manual}"


# ---- finding dispositions, refuter admission, correction target ----


def sev(lens, id_, **extra):
    return {**severe(lens, id_), **extra}


def test_finding_disposition():
    def f(**extra):
        return sev("reliability", "R3-001", **extra)

    assert finding_disposition({**f(), "severity": "MAJOR"}) == "clear"
    assert finding_disposition(f()) == "blocking"
    assert finding_disposition(f(evidence_class="deterministic", causal_disposition="introduced")) == "blocking"
    assert finding_disposition(f(causal_disposition="worsened")) == "blocking"
    assert finding_disposition(f(causal_disposition="pre-existing")) == "follow_up"
    assert finding_disposition(f(causal_disposition="base-only")) == "follow_up"
    assert finding_disposition(f(causal_disposition="unknown")) == "inconclusive"
    assert finding_disposition(f(evidence_class="insufficient", causal_disposition="introduced")) == "inconclusive"
    assert finding_disposition(f(), ["R3-001"]) == "refuted"
    assert finding_disposition(f(causal_disposition="unknown"), ["R3-001"]) == "inconclusive"


def test_admit_lens_result_keeps_evidence_class_and_causal_disposition_and_rejects_unknown_values():
    rec = ok(admit_lens_result(start_reviewing(), {"lens": "reliability", "findings": [sev("reliability", "R3-001", evidence_class="inferential", causal_disposition="introduced")], "resultHash": sha("2"), "now": T0}))["record"]
    assert rec["findings"][0]["evidence_class"] == "inferential"
    assert rec["findings"][0]["causal_disposition"] == "introduced"
    assert validate_state_record(rec) == {"ok": True, "record": rec}
    bad = admit_lens_result(start_reviewing(), {"lens": "reliability", "findings": [sev("reliability", "R3-001", causal_disposition="maybe")], "resultHash": sha("2"), "now": T0})
    assert bad["ok"] is False
    assert admit_lens_result(start_reviewing(), {"lens": "reliability", "findings": [sev("reliability", "R3-001", severity="WARNING")], "resultHash": sha("2"), "now": T0})["ok"] is True


def reviewed_with(*findings):
    return ok(admit_lens_result(start_reviewing(), {"lens": "reliability", "findings": list(findings), "resultHash": sha("2"), "now": T0}))["record"]


def test_approve_from_reviewing_followups_and_refuted_do_not_block_inconclusive_and_blocking_do():
    follow_up = reviewed_with(sev("reliability", "R3-001", causal_disposition="pre-existing"))
    assert blocking_finding_ids(follow_up) == []
    assert approve(follow_up, {"now": T1, "randomToken": lambda: FIXED_TOKEN})["ok"] is True
    unknown = reviewed_with(sev("reliability", "R3-001", causal_disposition="unknown"))
    assert inconclusive_finding_ids(unknown) == ["R3-001"]
    assert approve(unknown, {"now": T1})["ok"] is False
    blocking = reviewed_with(sev("reliability", "R3-001"))
    assert approve(blocking, {"now": T1})["refusal"]["code"] == "severe_findings_open"
    refuted = ok(admit_refuter_result(blocking, {"resultHash": sha("3"), "refutedFindingIds": ["R3-001"], "now": T1}))["record"]
    assert refuted["refuted_finding_ids"] == ["R3-001"]
    assert blocking_finding_ids(refuted) == []
    approved = ok(approve(refuted, {"now": T1, "randomToken": lambda: FIXED_TOKEN}))["record"]
    assert approved["state"] == "approved"
    assert validate_state_record(approved) == {"ok": True, "record": approved}


def test_admit_refuter_result_rules():
    blocking = reviewed_with(sev("reliability", "R3-001"))
    inp = {"resultHash": sha("3"), "refutedFindingIds": ["R3-001"], "now": T1}
    assert ok(admit_refuter_result(blocking, {**inp, "refutedFindingIds": []}))["record"]["refuted_finding_ids"] == []
    assert code_of(admit_refuter_result(start_reviewing(), inp)) == "lenses_incomplete"
    assert code_of(admit_refuter_result(to_correction_required(), inp)) == "illegal_state"
    assert code_of(admit_refuter_result(blocking, {**inp, "refutedFindingIds": ["R3-009"]})) == "invalid_input"
    assert code_of(admit_refuter_result(blocking, {**inp, "refutedFindingIds": ["R3-001", "R3-001"]})) == "invalid_input"
    assert code_of(admit_refuter_result(blocking, {**inp, "resultHash": "nope"})) == "invalid_input"
    once = ok(admit_refuter_result(blocking, inp))["record"]
    assert code_of(admit_refuter_result(once, inp)) == "refuter_already_admitted"
    pre = reviewed_with(sev("reliability", "R3-001", causal_disposition="pre-existing"))
    assert code_of(admit_refuter_result(pre, inp)) == "invalid_input"
    other = ok(admit_lens_result(start_reviewing(), {"lens": "reliability", "findings": [sev("reliability", "R3-001"), sev("reliability", "R3-002")], "resultHash": sha("2"), "now": T0}))["record"]
    partly = ok(admit_refuter_result(other, {**inp, "refutedFindingIds": ["R3-001"]}))["record"]
    assert code_of(require_correction(partly, {"fixFindingIds": ["R3-001"], "now": T1})) == "invalid_input"
    assert ok(require_correction(partly, {"fixFindingIds": ["R3-002"], "now": T1}))["record"]["state"] == "correction_required"


def test_validate_refuter_results_carry_no_lens_and_correction_target_needs_the_attempt():
    blocking = reviewed_with(sev("reliability", "R3-001"))
    refuted = ok(admit_refuter_result(blocking, {"resultHash": sha("3"), "refutedFindingIds": ["R3-001"], "now": T1}))["record"]
    rejects(mutate(refuted, lambda o: o.pop("refuted_finding_ids")), "refuter result requires refuted_finding_ids")
    rejects(mutate(blocking, lambda o: o.update(refuted_finding_ids=["R3-001"])), "requires an admitted refuter")
    rejects(mutate(refuted, lambda o: o["admitted_role_results"][1].update(lens="reliability")), "refuter carries no lens")
    validating = ok(begin_validation(to_correction_required(), {"actualCorrectionLines": 2, "correctionTargetIdentity": sha("4"), "now": T1}))["record"]
    assert validating["correction_target_identity"] == sha("4")
    assert validate_state_record(validating) == {"ok": True, "record": validating}
    rejects(mutate(to_correction_required(), lambda o: o.update(correction_target_identity=sha("4"))), "correction_target_identity")
    rejects(mutate(validating, lambda o: o.update(correction_target_identity="x")), "correction_target_identity")
    assert begin_validation(to_correction_required(), {"actualCorrectionLines": 2, "correctionTargetIdentity": "x", "now": T1})["ok"] is False
    inv = ok(invalidate(refuted, {"reason": "x", "now": T1}))["record"]
    assert "refuted_finding_ids" not in inv


# ---- correction: the validated corrected candidate becomes the lineage's current candidate ----


def to_approved_after_correction(with_tree=True):
    extra = {"correctionCandidateTree": CORRECTED_TREE} if with_tree else {}
    v = ok(begin_validation(to_correction_required(), {"actualCorrectionLines": 2, "correctionTargetIdentity": sha("4"), **extra, "now": T1}))["record"]
    a = ok(admit_validator_result(v, {"resultHash": sha("5"), "now": T1}))["record"]
    return ok(approve(a, {"now": T1, "randomToken": lambda: FIXED_TOKEN}))["record"]


def test_approve_after_a_validated_correction_binds_the_corrected_candidate():
    ap = to_approved_after_correction()
    assert ap["target_identity"] == sha("4")
    assert ap["candidate_tree"] == CORRECTED_TREE
    assert ap["original_target_identity"] == sha("1")
    assert ap["original_candidate_tree"] == hex_("c", 40)
    assert validate_state_record(ap) == {"ok": True, "record": ap}
    rejects(mutate(ap, lambda o: o.update(target_identity=sha("9"))), "corrected candidate")
    rejects(mutate(ap, lambda o: o.update(candidate_tree=hex_("e", 40))), "corrected candidate")
    rejects(mutate(ap, lambda o: o.pop("original_candidate_tree")), "original")
    rejects(mutate(to_correction_required(), lambda o: o.update(original_target_identity=sha("1"), original_candidate_tree=hex_("c", 40))), "original")
    assert ok(burn(ap, {"token": FIXED_TOKEN, "now": T1}))["record"]["target_identity"] == sha("4")


def test_invalidating_an_approval_after_a_correction_restores_the_reviewed_candidate():
    inv = ok(invalidate(to_approved_after_correction(), {"reason": "x", "now": T1}))["record"]
    assert inv["target_identity"] == sha("1")
    assert inv["candidate_tree"] == hex_("c", 40)
    for k in ("original_target_identity", "original_candidate_tree", "correction_candidate_tree", "correction_target_identity"):
        assert k not in inv, k
    assert validate_state_record(inv)["ok"] is True


def test_approve_refuses_a_validating_record_with_a_target_but_no_tree_and_the_callers_tree_completes_it():
    legacy = ok(begin_validation(to_correction_required(), {"actualCorrectionLines": 2, "correctionTargetIdentity": sha("4"), "now": T1}))["record"]
    admitted = ok(admit_validator_result(legacy, {"resultHash": sha("5"), "now": T1}))["record"]
    refused = approve(admitted, {"now": T1, "randomToken": lambda: FIXED_TOKEN})
    assert refused["ok"] is False
    assert refused["refusal"]["message"] == "an approval after a correction needs the corrected candidate tree (correction_candidate_tree)"
    assert approve(admitted, {"now": T1, "correctionCandidateTree": "zz"})["ok"] is False
    done = ok(approve(admitted, {"now": T1, "randomToken": lambda: FIXED_TOKEN, "correctionCandidateTree": CORRECTED_TREE}))["record"]
    assert done["target_identity"] == sha("4")
    assert done["candidate_tree"] == CORRECTED_TREE
    assert done["correction_candidate_tree"] == CORRECTED_TREE
    assert done["original_target_identity"] == sha("1")
    assert validate_state_record(done) == {"ok": True, "record": done}


def test_approved_with_correction_tree_but_no_original_is_rejected():
    ap = to_approved_after_correction()

    def drop_orig(o):
        o.pop("original_target_identity")
        o.pop("original_candidate_tree")

    rejects(mutate(ap, lambda o: (drop_orig(o), o.update(target_identity=sha("1"), candidate_tree=hex_("c", 40)))), "original")
    rejects(mutate(ap, drop_orig), "original|corrected candidate")
    rejects(mutate(ap, lambda o: (drop_orig(o), o.pop("correction_candidate_tree"), o.update(target_identity=sha("1"), candidate_tree=hex_("c", 40)))), "original|corrected candidate")


def test_escalating_a_validated_and_failed_correction_binds_the_corrected_candidate():
    v = ok(begin_validation(to_correction_required(), {"actualCorrectionLines": 2, "correctionTargetIdentity": sha("4"), "correctionCandidateTree": CORRECTED_TREE, "now": T1}))["record"]
    e = ok(escalate(v, {"reason": "still broken", "now": T1}))["record"]
    assert e["state"] == "escalated"
    assert e["target_identity"] == sha("4")
    assert e["candidate_tree"] == CORRECTED_TREE
    assert e["original_target_identity"] == sha("1")
    assert validate_state_record(e) == {"ok": True, "record": e}
    rejects(mutate(e, lambda o: (o.pop("original_target_identity"), o.pop("original_candidate_tree"))), "original|corrected candidate")
    assert ok(escalate(to_correction_required(), {"reason": "x", "now": T1}))["record"]["target_identity"] == sha("1")
    legacy = ok(begin_validation(to_correction_required(), {"actualCorrectionLines": 2, "correctionTargetIdentity": sha("4"), "now": T1}))["record"]
    le = ok(escalate(legacy, {"reason": "x", "now": T1}))["record"]
    assert le["target_identity"] == sha("1")
    assert validate_state_record(le)["ok"] is True
    assert ok(escalate(legacy, {"reason": "x", "now": T1, "correctionCandidateTree": CORRECTED_TREE}))["record"]["target_identity"] == sha("4")


def test_approve_and_escalate_refuse_a_tree_on_a_record_without_a_correction_target():
    plain = ok(begin_validation(to_correction_required(), {"actualCorrectionLines": 2, "now": T1}))["record"]
    admitted = ok(admit_validator_result(plain, {"resultHash": sha("5"), "now": T1}))["record"]
    assert approve(admitted, {"now": T1, "correctionCandidateTree": CORRECTED_TREE})["refusal"]["message"] == "correctionCandidateTree needs a record with a correction target"
    assert escalate(admitted, {"reason": "x", "now": T1, "correctionCandidateTree": CORRECTED_TREE})["ok"] is False
    assert approve(admitted, {"now": T1})["ok"] is True
    assert escalate(admitted, {"reason": "x", "now": T1})["ok"] is True


# ---- defense in depth: an unchanged correction never reaches validating ----


def test_begin_validation_refuses_an_unchanged_candidate():
    cr = to_correction_required()
    same = begin_validation(cr, {"now": T1, "actualCorrectionLines": 0, "correctionTargetIdentity": cr["target_identity"], "correctionCandidateTree": cr["candidate_tree"]})
    assert same["refusal"]["code"] == "correction_unavailable"
    assert same["refusal"]["message"] == "the corrected candidate is unchanged: make a correction before validating"
    assert code_of(begin_validation(cr, {"now": T1, "actualCorrectionLines": 0, "correctionTargetIdentity": cr["target_identity"]})) == "correction_unavailable"
    assert code_of(begin_validation(cr, {"now": T1, "actualCorrectionLines": 1, "correctionTargetIdentity": sha("4"), "correctionCandidateTree": cr["candidate_tree"]})) == "correction_unavailable"
    assert begin_validation(cr, {"now": T1, "actualCorrectionLines": 1, "correctionTargetIdentity": sha("4"), "correctionCandidateTree": hex_("d", 40)})["ok"] is True


def test_validate_rejects_a_validating_record_whose_correction_candidate_equals_the_reviewed_one():
    v = to_validating()
    with_corr = ok(begin_validation(to_correction_required(), {"now": T1, "actualCorrectionLines": 1, "correctionTargetIdentity": sha("4"), "correctionCandidateTree": hex_("d", 40)}))["record"]
    assert validate_state_record(with_corr)["ok"] is True
    rejects(mutate(with_corr, lambda o: o.update(correction_target_identity=o["target_identity"])), "unchanged|equal|same")
    rejects(mutate(with_corr, lambda o: o.update(correction_candidate_tree=o["candidate_tree"])), "unchanged|equal|same")
    rejects(mutate(v, lambda o: o.update(correction_target_identity=o["target_identity"])), "unchanged|equal|same")


def test_reopen_correction_a_failed_first_validation_reopens_the_second_cannot():
    v1 = ok(begin_validation(to_correction_required(), {"actualCorrectionLines": 2, "correctionTargetIdentity": sha("4"), "correctionCandidateTree": CORRECTED_TREE, "now": T1}))["record"]
    assert validate_state_record(v1)["ok"] is True
    r1 = ok(reopen_correction(v1, {"now": T1}))["record"]
    assert r1["state"] == "correction_required"
    assert r1["correction_attempts"] == 1
    assert r1["target_identity"] == sha("4")
    assert r1["candidate_tree"] == CORRECTED_TREE
    assert r1["original_target_identity"] == sha("1")
    for k in ("correction_target_identity", "correction_candidate_tree", "actual_correction_lines"):
        assert k not in r1, k
    assert r1["fix_finding_ids"] == v1["fix_finding_ids"]
    assert validate_state_record(r1) == {"ok": True, "record": r1}
    v2 = ok(begin_validation(r1, {"actualCorrectionLines": 1, "correctionTargetIdentity": sha("6"), "correctionCandidateTree": hex_("e", 40), "now": T1}))["record"]
    assert v2["correction_attempts"] == 2
    assert validate_state_record(v2) == {"ok": True, "record": v2}
    assert code_of(reopen_correction(v2, {"now": T1})) == "illegal_state"
    esc = ok(escalate(ok(admit_validator_result(v2, {"resultHash": sha("5"), "now": T1}))["record"], {"reason": "x", "now": T1, "correctionCandidateTree": hex_("e", 40)}))["record"]
    assert esc["original_target_identity"] == sha("1"), "the first reviewed candidate stays the history"
    assert validate_state_record(esc)["ok"] is True
    assert code_of(require_correction(esc, {"now": T1, "fixFindingIds": ["R3-001"]})) == "illegal_state"


def test_reopen_correction_refuses_without_a_corrected_tree_and_from_other_states():
    no_tree = ok(begin_validation(to_correction_required(), {"actualCorrectionLines": 2, "now": T1}))["record"]
    assert code_of(reopen_correction(no_tree, {"now": T1})) == "invalid_input"
    assert code_of(reopen_correction(start_reviewing(), {"now": T1})) == "illegal_state"
    assert code_of(reopen_correction(no_tree, {"now": T1, "correctionCandidateTree": "zz"})) == "invalid_input"


# ---- extra cases for the JS-isms the port had to reproduce ----


@pytest.mark.parametrize("ts,valid", [
    ("2026-11-19T10:00:00Z", True), ("2026-11-19T10:00:00.123456789Z", True), ("2026-02-30T00:00:00Z", True), ("2026-11-19T24:00:00Z", True),
    ("2026-11-19T24:00:01Z", False), ("2026-13-01T00:00:00Z", False), ("2026-01-32T00:00:00Z", False), ("2026-11-19T10:60:00Z", False),
    ("2026-11-19T10:00:00+00:00", False), ("2026-11-19T10:00:00", False), ("٢٠٢٦-11-19T10:00:00Z", False),
])
def test_timestamp_validation_matches_v8_date_parse(ts, valid):
    assert (start(start_input(now=ts))["ok"]) is valid


def test_a_record_with_updated_before_created_by_a_millisecond_is_rejected():
    rec = start_reviewing()
    rejects(mutate(rec, lambda o: o.update(updated_at="2026-11-19T09:59:59.999Z")), "updated_at must not precede created_at")
    assert validate_state_record(mutate(rec, lambda o: o.update(updated_at="2026-11-19T10:00:00.001Z")))["ok"] is True


def test_booleans_and_floats_do_not_pass_for_integers():
    rec = start_reviewing()
    rejects(mutate(rec, lambda o: o.update(correction_attempts=False)), "correction_attempts must be an integer")
    rejects(mutate(rec, lambda o: o.update(burned=0)), "burned must be a boolean")
    rejects(mutate(rec, lambda o: o.update(original_changed_lines=True)), "original_changed_lines must be a non-negative integer")
    assert validate_state_record(mutate(rec, lambda o: o.update(original_changed_lines=8.0)))["ok"] is True


def test_start_never_leaks_python_only_types():
    r = ok(start(start_input()))
    assert json.loads(json.dumps(r["record"])) == r["record"]
