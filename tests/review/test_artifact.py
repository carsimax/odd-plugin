"""Port of v9 review/artifact.spec.ts (6 tests) plus extra cases (format edges, Unicode paths)."""
import json
import os

import pytest

from odd_claude.review import snapshot as S
from odd_claude.review.artifact import (
    ARTIFACT_SUBJECT_SCHEMA,
    artifact_subject_for,
    artifact_subject_problems,
    finding_path,
    lens_artifact_subject,
    manifest_for,
    refuter_request_hash,
    targeted_validation_request_hash,
    tree_diff_paths,
)
from odd_claude.review.canonical import domain_hash
from odd_claude.review.state import (
    admit_lens_result,
    begin_validation,
    require_correction,
    start,
)

from review.conftest import clone
from review.test_snapshot import Fixture, _hermetic_git_env, git, write  # noqa: F401

T0 = "2026-11-19T10:00:00.000Z"


def hex_(c, n=64):
    return (c * n)[:n]


def sha(c):
    return f"sha256:{hex_(c)}"


def record(**over):
    base = {
        "lineageId": f"review-{hex_('a', 16)}", "targetIdentity": sha("1"), "projection": "workspace", "baseTree": hex_("b", 40),
        "candidateTree": hex_("c", 40), "riskLevel": "high", "selectedLenses": ["risk", "reliability"], "originalChangedLines": 8, "now": T0,
    }
    r = start({**base, **over})
    assert r["ok"], r
    return r["record"]


def test_artifact_subject_for_binds_lineage_target_trees_manifest_digest_lens_and_slot_order_not_the_revision():
    rec = record()
    subject = artifact_subject_for(rec, "reliability", sha("9"))
    assert subject["schema"] == ARTIFACT_SUBJECT_SCHEMA == "odd-claude.review-artifact-subject/v2"
    assert subject["selected_order"] == 1 and subject["role"] == "lens"
    preimage = {k: v for k, v in subject.items() if k != "subject_hash"}
    assert subject["subject_hash"] == domain_hash("review-artifact-subject", 2, preimage)
    assert preimage == {
        "schema": ARTIFACT_SUBJECT_SCHEMA, "lineage_id": rec["lineage_id"], "target_identity": rec["target_identity"],
        "base_tree": rec["base_tree"], "candidate_tree": rec["candidate_tree"], "changed_path_manifest_sha256": sha("9"),
        "role": "lens", "lens": "reliability", "selected_order": 1,
    }
    moved = admit_lens_result(rec, {"lens": "risk", "findings": [], "resultHash": sha("2"), "now": T0})
    assert moved["ok"] and moved["record"]["revision"] != rec["revision"]
    assert artifact_subject_for(moved["record"], "reliability", sha("9"))["subject_hash"] == subject["subject_hash"]
    assert artifact_subject_problems(subject) == []


def test_artifact_subject_for_differs_per_lens_target_tree_and_manifest_unselected_lens_has_no_subject():
    rec = record()
    base = artifact_subject_for(rec, "risk", sha("9"))["subject_hash"]
    others = [
        artifact_subject_for(rec, "reliability", sha("9")), artifact_subject_for(rec, "risk", sha("8")),
        artifact_subject_for(record(candidateTree=hex_("d", 40)), "risk", sha("9")), artifact_subject_for(record(baseTree=hex_("d", 40)), "risk", sha("9")),
        artifact_subject_for(record(targetIdentity=sha("2")), "risk", sha("9")), artifact_subject_for(record(lineageId=f"review-{hex_('e', 16)}"), "risk", sha("9")),
    ]
    assert all(o["subject_hash"] != base for o in others)
    assert artifact_subject_for(rec, "readability", sha("9")) is None
    assert artifact_subject_for(rec, "nope", sha("9")) is None


