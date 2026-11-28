"""Port of v9 review/capture.spec.ts (31 `test(` calls; the per-kind provider-mirror loop and the multi-case tests are parametrized,
so more cases than v9) on real temp git repos. The v9 fixture opens a lineage through `startReview` (not ported here); this one
freezes the same snapshot and opens it with `state.start` + `store.create_state`, which is what `startReview` does."""
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from odd_claude.review import capture as C
from odd_claude.review.artifact import lens_artifact_subject, refuter_request_hash, targeted_validation_request_hash, tree_diff_paths
from odd_claude.review.snapshot import freeze_snapshot
from odd_claude.review.state import MAX_ADMITTED_ROLE_RESULTS, start
from odd_claude.review.store import create_state, read_state

from review.conftest import MIRROR_ROOT, clone, read_json
from review.test_snapshot import _hermetic_git_env, git, write  # noqa: F401

A_ORIGINAL = "one\ntwo\nthree\n"
A_CHANGED = A_ORIGINAL + "".join(f"a-added-{i}\n" for i in range(20))
B_CHANGED = "bee\n" + "".join(f"b-added-{i}\n" for i in range(10))
TOKEN = re.compile(r"^[0-9a-f]{64}$")
NOW = "2026-11-19T10:00:00.000Z"


class Fx:
    def __init__(self, repo: str, common_dir: str, repository: dict):
        self.repo = repo
        self.common_dir = common_dir
        self.repository = repository


@pytest.fixture
def fixture(tmp_path):
    """`fixture(level)` -> (fx, lineage, record): 30 changed lines in a.txt (20) and b.txt (10), correction budget 15."""
    count = [0]

    def make(level: str = "medium"):
        count[0] += 1
        repo = str(Path(os.path.realpath(tmp_path)) / f"fx{count[0]}" / "repo")
        os.makedirs(repo)
        git(repo, "init", "-q", "-b", "main")
        write(os.path.join(repo, "a.txt"), A_ORIGINAL)
        write(os.path.join(repo, "b.txt"), "bee\n")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "init")
        write(os.path.join(repo, "a.txt"), A_CHANGED)
        write(os.path.join(repo, "b.txt"), B_CHANGED)
        frozen = freeze_snapshot(repo, {"kind": "current-changes"})
        assert frozen["status"] == "frozen"
        snap = frozen["snapshot"]
        common_dir = os.path.realpath(os.path.join(repo, ".git"))
        lineage = f"review-{count[0]:016x}"
        out = start({
            "lineageId": lineage, "targetIdentity": snap["identity"], "projection": snap["projection"], "baseTree": snap["baseTree"], "candidateTree": snap["candidateTree"],
            "riskLevel": level, "selectedLenses": ["risk", "resilience", "readability", "reliability"] if level == "high" else ["risk"],
            "originalChangedLines": snap["changedLines"], "now": NOW,
        })
        assert out["ok"], out
        record = create_state(common_dir, out["record"])
        return Fx(repo, common_dir, frozen["repository"]), lineage, record

    return make


SEVERE = {
    "location": "a.txt:1", "severity": "CRITICAL", "claim": "a.txt breaks on empty input", "proof_refs": ["a.txt:1 reads the first line unchecked"],
    "evidence_class": "deterministic", "causal_disposition": "introduced",
}
INFERENTIAL = {**SEVERE, "evidence_class": "inferential"}


def lens_input(fx, record, lens, findings=None, tweak=None):
    subject = lens_artifact_subject(fx.common_dir, record, lens)
    result = {
        "subject_hash": subject["subject_hash"],
        "inspection": {"status": "completed", "paths": tree_diff_paths(fx.common_dir, record["base_tree"], record["candidate_tree"])},
        "findings": findings or [],
        "evidence": ["reviewed the complete candidate scope"],
    }
    if tweak:
        tweak(result)
    return {"lens": lens, "subject": subject, "result": result}


def good(o):
    assert o["ok"] is True, {k: v for k, v in o.items() if k != "record"}
    return o


def refused(o, code):
    assert o["ok"] is False, "expected a refusal"
    assert o["code"] == code, o["message"]
    return o


def capture_all(fx, lineage, findings_of=lambda lens: [], opts=None):
    record = read_state(fx.common_dir, lineage)
    status = None
    for lens in record["selected_lenses"]:
        status = good(C.capture_lens_result(fx.common_dir, lineage, record["revision"], lens_input(fx, record, lens, findings_of(lens)), opts))
        record = status["record"]
    return status


def unchanged(fx, lineage, revision):
    assert read_state(fx.common_dir, lineage)["revision"] == revision


def edit_a(fx, content, file="a.txt"):
    write(os.path.join(fx.repo, file), content)
    f = freeze_snapshot(fx.repo, {"kind": "current-changes"})
    assert f["status"] == "frozen"
    return {"candidateTree": f["snapshot"]["candidateTree"], "identity": f["snapshot"]["identity"]}


def sha0(c="0"):
    return "sha256:" + c * 64


def refuter_result(record, results):
    return {"refuter_request_hash": refuter_request_hash(record), "results": [{**r, "proof_refs": ["a.txt:1 handles the empty input"]} for r in results]}


