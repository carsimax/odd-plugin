"""Differential tests of review/state.py against the compiled v9 module `dist/review/state.js` (JSON-only inputs).

Every exported function is compared on hand-picked cases plus generated families: each valid state record with every
top-level field removed / replaced by weird JSON values (validator), and every transition on every state record with each
input key removed / replaced by weird values. `approve` and `start` mint a random token, so those results are compared with
the token-dependent fields removed (and the token and its hash checked separately)."""
import json

import pytest
from lib.v9_oracle import needs_v9, v9_many
from odd_claude.review import state as py
from odd_claude.review.canonical import domain_hash

from review.conftest import clone, py_oracle_err

pytestmark = needs_v9

T0 = "2026-11-19T10:00:00.000Z"
T1 = "2026-11-19T10:05:00.000Z"
TOKEN = "ab" * 32


def sha(c):
    return "sha256:" + (c * 64)[:64]


def tree(c, n=40):
    return (c * n)[:n]


WEIRD = [None, True, False, 0, 1, 2, -1, 1.5, "", "x", "0", [], ["a"], {}, {"a": 1}, sha("9"), tree("9"), T1, "R3-001", "review-" + "9" * 16]


def v9_chunked(fn, calls, max_bytes=90_000):
    out, chunk, size = [], [], 0
    for c in calls:
        n = len(json.dumps(c))
        if chunk and size + n > max_bytes:
            out += v9_many("review/state", fn, chunk)
            chunk, size = [], 0
        chunk.append(c)
        size += n
    if chunk:
        out += v9_many("review/state", fn, chunk)
    return out


def norm(x):
    """Removes what a random token changes (ackToken, its hash, and the revision that covers it)."""
    if isinstance(x, dict) and isinstance(x.get("record"), dict) and "ackToken" in x:
        r = {k: v for k, v in x["record"].items() if k not in ("approved_ack_token_hash", "revision")}
        return {**{k: v for k, v in x.items() if k not in ("ackToken", "record")}, "record": r, "_token": bool(x["ackToken"])}
    return x


def compare(fn_v9, fn_py, calls, normalize=None):
    want = v9_chunked(fn_v9, calls)
    assert len(want) == len(calls)
    bad = []
    for args, w in zip(calls, want):
        g = py_oracle_err(fn_py, *clone(args))
        if normalize:
            g, w = normalize(g), normalize(w)
        if g != w:
            bad.append(f"{fn_v9}{json.dumps(args)[:300]}: python={json.dumps(g)[:300]} v9={json.dumps(w)[:300]}")
    assert not bad, f"{len(bad)} divergences, first: {bad[0]}"


# ---- the records ----


def ok(r):
    assert r["ok"], r
    return r


def severe(lens, id_, **extra):
    return {"id": id_, "lens": lens, "severity": "CRITICAL", "location": "a.ts:1", "claim": "boom", **extra}


def mk_start(**over):
    base = {"lineageId": "review-" + "a" * 16, "targetIdentity": sha("1"), "projection": "workspace", "baseTree": tree("b"), "candidateTree": tree("c"),
            "riskLevel": "medium", "selectedLenses": ["reliability"], "originalChangedLines": 8, "now": T0}
    return {**base, **over}


