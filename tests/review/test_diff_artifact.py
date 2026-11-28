"""Differential: review/artifact against v9 dist/review/artifact.js through the oracle. Pure functions get records built with the
Python state machine (identical JSON on both sides) plus tampered and wrongly typed variants; the tree functions run on real temp
git repos (shared by both sides) with Unicode, nested, deleted, mode-changed and symlinked paths. Exports: ARTIFACT_SUBJECT_SCHEMA,
treeDiffPaths, artifactSubjectFor, manifestFor, lensArtifactSubject, artifactSubjectProblems, refuterRequestHash,
targetedValidationRequestHash, findingPath."""
import os

import pytest
from lib.v9_oracle import DIST, needs_v9
from odd_claude.review import artifact as A
from odd_claude.review import snapshot as S
from odd_claude.review.state import admit_lens_result, begin_validation, require_correction, start

from review.conftest import clone, diff_cases
from review.test_snapshot import Fixture, _hermetic_git_env, git, write  # noqa: F401

pytestmark = needs_v9
MOD = "review/artifact"
V9_ENV = {"GIT_CONFIG_NOSYSTEM": "1"}
T0 = "2026-11-19T10:00:00.000Z"


def hx(c, n=64):
    return (c * n)[:n]


def sha(c):
    return f"sha256:{hx(c)}"


def same(fn, py_fn, calls):
    diff_cases(MOD, fn, py_fn, calls, env=V9_ENV)


def rec(**over):
    base = {"lineageId": f"review-{hx('a', 16)}", "targetIdentity": sha("1"), "projection": "workspace", "baseTree": hx("b", 40), "candidateTree": hx("c", 40),
            "riskLevel": "high", "selectedLenses": ["risk", "reliability"], "originalChangedLines": 8, "now": T0}
    r = start({**base, **over})
    assert r["ok"]
    return r["record"]


def finding(i, lens="reliability", sev="CRITICAL", claim="boom", **extra):
    return {"id": f"R3-{i}", "lens": lens, "severity": sev, "location": f"a/é{i}.txt:{i}", "claim": claim, **extra}


def records():
    out = [rec(), rec(selectedLenses=["risk", "resilience", "readability", "reliability"]), rec(selectedLenses=["readability"], riskLevel="medium"),
           rec(candidateTree=hx("d", 64), baseTree=hx("e", 64)), rec(targetIdentity=sha("f"))]
    m = rec(riskLevel="medium", selectedLenses=["reliability"])
    fs = [finding(2), finding(1), finding(3, sev="MINOR", claim="meh \u00e9 \U0001f600"), finding(4, causal_disposition="pre-existing", claim="old"), finding(5, evidence_class="insufficient")]
    reviewed = admit_lens_result(m, {"lens": "reliability", "findings": fs, "resultHash": sha("2"), "now": T0})["record"]
    out += [m, reviewed, {**reviewed, "refuted_finding_ids": ["R3-1"]}, {**reviewed, "refuted_finding_ids": []}]
    corr = require_correction(reviewed, {"fixFindingIds": ["R3-1", "R3-2"], "now": T0})["record"]
    a = begin_validation(corr, {"actualCorrectionLines": 2, "correctionTargetIdentity": sha("4"), "now": T0})["record"]
    b = begin_validation(corr, {"actualCorrectionLines": 0, "correctionTargetIdentity": sha("5"), "now": T0})["record"]
    c = begin_validation(corr, {"actualCorrectionLines": 1, "now": T0})["record"]
    out += [corr, a, b, c, {k: v for k, v in a.items() if k != "ledger_hash"}, {**a, "actual_correction_lines": None}, {k: v for k, v in a.items() if k != "actual_correction_lines"},
            {**a, "state": "reviewing"}]
    return out


def test_constant_matches_v9():
    assert f'export const ARTIFACT_SUBJECT_SCHEMA = "{A.ARTIFACT_SUBJECT_SCHEMA}";' in (DIST / "review" / "artifact.js").read_text()


def test_artifact_subject_for_every_record_lens_and_digest():
    lenses = ["risk", "resilience", "readability", "reliability", "nope", "", "RISK", "ri\u0301sk", None, 1, ["risk"], {"a": 1}]
    digests = [sha("9"), "x", "", "é\U0001f600", None, 7, 1.5, ["a"], {"k": "v"}]
    calls = [[r, lens, d] for r in records() for lens in lenses for d in digests[:3]] + [[rec(), "risk", d] for d in digests]
    same("artifactSubjectFor", A.artifact_subject_for, calls)


def test_artifact_subject_problems_exhaustive_tampering():
    good = A.artifact_subject_for(rec(), "reliability", sha("9"))
    h = good["subject_hash"]
    cases = [good, None, "x", 1, True, [], [good], {}, {"schema": 1}, {**good, "extra": 1}, {**good, "é\U0001f600": 1, "b": 2, "10": 1, "2": 2},
             {k: v for k, v in good.items() if k != "lens"}, {k: v for k, v in good.items() if k not in ("lens", "role")}, {**good, "subject_hash": sha("0")}]
    for k, vals in {
        "schema": ["x", None, 2, ARTIFACT := "odd-claude.review-artifact-subject/v1"], "lineage_id": ["review-ABCDEF0123456789", "review-" + "a" * 17, None, 5, "review-0123456789abcdef\n"],
        "subject_hash": ["sha256:" + "A" * 64, "sha256:abc", None, 1, h + "\n"], "target_identity": [sha("g"), "x", None], "changed_path_manifest_sha256": ["", None, sha("A")],
        "base_tree": ["z" * 40, hx("a", 39), hx("a", 41), hx("a", 64), hx("a", 40) + "\n", None, 3], "candidate_tree": ["Z", "", hx("f", 64)],
        "role": ["refuter", None, "Lens", 1], "lens": ["risk", "nope", None, 1, "RISK", ["risk"]],
        "selected_order": [0, 1, 2, -1, 1.5, 1.0, 2**53, 2**53 - 1, -0.0, "1", None, True, False, [1], {}, 1e21],
    }.items():
        cases += [{**good, k: v} for v in vals]
    cases += [{**good, "lineage_id": "x", "role": "y", "lens": "z"}, {**good, "selected_order": 3, "lens": "risk"}]
    cases += [A.artifact_subject_for(r, lens, sha("9")) for r in records() for lens in ("risk", "reliability", "readability", "resilience")]
    cases = [c for c in cases if c is not None] + [None]
    same("artifactSubjectProblems", A.artifact_subject_problems, [[clone(c) if c is not None else None] for c in cases])