def validator_result(record, **over):
    return {
        "targeted_validation_request_hash": targeted_validation_request_hash(record), "correction_target_identity": record.get("correction_target_identity"),
        "original_criteria": {"passed": True, "evidence": ["a.txt:1 now guards the empty input"]},
        "correction_regression": {"passed": True, "evidence": ["the regression test passes"]}, "follow_ups": [], **over,
    }


@pytest.fixture
def to_correction(fixture):
    def go():
        fx, lineage, record = fixture()
        s = capture_all(fx, lineage, lambda lens: [SEVERE])
        assert s["next"] == "correction_required"
        return fx, lineage, s

    return go


# ---- happy paths ----


def test_one_lens_no_findings_capture_admits_and_approves_returning_the_token_once(fixture):
    fx, lineage, record = fixture()
    assert record["state"] == "reviewing"
    status = good(C.capture_lens_result(fx.common_dir, lineage, record["revision"], lens_input(fx, record, "risk")))
    assert status["state"] == "approved"
    assert status["next"] == "approved"
    assert TOKEN.match(status["ackToken"])
    assert status["pending_lenses"] == []
    stored = read_state(fx.common_dir, lineage)
    assert stored["revision"] == status["revision"]
    assert stored["state"] == "approved"
    assert len(stored["admitted_role_results"]) == 1
    assert stored["admitted_role_results"][0]["lens"] == "risk"
    assert re.match(r"^sha256:[0-9a-f]{64}$", stored["admitted_role_results"][0]["result_hash"])
    assert stored["admitted_role_results"][0]["artifact_digest"] == lens_artifact_subject(fx.common_dir, record, "risk")["subject_hash"]
    assert status["ackToken"] not in json.dumps(stored)
    refused(C.capture_lens_result(fx.common_dir, lineage, stored["revision"], lens_input(fx, record, "risk")), "illegal_state")


def test_review_prefixed_lens_names_ids_assigned_natively_and_non_severe_findings_do_not_block(fixture):
    fx, lineage, record = fixture()
    minor = {"location": "a.txt:2", "severity": "WARNING", "claim": "naming", "proof_refs": ["a.txt:2"]}
    status = good(C.capture_lens_result(fx.common_dir, lineage, record["revision"], {**lens_input(fx, record, "risk", [minor, {**minor, "severity": "SUGGESTION"}]), "lens": "review-risk"}))
    assert status["next"] == "approved"
    assert [f["id"] for f in status["record"]["findings"]] == ["R1-1", "R1-2"]
    assert [f["severity"] for f in status["record"]["findings"]] == ["WARNING", "SUGGESTION"]


def test_four_lenses_with_a_critical_collect_until_the_last_then_correction_required_with_the_frozen_ledger(fixture):
    fx, lineage, _ = fixture("high")
    record = read_state(fx.common_dir, lineage)
    assert record["selected_lenses"] == ["risk", "resilience", "readability", "reliability"]
    seen = []
    for lens in record["selected_lenses"]:
        s = good(C.capture_lens_result(fx.common_dir, lineage, record["revision"], lens_input(fx, record, lens, [SEVERE] if lens == "readability" else [])))
        seen.append(s)
        record = s["record"]
    assert [s["next"] for s in seen] == ["collect", "collect", "collect", "correction_required"]
    assert [len(s["pending_lenses"]) for s in seen] == [3, 2, 1, 0]
    assert all("ackToken" not in s for s in seen)
    last = seen[3]
    assert last["state"] == "correction_required"
    assert last["record"]["fix_finding_ids"] == ["R2-1"]
    assert re.match(r"^sha256:[0-9a-f]{64}$", last["record"]["ledger_hash"])
    assert last["record"]["findings"][0]["causal_disposition"] == "introduced"


@pytest.mark.parametrize("patch,state", [
    ({"causal_disposition": "pre-existing"}, "approved"),
    ({"causal_disposition": "base-only"}, "approved"),
    ({"causal_disposition": "unknown"}, "escalated"),
    ({"evidence_class": "insufficient"}, "escalated"),
])
def test_pre_existing_and_base_only_severe_findings_are_follow_ups_unknown_or_insufficient_escalate(fixture, patch, state):
    fx, lineage, _ = fixture()
    s = capture_all(fx, lineage, lambda lens: [{**SEVERE, **patch}])
    assert s["state"] == state
    assert s["next"] == state
    assert ("ackToken" in s) == (state == "approved")
    if state == "escalated":
        assert re.search(r"unknown causality or insufficient evidence: R1-1", s["record"]["escalation_reason"])


# ---- refuter ----


def test_refuter_refutes_the_only_blocking_finding_held_for_the_refuter_then_approved_with_a_token(fixture):
    fx, lineage, _ = fixture()
    held = capture_all(fx, lineage, lambda lens: [INFERENTIAL], {"awaitRefuter": True})
    assert held["state"] == "reviewing"
    assert held["next"] == "collect"
    assert held["pending_refutation"] == ["R1-1"]
    assert "ackToken" not in held
    s = good(C.capture_refuter_result(fx.common_dir, lineage, held["revision"], {"result": refuter_result(held["record"], [{"finding_id": "R1-1", "outcome": "refuted"}])}))
    assert s["state"] == "approved"
    assert s["next"] == "approved"
    assert TOKEN.match(s["ackToken"])
    assert s["record"]["refuted_finding_ids"] == ["R1-1"]
    assert len([e for e in s["record"]["admitted_role_results"] if e["role"] == "refuter"]) == 1
    refused(C.capture_refuter_result(fx.common_dir, lineage, s["revision"], {"result": refuter_result(held["record"], [])}), "illegal_state")