def build_records():
    R = {}
    rev = ok(py.start(mk_start()))["record"]
    R["reviewing"] = rev

    def lens(r, findings, h="2", now=T0, lens_="reliability"):
        return ok(py.admit_lens_result(r, {"lens": lens_, "findings": findings, "resultHash": sha(h), "now": now}))["record"]

    R["reviewing_clean"] = lens(rev, [])
    R["blocking"] = lens(rev, [severe("reliability", "R3-001"), {"id": "R3-002", "lens": "reliability", "severity": "MINOR", "location": "x", "claim": "y"}])
    R["pre_existing"] = lens(rev, [severe("reliability", "R3-001", causal_disposition="pre-existing", evidence_class="deterministic")])
    R["unknown"] = lens(rev, [severe("reliability", "R3-001", causal_disposition="unknown")])
    R["refuted"] = ok(py.admit_refuter_result(R["blocking"], {"resultHash": sha("3"), "refutedFindingIds": ["R3-001"], "artifactDigest": sha("8"), "now": T1}))["record"]
    cr = ok(py.require_correction(R["blocking"], {"fixFindingIds": ["R3-001"], "now": T1}))["record"]
    R["correction_required"] = cr
    R["validating"] = ok(py.begin_validation(cr, {"actualCorrectionLines": 2, "now": T1}))["record"]
    v1 = ok(py.begin_validation(cr, {"actualCorrectionLines": 2, "correctionTargetIdentity": sha("4"), "correctionCandidateTree": tree("d"), "now": T1}))["record"]
    R["validating_target"] = v1
    R["validating_target_no_tree"] = ok(py.begin_validation(cr, {"actualCorrectionLines": 2, "correctionTargetIdentity": sha("4"), "now": T1}))["record"]
    R["validating_admitted"] = ok(py.admit_validator_result(R["validating"], {"resultHash": sha("5"), "now": T1}))["record"]
    R["validating_target_admitted"] = ok(py.admit_validator_result(v1, {"resultHash": sha("5"), "now": T1}))["record"]
    R["reopened"] = ok(py.reopen_correction(v1, {"now": T1}))["record"]
    v2 = ok(py.begin_validation(R["reopened"], {"actualCorrectionLines": 1, "correctionTargetIdentity": sha("6"), "correctionCandidateTree": tree("e"), "now": T1}))["record"]
    R["validating2"] = v2
    R["approved_clean"] = ok(py.approve(R["reviewing_clean"], {"now": T1, "randomToken": lambda: TOKEN}))["record"]
    R["approved_after_correction"] = ok(py.approve(R["validating_target_admitted"], {"now": T1, "randomToken": lambda: TOKEN}))["record"]
    R["burned"] = ok(py.burn(R["approved_clean"], {"token": TOKEN, "now": T1}))["record"]
    R["escalated"] = ok(py.escalate(R["reviewing"], {"reason": "r", "now": T1}))["record"]
    R["escalated_corrected"] = ok(py.escalate(R["validating_target_admitted"], {"reason": "r", "now": T1}))["record"]
    R["invalidated"] = ok(py.invalidate(R["approved_after_correction"], {"reason": "r", "now": T1}))["record"]
    R["low_approved"] = ok(py.start(mk_start(riskLevel="low", selectedLenses=[], randomToken=lambda: TOKEN)))["record"]
    R["high_four"] = ok(py.start(mk_start(riskLevel="high", selectedLenses=["risk", "resilience", "readability", "reliability"])))["record"]
    R["zero_lines"] = ok(py.start(mk_start(originalChangedLines=0)))["record"]
    return R


RECORDS = build_records()


# ---- hand-picked functions ----


def test_correction_budget():
    vals = [0, 1, 2, 3, 4, 5, 8, 399, 400, 401, 100000, 2**53 - 1, 2**53, -1, 1.5, 4.0, "3", None, True, [], {}, 1e21, -0.0]
    compare("correctionBudget", py.correction_budget, [[v] for v in vals])


def test_finding_id_prefix_for_lens():
    compare("findingIdPrefixForLens", py.finding_id_prefix_for_lens, [[v] for v in ["risk", "readability", "reliability", "resilience", "nope", "", 3, None, [], {}]])
    # Known divergence, pinned: v9 looks the lens up on a plain object, so "constructor", "toString" and "__proto__" return a
    # function or object instead of a string; Python returns "" for every unknown lens (no caller passes an unvalidated lens).
    assert [py.finding_id_prefix_for_lens(x) for x in ("constructor", "toString", "__proto__")] == ["", "", ""]