def test_artifact_subject_problems_rejects_tampering_unknown_and_missing_fields():
    subject = artifact_subject_for(record(), "risk", sha("9"))
    assert artifact_subject_problems({**subject, "lens": "reliability"}) != []
    assert artifact_subject_problems({**subject, "selected_order": 3}) != []
    assert artifact_subject_problems({**subject, "extra": 1}) == ["unknown field extra"]
    assert artifact_subject_problems({**subject, "subject_hash": sha("0")}) == ["subject_hash does not match its binding"]
    missing = {k: v for k, v in subject.items() if k != "lens"}
    assert artifact_subject_problems(missing) == ["missing field lens"]
    assert artifact_subject_problems(None) == ["artifact subject must be an object"]
    assert artifact_subject_problems("x") == ["artifact subject must be an object"]
    assert artifact_subject_problems([]) == ["artifact subject must be an object"]


def test_artifact_subject_problems_names_every_malformed_field():
    s = artifact_subject_for(record(), "risk", sha("9"))
    bad = {**s, "schema": "x", "lineage_id": "r", "subject_hash": "h", "base_tree": "z", "role": "refuter", "lens": "nope", "selected_order": -1}
    assert artifact_subject_problems(bad) == [
        f"schema must be {ARTIFACT_SUBJECT_SCHEMA}", "lineage_id is invalid", "subject_hash must be sha256:<64 hex>",
        "base_tree must be a tree id", "role must be lens", "lens is unknown", "selected_order is invalid",
    ]
    for order in (1.5, True, "1", None, 2**53):
        assert artifact_subject_problems({**s, "selected_order": order}) == ["selected_order is invalid"], order


def test_request_hashes_refuter_binds_the_blocking_findings_validator_needs_a_validating_record_with_a_target():
    rec = record(riskLevel="medium", selectedLenses=["reliability"])
    finding = {"id": "R3-1", "lens": "reliability", "severity": "CRITICAL", "location": "a.txt:1", "claim": "boom"}
    reviewed = admit_lens_result(rec, {"lens": "reliability", "findings": [finding], "resultHash": sha("2"), "now": T0})
    assert reviewed["ok"]
    h = refuter_request_hash(reviewed["record"])
    assert h.startswith("sha256:") and len(h) == 71
    other = admit_lens_result(rec, {"lens": "reliability", "findings": [{**finding, "claim": "different"}], "resultHash": sha("2"), "now": T0})
    assert other["ok"] and refuter_request_hash(other["record"]) != h

    assert targeted_validation_request_hash(reviewed["record"]) is None
    corr = require_correction(reviewed["record"], {"fixFindingIds": ["R3-1"], "now": T0})
    assert corr["ok"]
    assert targeted_validation_request_hash(corr["record"]) is None
    no_target = begin_validation(corr["record"], {"actualCorrectionLines": 1, "now": T0})
    assert no_target["ok"] and targeted_validation_request_hash(no_target["record"]) is None
    a = begin_validation(corr["record"], {"actualCorrectionLines": 1, "correctionTargetIdentity": sha("4"), "now": T0})
    b = begin_validation(corr["record"], {"actualCorrectionLines": 1, "correctionTargetIdentity": sha("5"), "now": T0})
    assert a["ok"] and b["ok"]
    ha = targeted_validation_request_hash(a["record"])
    assert ha.startswith("sha256:") and ha != targeted_validation_request_hash(b["record"])


def test_refuter_request_hash_ignores_non_blocking_findings_and_refutations():
    rec = record(riskLevel="medium", selectedLenses=["reliability"])
    sev = {"id": "R3-1", "lens": "reliability", "severity": "CRITICAL", "location": "a.txt:1", "claim": "boom"}
    minor = {"id": "R3-2", "lens": "reliability", "severity": "MINOR", "location": "a.txt:2", "claim": "meh"}
    both = admit_lens_result(rec, {"lens": "reliability", "findings": [sev, minor], "resultHash": sha("2"), "now": T0})["record"]
    only = admit_lens_result(rec, {"lens": "reliability", "findings": [sev], "resultHash": sha("2"), "now": T0})["record"]
    assert refuter_request_hash(both) == refuter_request_hash(only)
    assert refuter_request_hash({**both, "refuted_finding_ids": ["R3-1"]}) == refuter_request_hash(both)