@pytest.mark.parametrize("results", [[{"finding_id": "R1-1", "outcome": "corroborated"}], [{"finding_id": "R1-1", "outcome": "inconclusive"}], []])
def test_refuter_that_corroborates_is_inconclusive_or_is_silent_leaves_the_finding_blocking(fixture, results):
    fx, lineage, _ = fixture()
    held = capture_all(fx, lineage, lambda lens: [INFERENTIAL], {"awaitRefuter": True})
    s = good(C.capture_refuter_result(fx.common_dir, lineage, held["revision"], {"result": refuter_result(held["record"], results)}))
    assert s["next"] == "correction_required"
    assert s["record"]["fix_finding_ids"] == ["R1-1"]
    assert s["record"]["refuted_finding_ids"] == []


def test_partly_refuted_only_the_surviving_finding_goes_to_the_correction(fixture):
    fx, lineage, _ = fixture()
    held = capture_all(fx, lineage, lambda lens: [INFERENTIAL, {**INFERENTIAL, "location": "b.txt:1", "claim": "b.txt also breaks"}], {"awaitRefuter": True})
    assert held["pending_refutation"] == ["R1-1", "R1-2"]
    s = good(C.capture_refuter_result(fx.common_dir, lineage, held["revision"], {"result": refuter_result(held["record"], [{"finding_id": "R1-2", "outcome": "refuted"}])}))
    assert s["next"] == "correction_required"
    assert s["record"]["fix_finding_ids"] == ["R1-1"]
    plan = C.plan_correction(fx.common_dir, lineage)
    assert plan["ok"] is True
    assert plan["allowed_paths"] == ["a.txt"]


def test_refuter_refusals_bad_schema_wrong_hash_unknown_or_repeated_finding_second_refuter_and_nothing_is_admitted(fixture):
    fx, lineage, _ = fixture()
    held = capture_all(fx, lineage, lambda lens: [INFERENTIAL], {"awaitRefuter": True})
    rev = held["revision"]
    ok1 = refuter_result(held["record"], [{"finding_id": "R1-1", "outcome": "refuted"}])
    cap = lambda r, result: C.capture_refuter_result(fx.common_dir, lineage, r, {"result": result})  # noqa: E731
    refused(cap(rev, {"results": []}), "schema_invalid")
    refused(cap(rev, {**ok1, "results": [{"finding_id": "R1-1", "outcome": "maybe", "proof_refs": ["x"]}]}), "schema_invalid")
    refused(cap(rev, {**ok1, "refuter_request_hash": sha0()}), "binding_drift")
    refused(cap(rev, refuter_result(held["record"], [{"finding_id": "R1-9", "outcome": "refuted"}])), "unknown_finding")
    refused(cap(rev, refuter_result(held["record"], [{"finding_id": "R1-1", "outcome": "refuted"}, {"finding_id": "R1-1", "outcome": "corroborated"}])), "invalid_input")
    refused(cap("sha256:stale", ok1), "concurrent_update")
    unchanged(fx, lineage, rev)
    done = good(C.complete_review(fx.common_dir, lineage, rev))
    assert done["next"] == "correction_required"
    refused(cap(done["revision"], ok1), "illegal_state")


def test_complete_review_is_refused_before_every_lens_is_admitted(fixture):
    fx, lineage, record = fixture("high")
    refused(C.complete_review(fx.common_dir, lineage, record["revision"]), "lenses_incomplete")
    unchanged(fx, lineage, record["revision"])


# ---- correction ----


def test_plan_correction_returns_the_frozen_severe_findings_the_budget_and_the_allowed_paths_only_when_pending(to_correction, fixture):
    fx, lineage, correction = to_correction()
    plan = C.plan_correction(fx.common_dir, lineage)
    assert plan["ok"] is True
    assert [f["id"] for f in plan["findings"]] == ["R1-1"]
    assert plan["budget"] == 15
    assert plan["attempts_remaining"] == 2
    assert plan["allowed_paths"] == ["a.txt"]
    assert plan["ledger_hash"] == correction["record"]["ledger_hash"]
    assert plan["revision"] == correction["revision"]
    assert plan["lineage_id"] == lineage
    other_fx, other_lineage, _ = fixture()
    refused(C.plan_correction(other_fx.common_dir, other_lineage), "illegal_state")