def test_finding_disposition():
    calls = []
    for sev in ["BLOCKER", "CRITICAL", "MAJOR", "MINOR", "x", None]:
        for ec in [None, "deterministic", "inferential", "insufficient"]:
            for cd in [None, "introduced", "worsened", "pre-existing", "base-only", "unknown", "behavior-activated"]:
                f = {"id": "R3-001", "lens": "reliability", "severity": sev, "location": "a", "claim": "c"}
                if ec:
                    f["evidence_class"] = ec
                if cd:
                    f["causal_disposition"] = cd
                calls += [[f], [f, []], [f, ["R3-001"]], [f, ["R3-002"]]]
    compare("findingDisposition", py.finding_disposition, calls)


@pytest.mark.parametrize("fn_v9,fn_py", [("blockingFindingIds", py.blocking_finding_ids), ("inconclusiveFindingIds", py.inconclusive_finding_ids)])
def test_finding_id_lists(fn_v9, fn_py):
    compare(fn_v9, fn_py, [[r] for r in RECORDS.values()])


def test_state_revision():
    calls = [[r] for r in RECORDS.values()] + [[{}], [{"revision": "x"}], [{"b": 1, "a": [1, {"z": None}]}], [{"a": 1.5e300}], [{"é": "ünï", "😀": 1}]]
    compare("stateRevision", py.state_revision, calls)


# ---- validateStateRecord ----


def mutations(rec):
    for k in list(rec):
        yield {x: v for x, v in rec.items() if x != k}
        for w in WEIRD:
            yield {**rec, k: w}
    yield {**rec, "extra": 1}


def test_validate_state_record_on_every_record_and_mutation():
    calls = []
    for r in RECORDS.values():
        calls.append([r])
        for m in mutations(r):
            calls.append([m])
            sealed = dict(m)
            try:
                sealed["revision"] = py.state_revision(sealed)
                calls.append([sealed])
            except Exception:  # noqa: BLE001
                pass
    calls += [[x] for x in (None, 3, "s", [], True, {}, [1], {"schema": py.STATE_SCHEMA})]
    assert len(calls) > 4000
    compare("validateStateRecord", py.validate_state_record, calls)


def test_validate_state_record_nested_mutations():
    calls = []
    for name in ("blocking", "refuted", "validating_target_admitted", "approved_after_correction", "reopened"):
        r = RECORDS[name]
        for key in ("findings", "admitted_role_results"):
            for i, entry in enumerate(r[key]):
                for k in list(entry):
                    for w in [None, "x", 1, [], sha("9"), "R1-001"] + ([m for m in ("BLOCKER", "bogus")] if k == "severity" else []):
                        rr = clone(r)
                        rr[key][i][k] = w
                        calls += [[rr]]
                    rr = clone(r)
                    del rr[key][i][k]
                    calls += [[rr]]
                rr = clone(r)
                rr[key][i]["extra"] = 1
                calls += [[rr]]
                rr = clone(r)
                rr[key].append(clone(rr[key][i]))
                calls += [[rr]]
            rr = clone(r)
            rr[key] = "x"
            calls += [[rr]]
            rr = clone(r)
            rr[key] = [1, None, []]
            calls += [[rr]]
        for key in ("fix_finding_ids", "refuted_finding_ids", "selected_lenses"):
            for w in (["R3-002", "R3-001"], ["R3-001", "R3-001"], [1], ["R3-009"], [], "x"):
                rr = clone(r)
                rr[key] = w
                calls += [[rr]]
    # every lens-set / risk combination, unsorted ids, odd timestamps
    for risk in ("low", "medium", "high", "x"):
        for lenses in ([], ["risk"], ["risk", "reliability"], ["reliability", "risk"], ["risk", "resilience", "readability", "reliability"], ["bogus"], "risk"):
            rr = clone(RECORDS["reviewing"])
            rr["risk_level"], rr["selected_lenses"] = risk, lenses
            calls += [[rr]]
    for ts in ("2026-02-30T00:00:00Z", "2026-11-19T24:00:00Z", "2026-11-19T24:00:00.5Z", "2026-13-01T00:00:00Z", "2026-11-19T10:00:00.123456789Z", "0000-01-01T00:00:00Z", "9999-12-31T23:59:59.999Z", "2026-11-19T10:00:00+00:00"):
        for key in ("created_at", "updated_at"):
            rr = clone(RECORDS["reviewing"])
            rr[key] = ts
            calls += [[rr]]
    compare("validateStateRecord", py.validate_state_record, calls)


