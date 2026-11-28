"""Differential: review/status against v9 dist/review/status.js through the oracle. `reviewStatus` is read-only, so v9 and Python read the SAME
real temp git repo and review store (so every path in a message is the same): one repo per lineage state (fresh, low, empty, started, partly
admitted, refuter, completion, correction, validating, approved, burned, burned without receipt, escalated, invalidated, declined, corrupt,
corrupt next to burned, Unicode paths), each read with many option shapes (targets, projections, scan bounds, acknowledgements, bad inputs);
results and thrown messages must be equal. Exports: reviewStatus, REVIEWER_RESULT_SCHEMA."""
import json
import os
import subprocess
from pathlib import Path

import pytest
from lib.v9_oracle import DIST, needs_v9, v9_many
from odd_claude.review import status as S
from odd_claude.review.ack import acknowledge_approved
from odd_claude.review.snapshot import freeze_snapshot
from odd_claude.review.state import admit_lens_result, admit_validator_result, approve, begin_validation, escalate, invalidate, reopen_correction, require_correction
from odd_claude.review.store import read_state, store_root_for

from review.conftest import diff_cases, py_oracle_err
from review.test_status import HASH, NOW, Repo, admit, assessor, finding, git, mutate, start

pytestmark = needs_v9
MOD = "review/status"


def test_constant_equals_v9():
    js = f'import * as m from {json.dumps((DIST / "review" / "status.js").as_uri())}; process.stdout.write(JSON.stringify(m.REVIEWER_RESULT_SCHEMA))'
    assert json.loads(subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True, check=True).stdout) == S.REVIEWER_RESULT_SCHEMA


BASE_OPTS = [
    {}, {"projection": "workspace"}, {"projection": "index"}, {"projection": "bogus"}, {"projection": None}, {"projection": 5}, {"target": None}, {"target": {"kind": "current-changes"}},
    {"target": {"kind": "current-changes"}, "projection": "index"}, {"target": {"kind": "x"}}, {"target": "x"}, {"target": 5}, {"target": []}, {"target": {}},
    {"target": {"kind": "base-diff"}}, {"target": {"kind": "base-diff", "baseRef": "HEAD"}}, {"target": {"kind": "base-diff", "baseRef": "HEAD", "committedOnly": True}},
    {"target": {"kind": "base-diff", "baseRef": "HEAD", "committedOnly": False}}, {"target": {"kind": "base-diff", "baseRef": "HEAD", "committedOnly": "true"}},
    {"target": {"kind": "base-diff", "baseRef": "nope"}}, {"target": {"kind": "base-diff", "baseRef": "é\U0001f600"}}, {"target": {"kind": "base-diff", "baseRef": ""}},
    {"target": {"kind": "base-diff", "baseRef": "-x"}}, {"target": {"kind": "base-diff", "baseRef": 5}}, {"target": {"kind": "base-diff", "baseRef": None}},
    {"limit": 0}, {"limit": 1}, {"limit": 1, "maxScan": 1}, {"maxScan": 0}, {"limit": -1}, {"limit": 1.5}, {"limit": None, "maxScan": None}, {"gitTimeoutMs": 60000},
    {"acknowledgement": {"lineage_id": "x"}}, {"acknowledgement": None}, {"unknown": 1},
]

ACKS = [None, {}, [], "x", "", 0, 5, False, True, {"token": "t"}, {"token": 5}, {"token": None}, {"token": "é\U0001f600\x00"}, {"token": [1, None, "a", [2]]}, {"token": {"a": 1}}, {"token": 1.5},
        {"token": 1e21}, {"token": True}, {"token": 0}]


def ack_variants(ack):
    return [ack, {**ack, "extra": 1}, {**ack, "token": 7}, {**ack, "token": None}, {**ack, "token": "é\U0001f600"}, {**ack, "token": ["a", None, 2.5]}, {**ack, "token": {"k": 1}}, {**ack, "token": True},
            {**ack, "lineage_id": "x"}, {**ack, "target_identity": HASH}, {**ack, "expected_revision": HASH}, {**ack, "lineage_id": 5}, {k: v for k, v in ack.items() if k != "token"}, {k: v for k, v in ack.items() if k != "lineage_id"}]


class World:
    """name -> (repo path, extra option variants); built once."""

    def __init__(self, tmp: Path):
        self.tmp, self.n, self.items = tmp, 0, {}

    def repo(self, dirty=True, files=None):
        self.n += 1
        d = self.tmp / f"w{self.n}"
        d.mkdir()
        r = Repo(d, dirty)
        for name, text in (files or {}).items():
            (r.repo / name).write_text(text)
        return r

    def add(self, name, r, extra=()):
        self.items[name] = (str(r.repo), list(extra))


