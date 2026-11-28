"""Differential: review/capture against v9 dist/review/capture.js through the oracle. Every exported function runs the SAME scenario on
v9 and on Python against the same real temp git repo and the same review store: the store directory is copied aside, v9 runs the
scenario, the store is restored, Python runs it, and the transcripts (every call's result plus the sha256 of every store file after it,
so the on-disk bytes are compared) must be equal. v9 runs with a preload that freezes `Date` and `randomBytes(32)` and Python gets the
same clock and token through its options. Exports: resultSchemaErrors, EMBEDDED_RESULT_SCHEMAS, captureLensResult, completeReview,
captureRefuterResult, planCorrection, beginCorrectionValidation, previewCorrectionValidation, captureValidatorResult,
captureCorrectionResult."""
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from lib.v9_oracle import DIST, needs_v9, v9
from odd_claude.review import capture as C
from odd_claude.review.artifact import lens_artifact_subject
from odd_claude.review.snapshot import freeze_snapshot
from odd_claude.review.store import read_state

from review.conftest import clone, py_oracle_err
from review.test_capture import (  # noqa: F401
    A_CHANGED,
    B_CHANGED,
    FAIL_CRITERIA,
    FAIL_REGRESSION,
    INFERENTIAL,
    SEVERE,
    edit_a,
    fixture,
    lens_input,
    refuter_result,
    sha0,
    validator_result,
)
from review.test_snapshot import _hermetic_git_env, write  # noqa: F401

pytestmark = needs_v9
MOD = "review/capture"
NOW = "2026-11-19T10:00:00.000Z"
TOKEN = "cd" * 32

PRELOAD = f"""import {{ syncBuiltinESMExports }} from "node:module";
import crypto from "node:crypto";
const T0 = Date.parse("{NOW}");
const RealDate = Date;
globalThis.Date = class extends RealDate {{ constructor(...a) {{ if (a.length === 0) super(T0); else super(...a); }} static now() {{ return T0; }} }};
const rb = crypto.randomBytes;
crypto.randomBytes = (n, cb) => (n === 32 && cb === undefined ? Buffer.alloc(32, 0xcd) : rb(n, cb));
syncBuiltinESMExports();
"""

PY = {
    "captureLensResult": C.capture_lens_result, "completeReview": C.complete_review, "captureRefuterResult": C.capture_refuter_result,
    "planCorrection": C.plan_correction, "beginCorrectionValidation": C.begin_correction_validation,
    "previewCorrectionValidation": C.preview_correction_validation, "captureValidatorResult": C.capture_validator_result,
    "captureCorrectionResult": C.capture_correction_result,
}
NO_OPTS = {"planCorrection"}


@pytest.fixture
def env(tmp_path):
    f = tmp_path / "freeze.mjs"
    f.write_text(PRELOAD)
    return {"GIT_CONFIG_NOSYSTEM": "1", "NODE_OPTIONS": f"--import={f}"}