# ---- transitions ----


OPS = {
    "admitLensResult": (py.admit_lens_result, {"lens": "reliability", "findings": [severe("reliability", "R3-005")], "resultHash": sha("7"), "artifactDigest": sha("6"), "now": T1}),
    "admitValidatorResult": (py.admit_validator_result, {"resultHash": sha("7"), "artifactDigest": sha("6"), "now": T1}),
    "admitRefuterResult": (py.admit_refuter_result, {"resultHash": sha("7"), "artifactDigest": sha("6"), "refutedFindingIds": ["R3-001"], "now": T1}),
    "requireCorrection": (py.require_correction, {"fixFindingIds": ["R3-001"], "now": T1}),
    "beginValidation": (py.begin_validation, {"actualCorrectionLines": 2, "correctionTargetIdentity": sha("4"), "correctionCandidateTree": tree("d"), "now": T1}),
    "approve": (py.approve, {"now": T1, "correctionCandidateTree": tree("d")}),
    "reopenCorrection": (py.reopen_correction, {"now": T1, "correctionCandidateTree": tree("d")}),
    "escalate": (py.escalate, {"reason": "because", "now": T1, "correctionCandidateTree": tree("d")}),
    "invalidate": (py.invalidate, {"reason": "because", "now": T1}),
    "burn": (py.burn, {"token": TOKEN, "now": T1}),
}


def input_variants(base):
    yield base
    yield {}
    for k in base:
        yield {x: v for x, v in base.items() if x != k}
        for w in WEIRD:
            yield {**base, k: w}


@pytest.mark.parametrize("op", list(OPS))
def test_transition_vs_v9_on_every_record_and_input_variant(op):
    fn_py, base = OPS[op]
    calls = [[r, i] for r in RECORDS.values() for i in input_variants(base)]
    assert len(calls) > 800
    compare(op, fn_py, calls, normalize=norm if op == "approve" else None)


def test_transition_extra_inputs():
    calls = []
    for r in RECORDS.values():
        for fids in (["R3-001", "R3-002"], ["R3-002", "R3-001"], ["R3-001", "R3-001"], [], "R3-001", [1], [None], ["R3-009"], ["R3-002"]):
            calls.append([r, {"fixFindingIds": fids, "now": T1}])
        for lines in (0, 1, 4, 5, 200, 1.5, -1, "2", None, 2**53):
            calls.append([r, {"actualCorrectionLines": lines, "now": T1}])
            calls.append([r, {"actualCorrectionLines": lines, "correctionTargetIdentity": r["target_identity"], "now": T1}])
            calls.append([r, {"actualCorrectionLines": lines, "correctionCandidateTree": r["candidate_tree"], "correctionTargetIdentity": sha("4"), "now": T1}])
        for reason in ("x", "  x  ", "   ", "", " ", "\u0085x", "﻿", 1, None):
            calls.append([r, {"reason": reason, "now": T1}])
        for ids in (["R3-001"], [], ["R3-009"], ["R3-001", "R3-001"], "x"):
            calls.append([r, {"resultHash": sha("3"), "refutedFindingIds": ids, "now": T1}])
    compare("requireCorrection", py.require_correction, [c for c in calls if "fixFindingIds" in c[1]])
    compare("beginValidation", py.begin_validation, [c for c in calls if "actualCorrectionLines" in c[1]])
    compare("escalate", py.escalate, [c for c in calls if "reason" in c[1]])
    compare("invalidate", py.invalidate, [c for c in calls if "reason" in c[1]])
    compare("admitRefuterResult", py.admit_refuter_result, [c for c in calls if "refutedFindingIds" in c[1]])