def test_request_hashes_over_records():
    rs = [[clone(r)] for r in records()]
    same("refuterRequestHash", A.refuter_request_hash, rs)
    same("targetedValidationRequestHash", A.targeted_validation_request_hash, rs)


def test_finding_path_edge_inputs():
    locs = ["src/a.ts:12", "src/a.ts:12-20", "dir/with:colon.ts:3", "a.ts", "a.ts:0", "a.ts:", ":3", "", ":", "a:1:2", "a:1-", "a:1-0", "a:01", "a:10-02", "a:1-2-3", "a b:3", " :3",
            "é/ü.ts:7", "\U0001f600:1", "a\nb:3", "a:3\n", "a\r:3", "a\u2028:3", "a\u2029:3", "a\u0085:3", "\ud800:3", "a\u000b:3", "a\u00a0:3", "a:\u0663", "a:3\u00a0", "ａ:3",
            "x" * 5000 + ":1", "a:" + "9" * 400, "C:\\dir\\f.ts:4", "..:1", "a:1\u0000", None, 5, True, ["a:1"], ["a", "b:1"], [], {"a": 1}, 1.5, -1]
    same("findingPath", A.finding_path, [[x] for x in locs])


# ---- real repositories ----


@pytest.fixture
def make_repo():
    made = []

    def make(commit=True):
        f = Fixture(commit)
        made.append(f)
        return f

    yield make
    for f in made:
        f.cleanup()


def trees_of(f, projection="staged"):
    fr = S.freeze_snapshot(f.repo, {"kind": "current-changes", "projection": projection})
    assert fr["status"] == "frozen", fr
    return fr["snapshot"], fr["repository"]["commonDir"]


def test_tree_functions_on_real_repositories(make_repo):
    f = make_repo()
    r = f.repo
    write(os.path.join(r, "a.txt"), "uno\n")
    os.unlink(os.path.join(r, "b.txt"))
    for name in ["é.txt", "d/é/ü.txt", "😀 emoji.txt", "a b.txt", "ａ.txt", "z.txt", "B.txt", "sp\u00e9cial\"quote.txt", "tab\tname.txt", "d/deep/er/x.txt", "ñ/ñ.txt"]:
        write(os.path.join(r, name), "x\n")
    os.symlink("a.txt", os.path.join(r, "link"))
    write(os.path.join(r, "run.sh"), "echo\n")
    os.chmod(os.path.join(r, "run.sh"), 0o755)
    git(r, "add", "-A")
    snap, cd = trees_of(f)
    calls = [[cd, snap["baseTree"], snap["candidateTree"]], [cd, snap["candidateTree"], snap["baseTree"]], [cd, snap["baseTree"], snap["baseTree"]],
             [cd, S.run_git(r, ["rev-parse", "HEAD^{tree}"], 5000).stdout.decode().strip(), snap["candidateTree"]]]
    same("treeDiffPaths", A.tree_diff_paths, calls)
    bad = [[cd, "nothex", snap["candidateTree"]], [cd, snap["baseTree"], ""], [cd, "0" * 40, snap["candidateTree"]], [cd, snap["baseTree"][:39], snap["candidateTree"]],
           [cd, snap["baseTree"].upper(), snap["candidateTree"]], [cd, snap["baseTree"] + "\n", snap["candidateTree"]], [cd, "f" * 40, "e" * 40], [cd, "a" * 64, "b" * 64],
           [os.path.join(cd, "missing-dir"), snap["baseTree"], snap["candidateTree"]]]
    same("treeDiffPaths", A.tree_diff_paths, bad)
    records_ = [rec(baseTree=snap["baseTree"], candidateTree=snap["candidateTree"], projection="staged", targetIdentity=snap["identity"], selectedLenses=sel, riskLevel="high")
                for sel in (["risk"], ["risk", "reliability"], ["readability"])]
    records_.append(rec(baseTree="0" * 40, candidateTree=snap["candidateTree"]))
    same("manifestFor", A.manifest_for, [[cd, x] for x in records_])
    same("lensArtifactSubject", A.lens_artifact_subject, [[cd, x, lens] for x in records_ for lens in ("risk", "reliability", "resilience", "nope")])
    assert A.manifest_for(cd, records_[0])["digest"] == snap["pathsDigest"]


def test_tree_functions_unborn_and_empty_trees(make_repo):
    f = make_repo(commit=False)
    write(os.path.join(f.repo, "only.txt"), "x\n")
    git(f.repo, "add", "-A")
    snap, cd = trees_of(f)
    same("treeDiffPaths", A.tree_diff_paths, [[cd, snap["baseTree"], snap["candidateTree"]]])
    same("manifestFor", A.manifest_for, [[cd, rec(baseTree=snap["baseTree"], candidateTree=snap["candidateTree"])]])