def test_correction_within_budget_and_scope_validating_then_approved_with_a_token(to_correction):
    fx, lineage, correction = to_correction()
    corrected = edit_a(fx, A_CHANGED.replace("one\n", "ONE\n", 1))
    v = good(C.begin_correction_validation(fx.repository, lineage, correction["revision"], corrected))
    assert v["state"] == "validating"
    assert v["next"] == "validating"
    assert v["record"]["correction_attempts"] == 1
    assert v["record"]["actual_correction_lines"] == 2
    assert v["record"]["correction_target_identity"] == corrected["identity"]
    s = good(C.capture_validator_result(fx.common_dir, lineage, v["revision"], {"result": validator_result(v["record"])}))
    assert s["state"] == "approved"
    assert s["next"] == "approved"
    assert TOKEN.match(s["ackToken"])
    assert len([e for e in s["record"]["admitted_role_results"] if e["role"] == "validator"]) == 1
    assert len(s["record"]["admitted_role_results"]) <= MAX_ADMITTED_ROLE_RESULTS
    refused(C.capture_validator_result(fx.common_dir, lineage, s["revision"], {"result": validator_result(v["record"])}), "illegal_state")


FAIL_CRITERIA = {"original_criteria": {"passed": False, "evidence": ["still broken"]}}
FAIL_REGRESSION = {"correction_regression": {"passed": False, "evidence": ["broke b"], "regressions": [{"location": "a.txt:3", "claim": "new bug", "proof_refs": ["a.txt:3"]}]}}


@pytest.mark.parametrize("over", [FAIL_CRITERIA, FAIL_REGRESSION])
def test_a_validator_that_fails_either_check_reopens_the_second_correction_its_failure_escalates_and_a_third_is_refused(to_correction, over):
    fx, lineage, correction = to_correction()
    first = edit_a(fx, A_CHANGED.replace("one\n", "ONE\n", 1))
    v1 = good(C.begin_correction_validation(fx.repository, lineage, correction["revision"], first))
    reopened = good(C.capture_validator_result(fx.common_dir, lineage, v1["revision"], {"result": validator_result(v1["record"], **over), "correctionCandidateTree": first["candidateTree"]}))
    assert reopened["state"] == "correction_required"
    assert reopened["next"] == "correction_required"
    assert "ackToken" not in reopened
    assert reopened["record"]["correction_attempts"] == 1
    assert reopened["record"]["target_identity"] == first["identity"]
    assert reopened["record"]["original_target_identity"] == correction["record"]["target_identity"]
    assert not any(e["role"] == "validator" for e in reopened["record"]["admitted_role_results"])
    assert reopened["record"]["fix_finding_ids"] == correction["record"]["fix_finding_ids"]
    assert "correction_target_identity" not in reopened["record"]
    plan = C.plan_correction(fx.common_dir, lineage)
    assert plan["ok"] and plan["attempts_remaining"] == 1

    refused(C.begin_correction_validation(fx.repository, lineage, reopened["revision"], first), "correction_unavailable")

    second = edit_a(fx, A_CHANGED.replace("one\n", "UNO\n", 1))
    v2 = good(C.begin_correction_validation(fx.repository, lineage, reopened["revision"], second))
    assert v2["state"] == "validating"
    assert v2["record"]["correction_attempts"] == 2
    s2 = good(C.capture_validator_result(fx.common_dir, lineage, v2["revision"], {"result": validator_result(v2["record"], **over), "correctionCandidateTree": second["candidateTree"]}))
    assert s2["state"] == "escalated"
    assert s2["next"] == "escalated"
    assert "ackToken" not in s2
    assert re.search(r"targeted validator", s2["record"]["escalation_reason"])
    assert s2["record"]["correction_attempts"] == 2
    assert s2["record"]["original_target_identity"] == correction["record"]["target_identity"]
    refused(C.plan_correction(fx.common_dir, lineage), "illegal_state")
    refused(C.begin_correction_validation(fx.repository, lineage, s2["revision"], edit_a(fx, A_CHANGED.replace("one\n", "EINS\n", 1))), "illegal_state")
    unchanged(fx, lineage, s2["revision"])


def test_the_second_correction_can_be_approved_the_approval_binds_the_second_corrected_candidate(to_correction):
    fx, lineage, correction = to_correction()
    first = edit_a(fx, A_CHANGED.replace("one\n", "ONE\n", 1))
    v1 = good(C.begin_correction_validation(fx.repository, lineage, correction["revision"], first))
    reopened = good(C.capture_validator_result(fx.common_dir, lineage, v1["revision"], {"result": validator_result(v1["record"], **FAIL_CRITERIA), "correctionCandidateTree": first["candidateTree"]}))
    second = edit_a(fx, A_CHANGED.replace("one\n", "UNO\n", 1))
    v2 = good(C.begin_correction_validation(fx.repository, lineage, reopened["revision"], second))
    done = good(C.capture_validator_result(fx.common_dir, lineage, v2["revision"], {"result": validator_result(v2["record"]), "correctionCandidateTree": second["candidateTree"]}))
    assert done["state"] == "approved"
    assert TOKEN.match(done["ackToken"])
    assert done["record"]["correction_attempts"] == 2
    assert done["record"]["target_identity"] == second["identity"]
    assert done["record"]["candidate_tree"] == second["candidateTree"]
    assert done["record"]["original_target_identity"] == correction["record"]["target_identity"]