def test_admit_lens_result_finding_shapes():
    calls = []
    base = {"id": "R3-001", "lens": "reliability", "severity": "CRITICAL", "location": "a", "claim": "c"}
    for mutate in [{}, {"id": "R1-001"}, {"id": "R3-"}, {"id": "R3-é"}, {"id": "R3-a.b_c-d"}, {"id": 3}, {"lens": "risk"}, {"severity": "WARNING"}, {"severity": "nope"},
                   {"location": 1}, {"claim": None}, {"evidence_class": "deterministic"}, {"evidence_class": "x"}, {"causal_disposition": "unknown"}, {"causal_disposition": 1}, {"extra": 1}]:
        calls.append([RECORDS["reviewing"], {"lens": "reliability", "findings": [{**base, **mutate}], "resultHash": sha("2"), "now": T0}])
    for findings in ([], [1], [None], "x", None, {}, [base, base], [base, {**base, "id": "R3-002"}], [[]]):
        calls.append([RECORDS["reviewing"], {"lens": "reliability", "findings": findings, "resultHash": sha("2"), "now": T0}])
    for lens in ("risk", "reliability", "", None, 1, ["reliability"], {"a": 1}):
        calls.append([RECORDS["reviewing"], {"lens": lens, "findings": [], "resultHash": sha("2"), "now": T0}])
    compare("admitLensResult", py.admit_lens_result, calls)


# ---- start ----


def start_variants():
    base = mk_start()
    yield base
    yield {}
    for k in base:
        yield {x: v for x, v in base.items() if x != k}
        for w in WEIRD:
            yield {**base, k: w}
    for risk, lenses in [("low", []), ("low", ["risk"]), ("medium", ["risk"]), ("medium", []), ("high", []), ("high", ["risk", "reliability"]), ("high", ["reliability", "risk"]),
                         ("high", ["risk", "resilience", "readability", "reliability"]), ("high", ["risk"] * 5), ("high", ["bogus"])]:
        yield {**base, "riskLevel": risk, "selectedLenses": lenses}
    for n in (0, 1, 2, 3, 5, 399, 401, 2**53 - 1, 2**53, 8.0, 8.5):
        yield {**base, "originalChangedLines": n}
    for ts in ("2026-02-30T00:00:00Z", "2026-11-19T24:00:00Z", "2026-13-01T00:00:00Z", "2026-11-19T10:00:00.5Z", "2026-11-19T10:00:00+00:00", "٢٠٢٦-11-19T10:00:00Z"):
        yield {**base, "now": ts}


def test_start():
    calls = [[v] for v in start_variants()]
    compare("start", py.start, calls, normalize=norm)


def test_start_low_risk_token_and_hash_are_consistent():
    r = py.start(mk_start(riskLevel="low", selectedLenses=[]))
    assert r["ok"] and len(r["ackToken"]) == 64
    assert r["record"]["approved_ack_token_hash"] == domain_hash("approved-ack-token", 1, r["ackToken"])
    assert py.validate_state_record(r["record"])["ok"]
    v9r = v9_many("review/state", "start", [[mk_start(riskLevel="low", selectedLenses=[])]])[0]
    assert v9r["record"]["approved_ack_token_hash"] == domain_hash("approved-ack-token", 1, v9r["ackToken"])
    assert py.validate_state_record(v9r["record"])["ok"], "a v9-minted approval validates in Python"


def test_approve_token_is_hashed_the_same_way_on_both_sides():
    base = RECORDS["reviewing_clean"]
    v9r = v9_many("review/state", "approve", [[base, {"now": T1}]])[0]
    p = py.approve(base, {"now": T1})
    assert v9r["ok"] and p["ok"]
    assert py.burn(v9r["record"], {"token": v9r["ackToken"], "now": T1})["ok"] is True, "Python burns a v9-minted approval"
    assert v9_many("review/state", "burn", [[p["record"], {"token": p["ackToken"], "now": T1}]])[0]["ok"] is True, "v9 burns a Python-minted approval"
    assert v9_many("review/state", "burn", [[p["record"], {"token": v9r["ackToken"], "now": T1}]])[0]["refusal"]["code"] == "token_mismatch"
    assert v9_many("review/state", "validateStateRecord", [[p["record"]]])[0]["ok"] is True