def build(tmp: Path) -> World:
    w = World(tmp)
    w.add("fresh_high", w.repo())
    w.add("fresh_low_docs", w.repo("docs"))
    r = w.repo(False)
    w.add("empty", r)
    r = w.repo(False)
    git(r.repo, "checkout", "-q", "-b", "f")
    (r.repo / "a.txt").write_text("c1\nc2\n")
    git(r.repo, "commit", "-q", "-am", "c")
    w.add("committed_range", r, [{"target": {"kind": "base-diff", "baseRef": "main", "committedOnly": True}}, {"target": {"kind": "base-diff", "baseRef": "main"}}, {"target": {"kind": "base-workspace-overlay", "baseRef": "main"}}])
    r = w.repo(files={"é\U0001f600 sp ace.txt": "x\ny\n", "café.sh": "#!/bin/sh\nrm -rf /tmp/x\n"})
    git(r.repo, "add", "-A")
    w.add("unicode_paths", r, [{"projection": "index"}])
    r = w.repo()
    s = start(r, "high")
    w.add("started_high", r)
    r = w.repo()
    s = start(r, "high")
    mutate(r, s["lineage_id"], admit("risk"))
    w.add("one_lens_admitted", r)
    r = w.repo()
    s = start(r, "high")
    for lens in ("risk", "resilience", "readability"):
        mutate(r, s["lineage_id"], admit(lens))
    w.add("three_lenses_admitted", r)
    r = w.repo()
    s = start(r, "medium")
    w.add("started_medium", r)
    mutate(r, s["lineage_id"], admit("risk"))
    w.add("completion_required", r)
    r = w.repo()
    s = start(r, "medium")
    mutate(r, s["lineage_id"], admit("risk", [finding()]))
    w.add("refuter_available", r)
    r = w.repo()
    s = start(r, "medium")
    mutate(r, s["lineage_id"], admit("risk", [finding(claim="é\U0001f600 breaks")]))
    mutate(r, s["lineage_id"], lambda rec: require_correction(rec, {"fixFindingIds": ["R1-001"], "now": NOW}))
    w.add("correction_required", r)
    # validating: begin the validation with a corrected candidate that is then reverted, so the working tree is the reviewed one again
    original = (r.repo / "a.txt").read_text()
    (r.repo / "a.txt").write_text("fixed\n")
    fz = freeze_snapshot(str(r.repo), {"kind": "current-changes"})["snapshot"]
    (r.repo / "a.txt").write_text(original)
    mutate(r, s["lineage_id"], lambda rec: begin_validation(rec, {"actualCorrectionLines": 1, "correctionTargetIdentity": fz["identity"], "correctionCandidateTree": fz["candidateTree"], "now": NOW}))
    w.add("validating", r)
    # reopen: the corrected candidate becomes the lineage's; status on that working tree collects a correction again (attempts 1 of 2)
    r2 = w.repo()
    s2 = start(r2, "medium")
    mutate(r2, s2["lineage_id"], admit("risk", [finding()]))
    mutate(r2, s2["lineage_id"], lambda rec: require_correction(rec, {"fixFindingIds": ["R1-001"], "now": NOW}))
    orig2 = (r2.repo / "a.txt").read_text()
    (r2.repo / "a.txt").write_text("fixed\n")
    fz2 = freeze_snapshot(str(r2.repo), {"kind": "current-changes"})["snapshot"]
    (r2.repo / "a.txt").write_text(orig2)
    mutate(r2, s2["lineage_id"], lambda rec: begin_validation(rec, {"actualCorrectionLines": 1, "correctionTargetIdentity": fz2["identity"], "correctionCandidateTree": fz2["candidateTree"], "now": NOW}))
    mutate(r2, s2["lineage_id"], lambda rec: reopen_correction(rec, {"now": NOW}))
    (r2.repo / "a.txt").write_text("fixed\n")
    w.add("reopened_correction", r2)
    r3 = w.repo()
    s3 = start(r3, "medium")
    mutate(r3, s3["lineage_id"], admit("risk", [finding()]))
    mutate(r3, s3["lineage_id"], lambda rec: require_correction(rec, {"fixFindingIds": ["R1-001"], "now": NOW}))
    orig3 = (r3.repo / "a.txt").read_text()
    (r3.repo / "a.txt").write_text("fixed\n")
    fz3 = freeze_snapshot(str(r3.repo), {"kind": "current-changes"})["snapshot"]
    (r3.repo / "a.txt").write_text(orig3)
    mutate(r3, s3["lineage_id"], lambda rec: begin_validation(rec, {"actualCorrectionLines": 1, "correctionTargetIdentity": fz3["identity"], "correctionCandidateTree": fz3["candidateTree"], "now": NOW}))
    mutate(r3, s3["lineage_id"], lambda rec: admit_validator_result(rec, {"resultHash": HASH, "now": NOW}))
    w.add("validator_admitted", r3)
    r = w.repo()
    s = start(r, "high")
    for lens in s["selected_lenses"]:
        mutate(r, s["lineage_id"], admit(lens.removeprefix("review-")))
    token = [""]

    def go(rec):
        o = approve(rec, {"now": NOW})
        token[0] = o.get("ackToken", "")
        return o

    ap = mutate(r, s["lineage_id"], go)
    ack = {"lineage_id": ap["lineage_id"], "target_identity": ap["target_identity"], "expected_revision": ap["revision"], "token": token[0]}
    w.add("approved", r, [{"acknowledgement": a} for a in [*ack_variants(ack), *ACKS]])
    r = w.repo()
    s = start(r, "low")
    a = s["acknowledgement"]
    w.add("low_unacknowledged_approved", r, [{"acknowledgement": {"lineage_id": a["lineage_id"], "target_identity": a["target_identity"], "expected_revision": a["expected_revision"], "token": a["token"]}}])
    acknowledge_approved(r.common_dir, {"lineage": a["lineage_id"], "target": a["target_identity"], "expectedRevision": a["expected_revision"], "token": a["token"]})
    w.add("burned", r)
    r = w.repo()
    s = start(r, "low")
    a = s["acknowledgement"]
    acknowledge_approved(r.common_dir, {"lineage": a["lineage_id"], "target": a["target_identity"], "expectedRevision": a["expected_revision"], "token": a["token"]})
    d = os.path.join(store_root_for(r.common_dir), s["lineage_id"])
    os.remove(os.path.join(d, next(f for f in os.listdir(d) if "receipt" in f)))
    w.add("burned_no_receipt", r)
    r = w.repo()
    s = start(r, "high")
    mutate(r, s["lineage_id"], lambda rec: escalate(rec, {"reason": "needs a human é\U0001f600", "now": NOW}))
    w.add("escalated", r)
    r = w.repo()
    s = start(r, "high")
    mutate(r, s["lineage_id"], lambda rec: invalidate(rec, {"reason": "scope changed", "now": NOW}))
    w.add("invalidated", r)
    r = w.repo()
    from odd_claude.review.start import start_review

    assert start_review({"cwd": str(r.repo), "target": {"kind": "current-changes"}, "consent": "declined", "riskAssessor": assessor("high")})["status"] == "declined"
    w.add("declined", r)
    r = w.repo()
    s = start(r, "medium")
    f = os.path.join(store_root_for(r.common_dir), s["lineage_id"], "review-state.json")
    Path(f).write_text(json.dumps({**json.loads(Path(f).read_text()), "revision": HASH}))
    w.add("corrupt", r)
    r = w.repo()
    s = start(r, "low")
    a = s["acknowledgement"]
    acknowledge_approved(r.common_dir, {"lineage": a["lineage_id"], "target": a["target_identity"], "expectedRevision": a["expected_revision"], "token": a["token"]})
    d2 = os.path.join(store_root_for(r.common_dir), "review-0000000000000000")
    os.mkdir(d2)
    src = Path(os.path.join(store_root_for(r.common_dir), s["lineage_id"], "review-state.json")).read_text()
    Path(d2, "review-state.json").write_text(json.dumps({**json.loads(src), "revision": HASH}))
    w.add("burned_plus_corrupt_sibling", r)
    r = w.repo()
    s = start(r, "high")
    os.mkdir(os.path.join(store_root_for(r.common_dir), "review-ffffffffffffffff"))
    Path(store_root_for(r.common_dir), "review-eeeeeeeeeeeeeeee").mkdir()
    # not "{not json": the store's invalid-json message carries the JSON parser's own text (V8 vs Python), which cannot be ported
    Path(store_root_for(r.common_dir), "review-eeeeeeeeeeeeeeee", "review-state.json").mkdir()
    w.add("garbage_siblings", r, [{"limit": 1}, {"limit": 1, "maxScan": 1}])
    return w