def test_a_lineage_persisted_before_the_change_one_attempt_validating_still_reads_and_resumes_to_approved(to_correction):
    fx, lineage, correction = to_correction()
    corrected = edit_a(fx, A_CHANGED.replace("one\n", "ONE\n", 1))
    v = good(C.begin_correction_validation(fx.repository, lineage, correction["revision"], corrected))
    stored = read_state(fx.common_dir, lineage)
    assert stored["correction_attempts"] == 1
    assert stored["state"] == "validating"
    done = good(C.capture_validator_result(fx.common_dir, lineage, v["revision"], {"result": validator_result(stored), "correctionCandidateTree": corrected["candidateTree"]}))
    assert done["state"] == "approved"
    assert done["record"]["correction_attempts"] == 1


def test_a_second_correction_is_refused_once_validation_has_begun(to_correction):
    fx, lineage, correction = to_correction()
    v = good(C.begin_correction_validation(fx.repository, lineage, correction["revision"], edit_a(fx, A_CHANGED.replace("one\n", "ONE\n", 1))))
    refused(C.plan_correction(fx.common_dir, lineage), "illegal_state")
    refused(C.begin_correction_validation(fx.repository, lineage, v["revision"], edit_a(fx, A_CHANGED.replace("one\n", "UNO\n", 1))), "illegal_state")
    unchanged(fx, lineage, v["revision"])


def test_a_correction_that_touches_a_path_outside_the_frozen_findings_is_refused_and_leaves_the_state_untouched(to_correction):
    fx, lineage, correction = to_correction()
    outside = edit_a(fx, B_CHANGED.replace("bee\n", "BEE\n", 1), "b.txt")
    r = refused(C.begin_correction_validation(fx.repository, lineage, correction["revision"], outside), "correction_out_of_scope")
    assert r["errors"] == ["b.txt"]
    assert r["message"] == "the correction touches paths outside the frozen findings: b.txt"
    unchanged(fx, lineage, correction["revision"])
    assert read_state(fx.common_dir, lineage)["state"] == "correction_required"


def test_a_correction_over_the_line_budget_is_refused_and_leaves_the_state_untouched(to_correction):
    fx, lineage, correction = to_correction()
    big = edit_a(fx, A_CHANGED + "".join(f"more-{i}\n" for i in range(16)))
    refused(C.begin_correction_validation(fx.repository, lineage, correction["revision"], big), "correction_over_budget")
    unchanged(fx, lineage, correction["revision"])
    exact = edit_a(fx, A_CHANGED + "".join(f"more-{i}\n" for i in range(15)))
    assert good(C.begin_correction_validation(fx.repository, lineage, correction["revision"], exact))["record"]["actual_correction_lines"] == 15


def test_validator_refusals_schema_request_hash_target_identity_unavailable_inspection_nothing_is_admitted(to_correction):
    fx, lineage, correction = to_correction()
    v = good(C.begin_correction_validation(fx.repository, lineage, correction["revision"], edit_a(fx, A_CHANGED.replace("one\n", "ONE\n", 1))))
    result = validator_result(v["record"])
    cap = lambda r, res: C.capture_validator_result(fx.common_dir, lineage, r, {"result": res})  # noqa: E731
    rev = v["revision"]
    refused(cap(rev, {**result, "follow_ups": "none"}), "schema_invalid")
    refused(cap(rev, validator_result(v["record"], correction_regression={"passed": False, "evidence": ["x"]})), "schema_invalid")
    refused(cap(rev, {**result, "targeted_validation_request_hash": sha0()}), "binding_drift")
    refused(cap(rev, {**result, "correction_target_identity": sha0("1")}), "binding_drift")
    un = refused(cap(rev, validator_result(v["record"], original_criteria={"passed": True, "evidence": ["x"], "inspection": {"status": "unavailable", "reason": "timed out"}})), "inspection_unavailable")
    assert un["message"] == "original_criteria: timed out"
    refused(cap("sha256:stale", result), "concurrent_update")
    unchanged(fx, lineage, rev)


# ---- binding, schema, duplicates ----


def test_subject_drift_is_refused_with_binding_drift_and_nothing_is_admitted(fixture):
    fx, lineage, record = fixture("high")
    rev = record["revision"]
    mine = lens_input(fx, record, "risk")
    sibling = lens_artifact_subject(fx.common_dir, record, "reliability")
    cap = lambda i: C.capture_lens_result(fx.common_dir, lineage, rev, i)  # noqa: E731
    refused(cap({**mine, "subject": sibling}), "binding_drift")
    refused(cap(lens_input(fx, record, "risk", [], lambda r: r.update(subject_hash=sibling["subject_hash"]))), "binding_drift")
    refused(cap(lens_input(fx, record, "risk", [], lambda r: r.update(subject_hash=sha0()))), "binding_drift")
    refused(cap({**mine, "subject": {**mine["subject"], "candidate_tree": "f" * 40}}), "binding_drift")
    refused(cap({**mine, "subject": {**mine["subject"], "base_tree": "f" * 40, "subject_hash": sibling["subject_hash"]}}), "binding_drift")
    refused(cap({**mine, "subject": None}), "binding_drift")
    refused(cap(lens_input(fx, record, "risk", [], lambda r: r.update(lens="reliability"))), "binding_drift")
    refused(cap(lens_input(fx, record, "risk", [{**SEVERE, "lens": "reliability"}])), "binding_drift")
    unchanged(fx, lineage, rev)
    good(cap(mine))