def store_digest(cd):
    out = {}
    root = Path(cd) / "odd-plugin"
    for p in sorted(root.rglob("*")):
        if p.is_file():
            out[str(p.relative_to(root))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


class Backend:
    def __init__(self, kind, cd, env):
        self.kind, self.cd, self.env, self.log = kind, cd, env, []

    def __call__(self, fn, *args, opts=None):
        if self.kind == "v9":
            res = v9(MOD, fn, *args, *([opts] if opts is not None else []), env=self.env)
        else:
            full = {**(opts or {}), "now": lambda: NOW, "randomToken": lambda: TOKEN}
            res = py_oracle_err(PY[fn], *args, *([] if fn in NO_OPTS else [full]))
        self.log.append((fn, args[1:] if fn != "planCorrection" else args[1:], res, store_digest(self.cd)))
        return res


def both(fx, scenario):
    """Runs `scenario(call)` on v9 then on Python from the same store state; asserts equal transcripts; returns the Python results."""
    store = Path(fx.common_dir) / "odd-plugin"
    bak = Path(fx.common_dir).parent.parent / "store-backup"
    shutil.copytree(store, bak)
    return_v9 = Backend("v9", fx.common_dir, scenario.env)
    scenario(return_v9)
    shutil.rmtree(store)
    shutil.copytree(bak, store)
    py = Backend("py", fx.common_dir, scenario.env)
    scenario(py)
    assert len(return_v9.log) == len(py.log)
    for i, (a, b) in enumerate(zip(return_v9.log, py.log)):
        assert a == b, f"step {i} {a[0]}: v9={a!r}\npython={b!r}"
    return py.log


def run(env, fx, fn):
    fn.env = env
    return both(fx, fn)


def results(log):
    return [e[2] for e in log]


# ---- the lens path ----


def lens_cases(fx, lineage, record):
    """Refusal-heavy sequence on a 4-lens lineage (nothing is written until the last cases); every call is built from the same inputs."""
    rev = record["revision"]
    mine = lens_input(fx, record, "risk")
    sibling = lens_artifact_subject(fx.common_dir, record, "reliability")
    cd = fx.common_dir
    ok_subject = mine["subject"]
    base = {"lens": "risk", "subject": ok_subject}
    inputs = [
        None, "x", 5, True, [], {}, {"lens": None}, {"lens": 1}, {"lens": ["risk"]}, {"lens": {"a": 1}}, {"lens": "RISK"}, {"lens": "review-review-risk"}, {"lens": "\U0001f600"},
        {"lens": "risk"}, {**base, "result": None}, {**base, "result": "x"}, {**base, "result": []}, {**base, "result": {}}, {"lens": "risk", "result": mine["result"]},
        {**mine, "subject": None}, {**mine, "subject": {}}, {**mine, "subject": "x"}, {**mine, "subject": {**ok_subject, "extra": 1}}, {**mine, "subject": sibling},
        {**mine, "subject": {**ok_subject, "candidate_tree": "f" * 40}}, {**mine, "subject": {**ok_subject, "lineage_id": "review-" + "0" * 16}},
        {**mine, "lens": "resilience"}, {**mine, "lens": "review-resilience"}, {**mine, "lens": "bogus"},
    ]
    tweaks = [
        lambda r: r.pop("evidence"), lambda r: r.update(evidence=["n/a"]), lambda r: r.update(evidence=[" "]),
        lambda r: r.update(evidence=["﻿"]), lambda r: r.update(evidence=["TODO", "x"]), lambda r: r.update(evidence=["  PASSED  "]),
        lambda r: r.update(extra=True), lambda r: r.update(lens="reliability"), lambda r: r.update(lens="nope"),
        lambda r: r.update(findings=[{"location": "a.txt:1", "severity": "CRITICAL", "claim": "x", "proof_refs": ["y"]}]),
        lambda r: r.update(findings=[{"location": "a.txt", "severity": "MAJOR", "claim": "x", "proof_refs": ["y"]}]),
        lambda r: r.update(findings=[{"location": "é\U0001f600.txt:12-30", "severity": "WARNING", "claim": "é", "proof_refs": ["n/a"]}]),
        lambda r: r.update(findings=[{"location": "a.txt:1", "severity": "WARNING", "claim": "", "proof_refs": ["y"]}]),
        lambda r: r.update(findings=[{"location": "a.txt:0", "severity": "WARNING", "claim": "c", "proof_refs": ["y"]}]),
        lambda r: r.update(findings=[{"id": "R2-x", "location": "a.txt:1", "severity": "WARNING", "claim": "c", "proof_refs": ["y"]}, {"location": "a.txt:2", "severity": "WARNING", "claim": "c", "proof_refs": ["y"]}]),
        lambda r: r.update(findings=[{"id": "R9-x", "location": "a.txt:1", "severity": "WARNING", "claim": "c", "proof_refs": ["y"]}]),
        lambda r: r.update(findings=[{"lens": "reliability", "location": "a.txt:1", "severity": "WARNING", "claim": "c", "proof_refs": ["y"]}]),
        lambda r: r.update(inspection={"status": "unavailable", "paths": []}), lambda r: r.update(inspection={"status": "unavailable", "paths": [], "reason": "timed out \U0001f600"}),
        lambda r: r.update(inspection={"status": "completed", "paths": ["a.txt"]}), lambda r: r.update(inspection={"status": "completed", "paths": ["a.txt", "b.txt", "c.txt"]}),
        lambda r: r.update(inspection={"status": "completed", "paths": ["a.txt", "a.txt"]}), lambda r: r.update(inspection={"status": "completed", "paths": ["a.txt", "b.txt", ""]}),
        lambda r: r.update(inspection={"status": "weird", "paths": []}),
        lambda r: r.update(subject_hash="nope"), lambda r: r.update(subject_hash=sha0()), lambda r: r.update(subject_hash=sibling["subject_hash"]), lambda r: r.update(subject_hash=5),
    ]

    def scenario(call):
        for stale in ("sha256:stale", "", None, 5, rev.upper()):
            call("captureLensResult", cd, record["lineage_id"], stale, mine)
        for i in inputs:
            call("captureLensResult", cd, record["lineage_id"], rev, i)
        for t in tweaks:
            call("captureLensResult", cd, record["lineage_id"], rev, lens_input(fx, record, "risk", [], t))
        first = call("captureLensResult", cd, record["lineage_id"], rev, mine)
        assert "revision" in first, [(i, str(e[1][2])[:200], str(e[1][2:])[-200:]) for i, e in enumerate(call.log) if isinstance(e[2], dict) and e[2].get("ok")]
        # duplicates, stale after progress, the other lenses with and without findings
        call("captureLensResult", cd, record["lineage_id"], first["revision"], mine)
        call("captureLensResult", cd, record["lineage_id"], rev, lens_input(fx, record, "resilience"))
        call("captureLensResult", cd, record["lineage_id"], first["revision"], {**lens_input(fx, record, "resilience"), "lens": "review-resilience"})
        return first

    scenario.env = None
    return scenario


def test_capture_lens_result_refusals_and_progress(fixture, env):
    fx, lineage, record = fixture("high")
    sc = lens_cases(fx, lineage, record)
    log = run(env, fx, sc)
    assert any(e[2].get("ok") for e in log if isinstance(e[2], dict))
    assert {e[2].get("code") for e in log if isinstance(e[2], dict) and not e[2].get("ok")} >= {"concurrent_update", "invalid_input", "schema_invalid", "binding_drift", "inspection_unavailable", "inspection_incomplete", "lens_already_admitted"}


def test_capture_lens_result_every_settle_outcome(fixture, env):
    cases = [
        ("approved", lambda lens: []), ("minor", lambda lens: [{"location": "a.txt:2", "severity": "WARNING", "claim": "naming é\U0001f600", "proof_refs": ["a.txt:2"]}, {"id": "R1-2", "location": "b.txt:1", "severity": "SUGGESTION", "claim": "c", "proof_refs": ["x"]}, {"location": "a.txt:3", "severity": "WARNING", "claim": "auto after explicit", "proof_refs": ["x"]}]),
        ("severe", lambda lens: [SEVERE]), ("pre", lambda lens: [{**SEVERE, "causal_disposition": "pre-existing"}]), ("base", lambda lens: [{**SEVERE, "causal_disposition": "base-only"}]),
        ("unknown", lambda lens: [{**SEVERE, "causal_disposition": "unknown"}]), ("insufficient", lambda lens: [{**SEVERE, "evidence_class": "insufficient"}]),
        ("blocker", lambda lens: [{**SEVERE, "severity": "BLOCKER", "location": "é-\U0001f600.txt:4", "claim": "\U0001f600"}]),
        ("many", lambda lens: [{**SEVERE, "id": f"R1-{i}", "location": f"a.txt:{i + 1}"} for i in range(5, 0, -1)] + [{**SEVERE, "id": "R1-b", "location": "b.txt:1"}]),
    ]
    for name, findings in cases:
        fx, lineage, record = fixture("medium")

        def sc(call, fx=fx, lineage=lineage, record=record, findings=findings):
            call("captureLensResult", fx.common_dir, lineage, record["revision"], lens_input(fx, record, "risk", findings("risk")))

        run(env, fx, sc)
    fx, lineage, record = fixture("high")

    def four(call):
        rev, rec = record["revision"], record
        for lens in record["selected_lenses"]:
            out = call("captureLensResult", fx.common_dir, lineage, rev, lens_input(fx, rec, lens, [SEVERE, {**SEVERE, "location": "b.txt:2", "claim": "b"}] if lens == "readability" else []))
            rev, rec = out["revision"], out["record"]

    run(env, fx, four)


def test_lens_findings_get_native_ids_with_explicit_id_collisions(fixture, env):
    fx, lineage, record = fixture("medium")
    f = lambda i=None, **o: {**({"id": i} if i else {}), "location": "a.txt:1", "severity": "SUGGESTION", "claim": "c", "proof_refs": ["x"], **o}  # noqa: E731

    def sc(call):
        call("captureLensResult", fx.common_dir, lineage, record["revision"], lens_input(fx, record, "risk", [f(), f("R1-1"), f(), f("R1-3"), f(), f("R1-b")]))

    log = run(env, fx, sc)
    assert [x["id"] for x in log[0][2]["record"]["findings"]]  # the record was written


# ---- complete_review / refuter ----


def test_complete_review_and_refuter_flows(fixture, env):
    for results_ in ([{"finding_id": "R1-1", "outcome": "refuted"}], [{"finding_id": "R1-1", "outcome": "corroborated"}], [{"finding_id": "R1-1", "outcome": "inconclusive"}], [], None):
        fx, lineage, _ = fixture("medium")

        def sc(call, fx=fx, lineage=lineage, results_=results_):
            rec = read_state(fx.common_dir, lineage)
            held = call("captureLensResult", fx.common_dir, lineage, rec["revision"], lens_input(fx, rec, "risk", [INFERENTIAL, {**INFERENTIAL, "location": "b.txt:1"}]), opts={"awaitRefuter": True})
            rev, hrec = held["revision"], held["record"]
            call("completeReview", fx.common_dir, lineage, "sha256:stale")
            if results_ is None:
                done = call("completeReview", fx.common_dir, lineage, rev)
                call("captureRefuterResult", fx.common_dir, lineage, done["revision"], {"result": refuter_result(hrec, [])})
                call("completeReview", fx.common_dir, lineage, done["revision"])
                return
            bad = [
                {"results": []}, None, "x", [], {}, {**refuter_result(hrec, results_), "extra": 1}, {**refuter_result(hrec, results_), "refuter_request_hash": sha0()},
                refuter_result(hrec, [{"finding_id": "R1-9", "outcome": "refuted"}]),
                refuter_result(hrec, [{"finding_id": "R1-1", "outcome": "refuted"}, {"finding_id": "R1-1", "outcome": "corroborated"}]),
                {**refuter_result(hrec, results_), "results": [{"finding_id": "R1-1", "outcome": "maybe", "proof_refs": ["x"]}]},
                {**refuter_result(hrec, results_), "results": [{"finding_id": "R1-1", "outcome": "refuted", "proof_refs": []}]},
                {**refuter_result(hrec, results_), "results": [{"finding_id": "é\U0001f600", "outcome": "refuted", "proof_refs": ["x"]}]},
            ]
            for b in bad:
                call("captureRefuterResult", fx.common_dir, lineage, rev, {"result": b})
            call("captureRefuterResult", fx.common_dir, lineage, rev, {})
            call("captureRefuterResult", fx.common_dir, lineage, rev, None)
            call("captureRefuterResult", fx.common_dir, lineage, "sha256:stale", {"result": refuter_result(hrec, results_)})
            done = call("captureRefuterResult", fx.common_dir, lineage, rev, {"result": refuter_result(hrec, results_)})
            call("captureRefuterResult", fx.common_dir, lineage, done["revision"], {"result": refuter_result(hrec, results_)})
            call("completeReview", fx.common_dir, lineage, done["revision"])

        run(env, fx, sc)


def test_refuter_partly_refuted_and_before_every_lens(fixture, env):
    fx, lineage, record = fixture("high")

    def early(call):
        rec = record
        call("completeReview", fx.common_dir, lineage, rec["revision"])
        call("captureRefuterResult", fx.common_dir, lineage, rec["revision"], {"result": {"refuter_request_hash": sha0(), "results": []}})

    run(env, fx, early)
    fx, lineage, _ = fixture("medium")

    def partly(call):
        rec = read_state(fx.common_dir, lineage)
        held = call("captureLensResult", fx.common_dir, lineage, rec["revision"], lens_input(fx, rec, "risk", [INFERENTIAL, {**INFERENTIAL, "location": "b.txt:1", "claim": "b"}]), opts={"awaitRefuter": True})
        s = call("captureRefuterResult", fx.common_dir, lineage, held["revision"], {"result": refuter_result(held["record"], [{"finding_id": "R1-2", "outcome": "refuted"}])})
        call("planCorrection", fx.common_dir, lineage)
        return s

    run(env, fx, partly)


# ---- plan / begin / preview / validator / capture_correction ----


def corrected_candidates(fx):
    first = edit_a(fx, A_CHANGED.replace("one\n", "ONE\n", 1))
    second = edit_a(fx, A_CHANGED.replace("one\n", "UNO\n", 1))
    third = edit_a(fx, A_CHANGED.replace("one\n", "EINS\n", 1))
    exact = edit_a(fx, A_CHANGED + "".join(f"more-{i}\n" for i in range(15)))
    big = edit_a(fx, A_CHANGED + "".join(f"more-{i}\n" for i in range(16)))
    outside = edit_a(fx, B_CHANGED.replace("bee\n", "BEE\n", 1), "b.txt")
    return {"first": first, "second": second, "third": third, "exact": exact, "big": big, "outside": outside}


def test_plan_begin_preview_refusals_and_validation_flows(fixture, env):
    fx, lineage, record = fixture("medium")
    cand = corrected_candidates(fx)
    cd, rep = fx.common_dir, fx.repository
    cur = {"candidateTree": record["candidate_tree"], "identity": record["target_identity"]}

    def sc(call):
        # nothing to correct yet
        call("planCorrection", cd, lineage)
        call("beginCorrectionValidation", rep, lineage, record["revision"], cand["first"])
        call("previewCorrectionValidation", rep, lineage, record["revision"], cand["first"])
        call("captureCorrectionResult", rep, lineage, record["revision"], cand["first"], {"result": {}})
        s = call("captureLensResult", cd, lineage, record["revision"], lens_input(fx, record, "risk", [SEVERE, {**SEVERE, "location": "\U0001f600/z.txt:3", "claim": "u"}, {**SEVERE, "location": "～.txt:3", "claim": "u2"}]))
        rev = s["revision"]
        call("planCorrection", cd, lineage)
        for bad in (None, "x", {}, {"candidateTree": 5, "identity": "x"}, {"candidateTree": "x"}, {"identity": "x"}, {"candidateTree": "zz", "identity": "i"}, {"candidateTree": "0" * 40, "identity": "i"},
                    {"candidateTree": cur["candidateTree"], "identity": sha0("3")}, {**cand["first"], "identity": cur["identity"]}, cand["outside"], cand["big"], cur):
            call("beginCorrectionValidation", rep, lineage, rev, bad)
            call("previewCorrectionValidation", rep, lineage, rev, bad)
            call("captureCorrectionResult", rep, lineage, rev, bad, {"result": {}})
        for stale in ("sha256:stale", "", None, 3):
            call("beginCorrectionValidation", rep, lineage, stale, cand["first"])
            call("previewCorrectionValidation", rep, lineage, stale, cand["first"])
            call("captureCorrectionResult", rep, lineage, stale, cand["first"], {"result": {}})

    log = run(env, fx, sc)
    codes = {e[2].get("code") for e in log if isinstance(e[2], dict)}
    assert {"illegal_state", "invalid_input", "snapshot_unavailable", "correction_unavailable", "correction_out_of_scope", "concurrent_update"} <= codes


def test_plan_correction_unicode_path_order_matches_utf16(fixture, env):
    fx, lineage, record = fixture("medium")

    def sc(call):
        findings = [{**SEVERE, "id": f"R1-{i}", "location": loc, "claim": f"c{i}"} for i, loc in enumerate(["\U0001f600.txt:1", "～.txt:2", "a.txt:3", "é.txt:4", "z/\u0000y.txt:5", "a.txt:6-9", "퟿.txt:1", ".txt:1"], 1)]
        s = call("captureLensResult", fx.common_dir, lineage, record["revision"], lens_input(fx, record, "risk", findings))
        call("planCorrection", fx.common_dir, lineage)
        return s

    log = run(env, fx, sc)
    assert log[1][2]["ok"] is True


def test_correction_validation_pass_fail_escalate_and_second_attempt(fixture, env):
    for over in (None, FAIL_CRITERIA, FAIL_REGRESSION):
        fx, lineage, record = fixture("medium")
        cand = corrected_candidates(fx)
        cd, rep = fx.common_dir, fx.repository

        def sc(call, fx=fx, lineage=lineage, record=record, cand=cand, over=over):
            s = call("captureLensResult", cd, lineage, record["revision"], lens_input(fx, record, "risk", [SEVERE]))
            v1 = call("beginCorrectionValidation", rep, lineage, s["revision"], cand["first"])
            vr = v1["record"]
            ov = over or {}
            result = validator_result(vr, **ov)
            bad = [
                {"result": None}, {}, None, {"result": {**result, "follow_ups": "none"}}, {"result": validator_result(vr, correction_regression={"passed": False, "evidence": ["x"]})},
                {"result": {**result, "targeted_validation_request_hash": sha0()}}, {"result": {**result, "correction_target_identity": sha0("1")}},
                {"result": validator_result(vr, original_criteria={"passed": True, "evidence": ["x"], "inspection": {"status": "unavailable", "reason": "timed out \U0001f600"}})},
                {"result": validator_result(vr, correction_regression={"passed": True, "evidence": ["x"], "inspection": {"status": "unavailable"}})},
                {"result": validator_result(vr, correction_regression={"passed": True, "evidence": ["x"], "inspection": {"status": "unavailable", "reason": "r"}})},
                {"result": validator_result(vr, follow_ups=[{"observation": "x"}])}, {"result": validator_result(vr, follow_ups=[{"observation": "é", "proof_refs": [" "]}])},
                {"result": result, "correctionCandidateTree": 5}, {"result": result, "correctionCandidateTree": None}, {"result": result, "correctionCandidateTree": "zz"},
            ]
            for b in bad:
                call("captureValidatorResult", cd, lineage, v1["revision"], b)
            call("captureValidatorResult", cd, lineage, "sha256:stale", {"result": result})
            call("beginCorrectionValidation", rep, lineage, v1["revision"], cand["second"])
            call("planCorrection", cd, lineage)
            tree = {"correctionCandidateTree": cand["first"]["candidateTree"]} if over else {}
            r1 = call("captureValidatorResult", cd, lineage, v1["revision"], {"result": result, **tree})
            if over:
                call("beginCorrectionValidation", rep, lineage, r1["revision"], cand["first"])
                v2 = call("beginCorrectionValidation", rep, lineage, r1["revision"], cand["second"])
                r2 = call("captureValidatorResult", cd, lineage, v2["revision"], {"result": validator_result(v2["record"], **ov), "correctionCandidateTree": cand["second"]["candidateTree"]})
                call("planCorrection", cd, lineage)
                call("beginCorrectionValidation", rep, lineage, r2["revision"], cand["third"])
                call("captureValidatorResult", cd, lineage, r2["revision"], {"result": result})
            else:
                call("captureValidatorResult", cd, lineage, r1["revision"], {"result": result})

        run(env, fx, sc)


def test_second_correction_approved_after_a_failed_first(fixture, env):
    fx, lineage, record = fixture("medium")
    cand = corrected_candidates(fx)
    cd, rep = fx.common_dir, fx.repository

    def sc(call):
        s = call("captureLensResult", cd, lineage, record["revision"], lens_input(fx, record, "risk", [SEVERE]))
        v1 = call("beginCorrectionValidation", rep, lineage, s["revision"], cand["first"])
        reopened = call("captureValidatorResult", cd, lineage, v1["revision"], {"result": validator_result(v1["record"], **FAIL_CRITERIA), "correctionCandidateTree": cand["first"]["candidateTree"]})
        v2 = call("beginCorrectionValidation", rep, lineage, reopened["revision"], cand["second"])
        call("captureValidatorResult", cd, lineage, v2["revision"], {"result": validator_result(v2["record"]), "correctionCandidateTree": cand["second"]["candidateTree"]})

    log = run(env, fx, sc)
    assert log[-1][2]["state"] == "approved"


def test_capture_correction_result_all_branches(fixture, env):
    for over in (None, FAIL_CRITERIA, FAIL_REGRESSION):
        fx, lineage, record = fixture("medium")
        cand = corrected_candidates(fx)
        cd, rep = fx.common_dir, fx.repository

        def sc(call, fx=fx, lineage=lineage, record=record, cand=cand, over=over):
            s = call("captureLensResult", cd, lineage, record["revision"], lens_input(fx, record, "risk", [SEVERE]))
            rev = s["revision"]
            p = call("previewCorrectionValidation", rep, lineage, rev, cand["exact"])
            call("previewCorrectionValidation", rep, lineage, rev, cand["first"])
            pr = call("previewCorrectionValidation", rep, lineage, rev, cand["first"])
            result = validator_result(pr["record"], **(over or {}))
            for b in ({"result": {**result, "targeted_validation_request_hash": sha0()}}, {"result": {**result, "follow_ups": "none"}}, {"result": None}, {}, None,
                      {"result": validator_result(pr["record"], original_criteria={"passed": True, "evidence": ["x"], "inspection": {"status": "unavailable", "reason": "timed out"}})}):
                call("captureCorrectionResult", rep, lineage, rev, cand["first"], b)
            call("captureCorrectionResult", rep, lineage, sha0("9"), cand["first"], {"result": result})
            call("captureCorrectionResult", rep, lineage, rev, cand["exact"], {"result": result})
            call("captureCorrectionResult", rep, lineage, rev, cand["outside"], {"result": result})
            done = call("captureCorrectionResult", rep, lineage, rev, cand["first"], {"result": result})
            call("captureCorrectionResult", rep, lineage, done["revision"], cand["first"], {"result": result})
            if over:
                # the failed attempt reopened a correction: the second one runs through the same single transition
                p2 = call("previewCorrectionValidation", rep, lineage, done["revision"], cand["second"])
                final = call("captureCorrectionResult", rep, lineage, done["revision"], cand["second"], {"result": validator_result(p2["record"], **over)})
                call("planCorrection", cd, lineage)
                call("previewCorrectionValidation", rep, lineage, final["revision"], cand["third"])

        run(env, fx, sc)


# ---- result_schema_errors and the embedded schemas ----

_JS = r"""
const [url, payload] = process.argv.slice(1);
const esc = (s) => s.replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const m = await import(url);
const out = [];
for (const [kind, value] of JSON.parse(payload)) {
  try { out.push(m.resultSchemaErrors[kind](value)); } catch (e) { out.push({ __error__: String(e.message) }); }
}
process.stdout.write(esc(JSON.stringify([out, m.EMBEDDED_RESULT_SCHEMAS])));
"""


def v9_schema(pairs):
    r = subprocess.run(["node", "--input-type=module", "-e", _JS, (DIST / "review" / "capture.js").as_uri(), json.dumps(pairs)], capture_output=True, text=True, encoding="ascii", timeout=120)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def schema_values():
    sub = "sha256:" + "a" * 64
    lens = {"subject_hash": sub, "inspection": {"status": "completed", "paths": ["a.txt", "é\U0001f600.txt"]}, "findings": [], "evidence": ["ok"]}
    finding = {"location": "a.txt:1", "severity": "CRITICAL", "claim": "c", "proof_refs": ["p"], "evidence_class": "deterministic", "causal_disposition": "introduced"}
    refuter = {"refuter_request_hash": sub, "results": [{"finding_id": "R1-1", "outcome": "refuted", "proof_refs": ["x"]}]}
    check = {"passed": True, "evidence": ["e"]}
    validator = {"targeted_validation_request_hash": sub, "correction_target_identity": sub, "original_criteria": check, "correction_regression": check, "follow_ups": []}
    ws = [" ", "\u0085", "\u001c", "\u001f", "﻿", " ", " ", "　", "᠎", "​", "\t", "\n"]
    lens_vals = [lens, None, "x", 1, [], {}, {**lens, "extra": 1}, {**lens, "lens": "review-risk"}, {**lens, "lens": "nope"}, {**lens, "findings": [finding]}, {**lens, "findings": [{k: v for k, v in finding.items() if k != "causal_disposition"}]},
                 {**lens, "findings": [{**finding, "id": "R1-ok"}]}, {**lens, "findings": [{**finding, "id": "R5-ok"}]}, {**lens, "findings": [{**finding, "id": "R1-é"}]},
                 {**lens, "findings": [{**finding, "location": "a.txt:0"}]}, {**lens, "findings": [{**finding, "location": "é.txt:3-4"}]}, {**lens, "findings": [{**finding, "location": "a\nb.txt:3"}]},
                 {**lens, "findings": [{**finding, "location": "a b.txt:3"}]}, {**lens, "findings": [{**finding, "severity": "MAJOR"}]}, {**lens, "findings": [{**finding, "claim": ""}]},
                 {**lens, "inspection": {"status": "unavailable", "paths": []}}, {**lens, "inspection": {"status": "unavailable", "paths": [], "reason": ""}}, {**lens, "inspection": {"status": "unavailable", "paths": [], "reason": "r"}},
                 {**lens, "inspection": {"status": "completed", "paths": ["a", "a"]}}, {**lens, "inspection": {"status": "completed", "paths": [""]}}, {**lens, "subject_hash": "sha256:" + "A" * 64}, {**lens, "subject_hash": sub + "\n"}]
    lens_vals += [{**lens, "evidence": [w]} for w in ws] + [{**lens, "evidence": [f"{w}{n}{w}"]} for w in ws[:4] for n in ("n/a", "NONE", "Todo", "tbd", "PaSsEd", "success", "placeholder", "N/A.")]
    lens_vals += [{**lens, "findings": [{**finding, "proof_refs": [w]}]} for w in ws] + [{**lens, "findings": [{**finding, "proof_refs": [n]}]} for n in ("n/a", "na", "none", "TODO", "tbd", "pass", "passed", "success", "placeholder", "ok", "é")]
    ref_vals = [refuter, None, [], {**refuter, "results": []}, {**refuter, "results": [{"finding_id": "R1-1", "outcome": "maybe", "proof_refs": ["x"]}]}, {**refuter, "results": [{"finding_id": "R1-1", "outcome": "refuted", "proof_refs": []}]},
                {**refuter, "results": [{"finding_id": "R1-1", "outcome": "refuted", "proof_refs": [" "]}]}, {**refuter, "results": [{"finding_id": "R1-1", "outcome": "refuted", "proof_refs": ["\u001f"]}]},
                {**refuter, "refuter_request_hash": "x"}, {"results": []}, {**refuter, "x": 1}]
    val_vals = [validator, None, "x", {**validator, "follow_ups": "none"}, {**validator, "follow_ups": [{"observation": "x"}]}, {**validator, "follow_ups": [{"observation": "x", "proof_refs": ["p"]}]},
                {**validator, "correction_regression": {"passed": False, "evidence": ["x"]}}, {**validator, "correction_regression": {"passed": False, "evidence": ["x"], "regressions": []}},
                {**validator, "correction_regression": {"passed": False, "evidence": ["x"], "regressions": [{"location": "a.txt:1", "claim": "c", "proof_refs": ["p"]}]}},
                {**validator, "correction_regression": {"passed": False, "evidence": ["x"], "regressions": [{"location": "a.txt", "claim": "", "proof_refs": []}]}},
                {**validator, "original_criteria": {"passed": True, "evidence": []}}, {**validator, "original_criteria": {"passed": "yes", "evidence": ["x"]}},
                {**validator, "original_criteria": {**check, "inspection": {"status": "unavailable"}}}, {**validator, "original_criteria": {**check, "inspection": {"status": "unavailable", "reason": ""}}},
                {**validator, "original_criteria": {**check, "inspection": {"status": "unavailable", "reason": "r"}}}, {**validator, "original_criteria": {**check, "inspection": {"status": "completed"}}},
                {k: v for k, v in validator.items() if k != "follow_ups"}, {**validator, "correction_target_identity": "x"}]
    return [("lens", v) for v in lens_vals] + [("refuter", v) for v in ref_vals] + [("validator", v) for v in val_vals] + [(k, v) for k in ("lens", "refuter", "validator") for v in (1, 1.5, True, False, "", "\U0001f600")]


def test_result_schema_errors_match_v9_on_valid_invalid_and_unicode_whitespace_results():
    pairs = schema_values()
    expected, embedded = v9_schema(pairs)
    for (kind, value), want in zip(pairs, expected):
        got = py_oracle_err(C.result_schema_errors[kind], value)
        assert got == want, f"{kind} {value!r}: python={got!r} v9={want!r}"
    assert len(pairs) > 100


def test_embedded_schemas_equal_v9s():
    _, embedded = v9_schema([])
    assert clone(C.EMBEDDED_RESULT_SCHEMAS) == embedded
    assert list(C.EMBEDDED_RESULT_SCHEMAS) == list(embedded)


def test_missing_result_key_is_an_undefined_value_for_every_schema():
    # `{}` has no `result` (JS undefined, which cannot cross the oracle as a value): the error text is v9's
    assert C.result_schema_errors["lens"](None) == v9_schema([("lens", None)])[0][0]
    assert C._schema_errors(C.LENS_SCHEMA, C._UNDEF, "lens") == [": expected type object, got undefined"]


def test_missing_lineage_error_is_the_same_text(fixture, env):
    fx, lineage, record = fixture("medium")
    ghost = "review-00000000000000ff"

    def sc(call):
        call("captureLensResult", fx.common_dir, ghost, "x", {"lens": "risk"})
        call("captureRefuterResult", fx.common_dir, ghost, "x", {})
        call("captureValidatorResult", fx.common_dir, ghost, "x", {})
        call("completeReview", fx.common_dir, ghost, "x")
        call("planCorrection", fx.common_dir, ghost)
        call("planCorrection", fx.common_dir, "not-a-lineage")
        call("beginCorrectionValidation", fx.repository, ghost, "x", {})
        call("previewCorrectionValidation", fx.repository, ghost, "x", {})
        call("captureCorrectionResult", fx.repository, ghost, "x", {}, {})

    log = run(env, fx, sc)
    assert all("__error__" in e[2] for e in log)


def test_capture_on_a_corrupt_state_file_errors_identically(fixture, env):
    fx, lineage, record = fixture("medium")
    state = Path(fx.common_dir) / "odd-plugin" / "review-transactions" / "v2" / lineage / "review-state.json"
    state.write_text('{"a": 1}')

    def sc(call):
        call("captureLensResult", fx.common_dir, lineage, "x", {"lens": "risk"})
        call("planCorrection", fx.common_dir, lineage)
        call("completeReview", fx.common_dir, lineage, "x")

    log = run(env, fx, sc)
    assert all("__error__" in e[2] for e in log)


def test_scenarios_leave_no_stray_files(fixture):
    fx, lineage, _ = fixture("medium")
    assert os.path.isdir(os.path.join(fx.common_dir, "odd-plugin"))
    assert freeze_snapshot(fx.repo, {"kind": "current-changes"})["status"] == "frozen"