@pytest.fixture(scope="module")
def world(tmp_path_factory):
    return build(tmp_path_factory.mktemp("status-world"))


NAMES = ["fresh_high", "fresh_low_docs", "empty", "committed_range", "unicode_paths", "started_high", "one_lens_admitted", "three_lenses_admitted", "started_medium", "completion_required",
         "refuter_available", "correction_required", "validating", "reopened_correction", "validator_admitted", "approved", "low_unacknowledged_approved", "burned", "burned_no_receipt",
         "escalated", "invalidated", "declined", "corrupt", "burned_plus_corrupt_sibling", "garbage_siblings"]


@pytest.mark.parametrize("name", NAMES)
def test_review_status_equals_v9(world, name):
    repo, extra = world.items[name]
    opts = BASE_OPTS + extra if name in ("fresh_high", "started_high", "approved", "empty", "unicode_paths", "burned") else (BASE_OPTS[:3] + extra + [{"target": {"kind": "base-diff", "baseRef": "HEAD"}}, {"limit": 1}])
    diff_cases(MOD, "reviewStatus", S.review_status, [[repo] + ([o] if o is not None else []) for o in [None, *opts]])


def test_review_status_bad_cwds_and_missing_opts_equal_v9(world, tmp_path):
    repo = world.items["fresh_high"][0]
    plain = tmp_path / "plain"
    plain.mkdir()
    (tmp_path / "f").write_text("x")
    cases = [[str(plain)], [str(tmp_path / "missing")], [str(tmp_path / "f")], [""], [None], [5], [[repo]], [repo + "/a.txt"], [repo + "/"], [repo + "/../" + os.path.basename(repo)], ["rel/path"], ["é\U0001f600"], [repo + "\x00"]]
    diff_cases(MOD, "reviewStatus", S.review_status, cases)