def test_a_subject_from_another_lineage_is_binding_drift(fixture):
    one, l1, r1 = fixture()
    two, _, r2 = fixture()
    foreign = lens_input(two, r2, "risk")
    refused(C.capture_lens_result(one.common_dir, l1, r1["revision"], foreign), "binding_drift")
    unchanged(one, l1, r1["revision"])


SCHEMA_TWEAKS = [
    lambda r: r.pop("evidence"),
    lambda r: r.update(evidence=["n/a"]),
    lambda r: r.update(extra=True),
    lambda r: r.update(findings=[{"location": "a.txt:1", "severity": "CRITICAL", "claim": "x", "proof_refs": ["y"]}]),
    lambda r: r.update(findings=[{"location": "a.txt", "severity": "MAJOR", "claim": "x", "proof_refs": ["y"]}]),
    lambda r: r.update(inspection={"status": "unavailable", "paths": []}),
    lambda r: r.update(subject_hash="nope"),
]


@pytest.mark.parametrize("tweak", SCHEMA_TWEAKS, ids=range(len(SCHEMA_TWEAKS)))
def test_schema_invalid_lens_results_are_refused_with_errors_and_nothing_is_admitted(fixture, tweak):
    fx, lineage, record = fixture()
    r = refused(C.capture_lens_result(fx.common_dir, lineage, record["revision"], lens_input(fx, record, "risk", [], tweak)), "schema_invalid")
    assert r["message"] == "the lens result does not match the lens schema"
    assert len(r.get("errors", [])) > 0
    refused(C.capture_lens_result(fx.common_dir, lineage, record["revision"], {**lens_input(fx, record, "risk"), "result": "not json"}), "schema_invalid")
    unchanged(fx, lineage, record["revision"])


def test_inspection_must_cover_exactly_the_changed_path_manifest_unavailable_inspection_is_not_admitted(fixture):
    fx, lineage, record = fixture()
    cap = lambda tweak: C.capture_lens_result(fx.common_dir, lineage, record["revision"], lens_input(fx, record, "risk", [], tweak))  # noqa: E731
    refused(cap(lambda r: r.update(inspection={"status": "completed", "paths": ["a.txt"]})), "inspection_incomplete")
    refused(cap(lambda r: r.update(inspection={"status": "completed", "paths": ["a.txt", "b.txt", "c.txt"]})), "inspection_incomplete")
    un = refused(cap(lambda r: r.update(inspection={"status": "unavailable", "paths": [], "reason": "timed out"})), "inspection_unavailable")
    assert un["message"] == "timed out"
    unchanged(fx, lineage, record["revision"])


def test_a_duplicate_lens_an_unselected_lens_and_a_stale_revision_are_refused(fixture):
    fx, lineage, record = fixture("high")
    first = good(C.capture_lens_result(fx.common_dir, lineage, record["revision"], lens_input(fx, record, "risk")))
    refused(C.capture_lens_result(fx.common_dir, lineage, first["revision"], lens_input(fx, record, "risk")), "lens_already_admitted")
    bogus = refused(C.capture_lens_result(fx.common_dir, lineage, first["revision"], {**lens_input(fx, record, "risk"), "lens": "bogus"}), "invalid_input")
    assert bogus["message"] == "lens bogus is not selected for this review"
    stale = refused(C.capture_lens_result(fx.common_dir, lineage, record["revision"], lens_input(fx, record, "resilience")), "concurrent_update")
    assert stale["currentRevision"] == first["revision"]
    assert len(read_state(fx.common_dir, lineage)["admitted_role_results"]) == 1
    unchanged(fx, lineage, first["revision"])
    mono_fx, mono_lineage, mono = fixture()
    refused(C.capture_lens_result(mono_fx.common_dir, mono_lineage, mono["revision"], {**lens_input(mono_fx, mono, "risk"), "lens": "resilience"}), "invalid_input")


# ---- concurrency ----


def test_concurrent_captures_for_different_lenses_on_one_lineage_admit_each_lens_exactly_once_cas(fixture):
    fx, lineage, record = fixture("high")
    attempts: dict[str, int] = {}

    def one(lens):
        revision = record["revision"]
        while True:
            attempts[lens] = attempts.get(lens, 0) + 1
            out = C.capture_lens_result(fx.common_dir, lineage, revision, lens_input(fx, record, lens))
            if out["ok"]:
                return out
            assert out["code"] == "concurrent_update", out["message"]
            revision = out["currentRevision"]

    with ThreadPoolExecutor(4) as pool:
        finals = list(pool.map(one, record["selected_lenses"]))
    stored = read_state(fx.common_dir, lineage)
    assert stored["state"] == "approved"
    assert sorted(e["lens"] for e in stored["admitted_role_results"]) == ["readability", "reliability", "resilience", "risk"]
    assert len([f for f in finals if "ackToken" in f]) == 1, "exactly one capture settles the review and receives the token"
    assert len([f for f in finals if f["next"] == "approved"]) >= 1
    assert any(n > 1 for n in attempts.values()), "at least one capture lost the CAS and retried"


# ---- vendored provider-mirror vectors and embedded schema pinning ----

MIRROR_NAMES = {"lens": "lens", "refuter": "refuter", "validator": "targeted-validator"}