def test_finding_path_extracts_the_path_of_path_line_and_path_start_end():
    assert finding_path("src/a.ts:12") == "src/a.ts"
    assert finding_path("src/a.ts:12-20") == "src/a.ts"
    assert finding_path("dir/with:colon.ts:3") == "dir/with:colon.ts"
    assert finding_path("a.ts") is None
    assert finding_path("a.ts:0") is None
    assert finding_path("a.ts:") is None
    assert finding_path(":3") is None
    assert finding_path("a\nb.ts:3") is None  # `.` does not match a line terminator
    assert finding_path("a\r.ts:3") is None
    assert finding_path("a .ts:3") is None
    assert finding_path("é/ü.ts:7") == "é/ü.ts"
    assert finding_path("a.ts:1\n") is None
    assert finding_path("a.ts:٣") is None  # ASCII digits only


@pytest.fixture
def repo(tmp_path):
    f = Fixture(commit=False)
    yield f
    f.cleanup()


def test_tree_diff_paths_and_manifest_for_reproduce_the_frozen_snapshots_paths_and_digest_from_the_trees_alone(repo):
    r = repo.repo
    write(os.path.join(r, "a.txt"), "one\n")
    write(os.path.join(r, "b.txt"), "bee\n")
    git(r, "add", "-A")
    git(r, "commit", "-q", "-m", "init")
    write(os.path.join(r, "b.txt"), "bee\nmore\n")
    write(os.path.join(r, "a.txt"), "uno\n")
    write(os.path.join(r, "d", "é.txt"), "x\n")
    git(r, "add", "-A")
    frozen = S.freeze_snapshot(r, {"kind": "current-changes", "projection": "staged"})
    assert frozen["status"] == "frozen"
    snap, common = frozen["snapshot"], frozen["repository"]["commonDir"]
    assert tree_diff_paths(common, snap["baseTree"], snap["candidateTree"]) == snap["paths"]
    rec = record(riskLevel="medium", selectedLenses=["risk"], baseTree=snap["baseTree"], candidateTree=snap["candidateTree"], targetIdentity=snap["identity"], projection="staged")
    manifest = manifest_for(common, rec)
    assert manifest == {"paths": snap["paths"], "digest": snap["pathsDigest"]}
    assert manifest["digest"] == S.digest_paths(snap["paths"])
    subject = lens_artifact_subject(common, rec, "risk")
    assert subject["changed_path_manifest_sha256"] == snap["pathsDigest"]
    assert lens_artifact_subject(common, rec, "reliability") is None
    with pytest.raises(ValueError, match="tree ids must be full hexadecimal object ids"):
        tree_diff_paths(common, "nothex", snap["candidateTree"])
    with pytest.raises(ValueError, match="tree ids must be full hexadecimal object ids"):
        tree_diff_paths(common, snap["baseTree"], "")


def test_tree_diff_paths_sorts_by_utf8_bytes_and_reports_git_failures(repo):
    r = repo.repo
    write(os.path.join(r, "seed.txt"), "s\n")
    git(r, "add", "-A")
    git(r, "commit", "-q", "-m", "init")
    for name in ["z.txt", "ａ.txt", "é.txt", "a b.txt", "😀.txt", "B.txt"]:
        write(os.path.join(r, name), "x\n")
    git(r, "add", "-A")
    frozen = S.freeze_snapshot(r, {"kind": "current-changes", "projection": "staged"})
    snap, common = frozen["snapshot"], frozen["repository"]["commonDir"]
    got = tree_diff_paths(common, snap["baseTree"], snap["candidateTree"])
    assert got == sorted(got, key=lambda p: p.encode("utf-8")) and len(got) == 6
    with pytest.raises(S.SnapshotError, match="git diff-tree failed"):
        tree_diff_paths(common, "0" * 40, snap["candidateTree"])


def test_schema_constant_and_json_roundtrip_of_a_subject():
    s = artifact_subject_for(record(), "risk", sha("9"))
    assert artifact_subject_problems(json.loads(json.dumps(clone(s)))) == []