@pytest.mark.parametrize("kind", ["lens", "refuter", "validator"])
def test_provider_mirror_vector_validates_embedded_schema_equals_the_vendored_one_except_id_and_title(kind):
    name = MIRROR_NAMES[kind]
    assert C.result_schema_errors[kind](read_json(MIRROR_ROOT / "vectors" / f"{name}.json")) == []
    vendored = clone(read_json(MIRROR_ROOT / "schemas" / f"{name}.schema.json"))
    embedded = clone(C.EMBEDDED_RESULT_SCHEMAS[kind])
    assert re.match(r"^https://odd-claude\.dev/schema/review/", str(embedded["$id"]))
    for d in (vendored, embedded):
        d.pop("$id", None)
        d.pop("title", None)
    assert embedded == vendored
    for example in vendored.get("examples", []):
        assert C.result_schema_errors[kind](example) == []


def test_embedded_schemas_reject_malformed_results():
    lens = read_json(MIRROR_ROOT / "vectors" / "lens.json")
    assert C.result_schema_errors["lens"]({**lens, "evidence": []}) != []
    assert C.result_schema_errors["lens"]({**lens, "inspection": {"status": "completed"}}) != []
    validator = read_json(MIRROR_ROOT / "vectors" / "targeted-validator.json")
    assert C.result_schema_errors["validator"]({**validator, "follow_ups": [{"observation": "x"}]}) != []
    assert len((MIRROR_ROOT / "vectors" / "refuter.json").read_text()) > 0


def test_preview_correction_validation_writes_nothing_capture_correction_result_records_the_attempt_in_one_transition(to_correction):
    fx, lineage, correction = to_correction()
    rev = correction["revision"]
    corrected = edit_a(fx, A_CHANGED.replace("one\n", "ONE\n", 1))
    preview = C.preview_correction_validation(fx.repository, lineage, rev, corrected)
    assert preview["ok"] is True
    assert preview["record"]["state"] == "validating"
    unchanged(fx, lineage, rev)
    assert read_state(fx.common_dir, lineage)["correction_attempts"] == 0

    refused(C.preview_correction_validation(fx.repository, lineage, rev, edit_a(fx, B_CHANGED.replace("bee\n", "BEE\n", 1), "b.txt")), "correction_out_of_scope")

    result = validator_result(preview["record"])
    refused(C.capture_correction_result(fx.repository, lineage, rev, corrected, {"result": {**result, "targeted_validation_request_hash": sha0()}}), "binding_drift")
    refused(C.capture_correction_result(fx.repository, lineage, rev, corrected, {"result": {**result, "follow_ups": "none"}}), "schema_invalid")
    unchanged(fx, lineage, rev)
    assert read_state(fx.common_dir, lineage)["correction_attempts"] == 0
    refused(C.capture_correction_result(fx.repository, lineage, sha0("9"), corrected, {"result": result}), "concurrent_update")

    s = good(C.capture_correction_result(fx.repository, lineage, rev, corrected, {"result": result}))
    assert s["state"] == "approved"
    assert TOKEN.match(s["ackToken"])
    assert s["record"]["correction_attempts"] == 1
    assert s["record"]["target_identity"] == corrected["identity"]
    assert s["record"]["candidate_tree"] == corrected["candidateTree"]
    assert len([e for e in s["record"]["admitted_role_results"] if e["role"] == "validator"]) == 1
    refused(C.capture_correction_result(fx.repository, lineage, s["revision"], corrected, {"result": result}), "illegal_state")


def test_a_failing_validator_through_capture_correction_result_reopens_the_second_correction_in_one_transition(to_correction):
    fx, lineage, correction = to_correction()
    c2 = edit_a(fx, A_CHANGED.replace("one\n", "ONE\n", 1))
    p2 = C.preview_correction_validation(fx.repository, lineage, correction["revision"], c2)
    assert p2["ok"] is True
    e = good(C.capture_correction_result(fx.repository, lineage, correction["revision"], c2, {"result": validator_result(p2["record"], **FAIL_CRITERIA)}))
    assert e["state"] == "correction_required"
    assert e["record"]["correction_attempts"] == 1
    assert e["record"]["target_identity"] == c2["identity"]
    assert read_state(fx.common_dir, lineage)["revision"] == e["revision"]


def test_approving_after_begin_correction_validation_and_capture_validator_result_also_binds_the_corrected_candidate(to_correction):
    fx, lineage, correction = to_correction()
    original = read_state(fx.common_dir, lineage)["target_identity"]
    corrected = edit_a(fx, A_CHANGED.replace("one\n", "ONE\n", 1))
    v = good(C.begin_correction_validation(fx.repository, lineage, correction["revision"], corrected))
    assert v["record"]["target_identity"] == original, "validating still carries the reviewed candidate"
    assert v["record"]["correction_candidate_tree"] == corrected["candidateTree"]
    s = good(C.capture_validator_result(fx.common_dir, lineage, v["revision"], {"result": validator_result(v["record"])}))
    assert s["record"]["target_identity"] == corrected["identity"]
    assert s["record"]["original_target_identity"] == original


def test_an_unchanged_corrected_candidate_same_tree_or_same_identity_is_refused_as_correction_unavailable_and_leaves_the_state_untouched(to_correction):
    fx, lineage, correction = to_correction()
    rev = correction["revision"]
    current = read_state(fx.common_dir, lineage)
    same_tree = {"candidateTree": current["candidate_tree"], "identity": sha0("3")}
    same_identity = edit_a(fx, A_CHANGED.replace("one\n", "ONE\n", 1))
    refused(C.begin_correction_validation(fx.repository, lineage, rev, same_tree), "correction_unavailable")
    r = refused(C.begin_correction_validation(fx.repository, lineage, rev, {**same_identity, "identity": current["target_identity"]}), "correction_unavailable")
    assert r["message"] == "the corrected candidate is unchanged: make a correction before validating"
    refused(C.preview_correction_validation(fx.repository, lineage, rev, same_tree), "correction_unavailable")
    refused(C.capture_correction_result(fx.repository, lineage, rev, same_tree, {"result": {}}), "correction_unavailable")
    unchanged(fx, lineage, rev)
    good(C.begin_correction_validation(fx.repository, lineage, rev, same_identity))


# ---- verifier regressions (S1): an unchanged correction is refused at every entry point ----


def assert_not_a_correction(fx, lineage, revision):
    f = freeze_snapshot(fx.repo, {"kind": "current-changes"})
    assert f["status"] == "frozen"
    corrected = {"candidateTree": f["snapshot"]["candidateTree"], "identity": f["snapshot"]["identity"]}
    file = Path(fx.common_dir) / "odd-plugin" / "review-transactions" / "v2" / lineage / "review-state.json"
    before = file.read_bytes()
    refused(C.begin_correction_validation(fx.repository, lineage, revision, corrected), "correction_unavailable")
    refused(C.preview_correction_validation(fx.repository, lineage, revision, corrected), "correction_unavailable")
    refused(C.capture_correction_result(fx.repository, lineage, revision, corrected, {"result": {}}), "correction_unavailable")
    assert file.read_bytes() == before, "state byte-identical"
    unchanged(fx, lineage, revision)


def test_s1_an_ignored_only_or_crlf_normalized_change_is_not_a_correction_all_three_entry_points(to_correction):
    fx, lineage, correction = to_correction()
    os.makedirs(os.path.join(fx.common_dir, "info"), exist_ok=True)
    write(os.path.join(fx.common_dir, "info", "exclude"), "ignored.txt\n")
    write(os.path.join(fx.repo, "ignored.txt"), "ignored content\n")
    assert_not_a_correction(fx, lineage, correction["revision"])
    git(fx.repo, "config", "core.autocrlf", "true")
    write(os.path.join(fx.repo, "a.txt"), A_CHANGED.replace("\n", "\r\n"))
    assert_not_a_correction(fx, lineage, correction["revision"])


def test_s1_same_identity_under_a_changed_tree_is_refused_by_preview_and_capture_correction_result_too(to_correction):
    fx, lineage, correction = to_correction()
    changed = edit_a(fx, A_CHANGED.replace("one\n", "ONE\n", 1))
    file = Path(fx.common_dir) / "odd-plugin" / "review-transactions" / "v2" / lineage / "review-state.json"
    before = file.read_bytes()
    forged = {"candidateTree": changed["candidateTree"], "identity": read_state(fx.common_dir, lineage)["target_identity"]}
    refused(C.begin_correction_validation(fx.repository, lineage, correction["revision"], forged), "correction_unavailable")
    refused(C.preview_correction_validation(fx.repository, lineage, correction["revision"], forged), "correction_unavailable")
    refused(C.capture_correction_result(fx.repository, lineage, correction["revision"], forged, {"result": {}}), "correction_unavailable")
    assert file.read_bytes() == before
    unchanged(fx, lineage, correction["revision"])


# ---- extra cases beyond v9's spec (injected clock and token, option shapes, store failures) ----


def test_now_and_random_token_options_are_used_by_the_settle(fixture):
    fx, lineage, record = fixture()
    s = good(C.capture_lens_result(fx.common_dir, lineage, record["revision"], lens_input(fx, record, "risk"), {"now": lambda: "2030-01-02T03:04:05.678Z", "randomToken": lambda: "ab" * 32}))
    assert s["ackToken"] == "ab" * 32
    assert s["record"]["updated_at"] == "2030-01-02T03:04:05.678Z"


def test_a_missing_lineage_propagates_the_store_error(fixture):
    fx, _, _ = fixture()
    from odd_claude.review.store import StoreNotFoundError

    with pytest.raises(StoreNotFoundError):
        C.capture_lens_result(fx.common_dir, "review-00000000000000ff", "x", {"lens": "risk"})
    with pytest.raises(StoreNotFoundError):
        C.plan_correction(fx.common_dir, "review-00000000000000ff")


def test_the_module_has_the_v9_public_surface():
    assert {"capture_lens_result", "complete_review", "capture_refuter_result", "plan_correction", "begin_correction_validation", "preview_correction_validation", "capture_validator_result", "capture_correction_result", "result_schema_errors", "EMBEDDED_RESULT_SCHEMAS"} <= set(dir(C))
    assert set(C.result_schema_errors) == {"lens", "refuter", "validator"}
