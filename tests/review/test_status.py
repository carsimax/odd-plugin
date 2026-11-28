"""Port of v9 review/status.spec.ts (13 tests) plus extra cases; real temp git repos, nothing outside tmp_path."""
import json
import os
import subprocess
from pathlib import Path

import pytest
from odd_claude.review.ack import acknowledge_approved
from odd_claude.review.contract import is_recoverable_stop, is_terminal_stop, verify_binding
from odd_claude.review.schema import ValidateOptions, validate
from odd_claude.review.start import start_review
from odd_claude.review.state import admit_lens_result, approve, escalate, invalidate, require_correction
from odd_claude.review.status import REVIEWER_RESULT_SCHEMA, review_status
from odd_claude.review.store import list_lineages, read_state, store_root_for, update_state

from review.conftest import INTEGRATION_ROOT, clone

NOW = "2099-01-01T00:00:00.000Z"  # never precedes created_at
HASH = "sha256:" + "7" * 64


def git(cwd, *args):
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_")}
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    r = subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-C", str(cwd), *args], env=env, capture_output=True, text=True)
    assert r.returncode == 0, f"git {args} failed: {r.stderr}"
    return r.stdout


class Repo:
    def __init__(self, base: Path, dirty):
        self.repo = (base / "repo")
        self.repo.mkdir()
        self.repo = self.repo.resolve()
        git(self.repo, "init", "-q", "-b", "main")
        (self.repo / "a.txt").write_text("one\ntwo\nthree\n")
        (self.repo / "README.md").write_text("# t\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "init")
        if dirty == "docs":
            (self.repo / "README.md").write_text("# t\n\nmore docs\n")
        elif dirty is not False:
            (self.repo / "a.txt").write_text("one\nTWO\nthree\nfour\nfive\n")
        self.common_dir = str((self.repo / ".git").resolve())


@pytest.fixture
def make_repo(tmp_path):
    n = [0]

    def make(dirty=True):
        n[0] += 1
        d = tmp_path / f"r{n[0]}"
        d.mkdir()
        return Repo(d, dirty)

    return make


def assessor(level):
    return lambda snapshot, repository: {
        "level": level,
        "reasons": [{"code": "non_executable_only"} if level == "low" else {"code": "shell_source", "signal": "shell_process", "path": "a.txt"}],
        "evidence": [] if level == "low" else ["shell scripting in a.txt"],
    }


def start(r, level):
    o = start_review({"cwd": str(r.repo), "target": {"kind": "current-changes"}, "consent": "granted", "riskAssessor": assessor(level)})
    assert o["status"] == "started", json.dumps(o)
    return o["result"]


def mutate(r, lineage, fn):
    cur = read_state(r.common_dir, lineage)
    return update_state(r.common_dir, lineage, cur["revision"], fn)["record"]


def admit(lens, findings=()):
    return lambda rec: admit_lens_result(rec, {"lens": lens, "findings": list(findings), "resultHash": HASH, "now": NOW})


# ---- structural validation against the vendored status-v5 schema (ids mapped to odd-claude) ----

V2 = INTEGRATION_ROOT / "v2" / "schemas"
UPSTREAM = "-".join(["gentle", "ai"])  # vendored ids carry the upstream product prefix
ARGUMENT_RENAMES = {"lineage": "lineage_id", "target": "target_identity", "expected-revision": "expected_revision"}


def load(path):
    text = Path(path).read_text(encoding="utf-8")
    text = (
        text.replace(f"{UPSTREAM}.review", "odd-claude.review")
        .replace(f'"^{UPSTREAM} review acknowledge-approved"', '"^review_acknowledge_approved$"')
        .replace(f'"^{UPSTREAM} review status(?: |$)"', '"^review_status$"')
        .replace(f'"^{UPSTREAM} review [a-z][a-z-]*"', '"^(review_start|review_complete|review_acknowledge_approved)$"')
    )
    schema = json.loads(text)
    ack = (((schema.get("$defs") or {}).get("approved_acknowledgement_execution") or {}).get("properties") or {}).get("arguments", {}).get("prefixItems") or []
    for item in ack:
        c = item["properties"]["name"]
        c["const"] = ARGUMENT_RENAMES.get(c["const"], c["const"])
    return schema


def status_violations(envelope):
    path = str(V2 / "status-v5.schema.json")
    schema = clone(load(path))
    del schema["allOf"]
    del schema["$defs"]["next_transition"]["allOf"]
    del schema["$defs"]["transition_input"]["allOf"]
    schema["$defs"]["transition_input"]["properties"]["artifact_subject"] = True
    schema["properties"]["consumed"] = True
    schema["$defs"]["transition_collection"]["properties"]["command"] = True
    schema["$defs"]["transition_collection"]["properties"]["arguments"] = True
    schema["$defs"]["transition_input"]["properties"]["command"] = True
    return validate(schema, envelope, ValidateOptions(base=path, load=lambda i: load(i)))


def checked(env):
    assert status_violations(env) == []
    assert env["forecast"]["steps"][0]["kind"] == env["next_transition"]["kind"]
    assert env["forecast"]["steps"][0]["reason_code"] == env["next_transition"]["reason_code"]
    assert env["forecast"]["horizon"] == ("terminal" if env["next_transition"]["kind"] == "stop" else "partial")
    return env


def finding(**over):
    return {"id": "R1-001", "lens": "risk", "severity": "BLOCKER", "location": "a.txt:1", "claim": "x", "evidence_class": "deterministic", "causal_disposition": "introduced", **over}


def test_fresh_target_execute_review_start_bound_to_the_target_nothing_written(make_repo):
    r = make_repo()
    env = checked(review_status(str(r.repo)))
    assert env["next_transition"]["kind"] == "execute"
    assert env["next_transition"]["reason_code"] == "fresh_target_ready"
    ex = env["next_transition"]["execute"]
    assert ex["operation"] == "review.start"
    assert ex["binding"] == {"target_identity": env["target_identity"]}
    assert next(a for a in ex["arguments"] if a["name"] == "target_identity")["value"] == env["target_identity"]
    assert env["action"] == "start"
    assert env["consumed"] == {"status": "not_consumed", "truncated": False, "problems": []}
    assert "authority" not in env
    assert not os.path.exists(store_root_for(r.common_dir))
    assert [a["token"] for a in ex["arguments"]][1:2] == ["--contract=odd-claude.review-integration/v2"]
    assert ex["arguments"][-2:] == [{"name": "target", "value": "current-changes", "token": "--target=current-changes"}, {"name": "projection", "value": "workspace", "token": "--projection=workspace"}]


def test_fresh_low_risk_target_execute_review_start_with_the_low_risk_reason(make_repo):
    r = make_repo("docs")
    env = checked(review_status(str(r.repo)))
    assert env["next_transition"]["reason_code"] == "native_low_risk_verification"
    assert env["next_transition"]["execute"]["operation"] == "review.start"


def test_started_lineage_collect_one_binding_per_selected_lens_bindings_verify_and_then_drift(make_repo):
    r = make_repo()
    started = start(r, "high")
    env = checked(review_status(str(r.repo)))
    assert env["authority"]["lineage_id"] == started["lineage_id"]
    assert env["authority"]["state"] == "reviewing"
    assert env["next_transition"]["kind"] == "collect"
    assert env["next_transition"]["reason_code"] == "reviewer_results_required"
    inputs = env["next_transition"]["collect"]["inputs"]
    assert [i["name"] for i in inputs] == [f"reviewer_result_{lens}" for lens in ["risk", "resilience", "readability", "reliability"]]
    rec = read_state(r.common_dir, started["lineage_id"])
    binding = lambda i: next(a for a in i["arguments"] if a["name"] == "binding")["value"]  # noqa: E731
    for i in inputs:
        ok = verify_binding(binding(i), {"targetIdentity": env["target_identity"], "lineage": rec, "commonDir": r.common_dir})
        assert ok["ok"] is True, json.dumps(ok)
        assert i["capture_operation"] == "review.capture-result"
        assert i["schema"] == REVIEWER_RESULT_SCHEMA
    after = mutate(r, started["lineage_id"], admit("risk"))
    stale = verify_binding(binding(inputs[1]), {"targetIdentity": env["target_identity"], "lineage": after, "commonDir": r.common_dir})
    assert (stale["ok"], stale.get("code"), stale.get("field")) == (False, "binding_drift", "revision")
    env2 = checked(review_status(str(r.repo)))
    assert len(env2["next_transition"]["collect"]["inputs"]) == 3
    c = env2["next_transition"]["collect"]
    assert c["command"] == "review_capture_group"
    assert [a["name"] for a in c["arguments"]] == ["cwd", "lineage_id", "bindings", "target", "projection"]
    assert json.loads(c["arguments"][2]["value"]) == [binding(i) for i in c["inputs"]]


def test_reviewing_all_lenses_admitted_with_a_blocking_finding_optional_refuter_is_collected(make_repo):
    r = make_repo()
    started = start(r, "medium")
    mutate(r, started["lineage_id"], admit("risk", [finding()]))
    env = checked(review_status(str(r.repo)))
    assert env["next_transition"]["kind"] == "collect"
    assert env["next_transition"]["reason_code"] == "refuter_results_available"
    c = env["next_transition"]["collect"]
    assert c["command"] == "review_capture" and c["inputs"][0]["name"] == "refuter_result"


def test_reviewing_no_blocking_findings_execute_review_complete(make_repo):
    r = make_repo()
    started = start(r, "medium")
    mutate(r, started["lineage_id"], admit("risk"))
    env = checked(review_status(str(r.repo)))
    assert env["next_transition"]["reason_code"] == "review_completion_required"
    ex = env["next_transition"]["execute"]
    assert ex["operation"] == "review.validate" and ex["command"] == "review_complete"
    assert ex["preconditions"] == [{"name": "state", "value": "reviewing"}]
    assert env["replayability"] == "status_required" and env["action"] == "validate"


def test_correction_required_collect_the_corrected_candidate(make_repo):
    r = make_repo()
    started = start(r, "medium")
    mutate(r, started["lineage_id"], admit("risk", [finding()]))
    mutate(r, started["lineage_id"], lambda rec: require_correction(rec, {"fixFindingIds": ["R1-001"], "now": NOW}))
    env = checked(review_status(str(r.repo)))
    assert env["authority"]["state"] == "correction_required"
    assert env["next_transition"]["reason_code"] == "correction_required"
    assert env["next_transition"]["collect"]["inputs"][0]["name"] == "corrected_candidate"
    assert env["next_transition"]["collect"]["command"] == "review_run"
    assert env["frozen"]["tier"] == "medium"


def test_all_lenses_admitted_and_approved_execute_acknowledge_approved_with_the_supplied_token(make_repo):
    r = make_repo()
    started = start(r, "high")
    for lens in started["selected_lenses"]:
        mutate(r, started["lineage_id"], admit(lens.removeprefix("review-")))
    token = [""]

    def go(rec):
        o = approve(rec, {"now": NOW})
        if o["ok"]:
            token[0] = o["ackToken"]
        return o

    approved = mutate(r, started["lineage_id"], go)
    ack = {"lineage_id": approved["lineage_id"], "target_identity": approved["target_identity"], "expected_revision": approved["revision"], "token": token[0]}
    env = checked(review_status(str(r.repo), {"acknowledgement": ack}))
    assert env["next_transition"]["kind"] == "execute"
    assert env["next_transition"]["reason_code"] == "approved_acknowledgement_required"
    ex = env["next_transition"]["execute"]
    assert ex["operation"] == "review.acknowledge-approved"
    assert [a["name"] for a in ex["arguments"]] == ["cwd", "lineage_id", "target_identity", "expected_revision", "token"]
    assert ex["arguments"][4]["value"] == token[0]
    assert env["replayability"] == "not_replayable"
    assert ex["binding"] == {"lineage_id": approved["lineage_id"], "revision": approved["revision"], "target_identity": approved["target_identity"]}
    no_token = checked(review_status(str(r.repo)))
    assert no_token["next_transition"]["reason_code"] == "acknowledgement_token_unavailable"
    assert is_recoverable_stop(no_token["next_transition"]["reason_code"]) is True
    wrong = checked(review_status(str(r.repo), {"acknowledgement": {**ack, "expected_revision": HASH}}))
    assert wrong["next_transition"]["reason_code"] == "corrupted_or_unverifiable_authority"


def test_burned_target_stop_target_already_acknowledged_and_consumed_true(make_repo):
    r = make_repo()
    started = start(r, "low")
    ack = started["acknowledgement"]
    acknowledge_approved(r.common_dir, {"lineage": ack["lineage_id"], "target": ack["target_identity"], "expectedRevision": ack["expected_revision"], "token": ack["token"]})
    env = checked(review_status(str(r.repo)))
    assert env["next_transition"]["kind"] == "stop"
    assert env["next_transition"]["reason_code"] == "target_already_acknowledged"
    assert is_terminal_stop("target_already_acknowledged") is True
    assert env["consumed"]["status"] == "consumed"
    assert env["action"] == "stop"
    assert env["authority"]["lineage_id"] == started["lineage_id"]


def test_burned_state_without_a_valid_receipt_consumed_is_unknown_not_consumed_reported(make_repo):
    r = make_repo()
    started = start(r, "low")
    ack = started["acknowledgement"]
    acknowledge_approved(r.common_dir, {"lineage": ack["lineage_id"], "target": ack["target_identity"], "expectedRevision": ack["expected_revision"], "token": ack["token"]})
    d = os.path.join(store_root_for(r.common_dir), started["lineage_id"])
    receipt = next(f for f in os.listdir(d) if "receipt" in f)
    os.remove(os.path.join(d, receipt))
    env = checked(review_status(str(r.repo)))
    assert env["consumed"]["status"] == "unknown"
    assert len(env["consumed"]["problems"]) > 0
    assert env["next_transition"]["reason_code"] == "target_already_acknowledged"


def test_escalated_and_invalidated_lineages_stop(make_repo):
    r = make_repo()
    started = start(r, "high")
    mutate(r, started["lineage_id"], lambda rec: escalate(rec, {"reason": "needs a human", "now": NOW}))
    esc = checked(review_status(str(r.repo)))
    assert esc["next_transition"]["reason_code"] == "escalated"
    assert esc["forecast"]["horizon"] == "terminal"
    assert is_terminal_stop("escalated") is True
    r2 = make_repo()
    started = start(r2, "high")
    mutate(r2, started["lineage_id"], lambda rec: invalidate(rec, {"reason": "scope changed", "now": NOW}))
    inv = checked(review_status(str(r2.repo)))
    assert inv["next_transition"]["reason_code"] == "invalidated"
    assert is_recoverable_stop("invalidated") is True


def test_empty_diff_stop_not_due_no_store(make_repo):
    r = make_repo(False)
    env = checked(review_status(str(r.repo)))
    assert env["next_transition"]["kind"] == "stop"
    assert env["next_transition"]["reason_code"] == "not_due"
    assert env["projection"]["paths"] == []
    assert not os.path.exists(store_root_for(r.common_dir))
    assert not os.path.exists(os.path.join(r.common_dir, "odd-plugin"))


def test_a_declined_candidate_stops_with_consent_declined_reading_never_creates_lineages(make_repo):
    r = make_repo()
    o = start_review({"cwd": str(r.repo), "target": {"kind": "current-changes"}, "consent": "declined", "riskAssessor": assessor("high")})
    assert o["status"] == "declined"
    env = checked(review_status(str(r.repo)))
    assert env["next_transition"]["reason_code"] == "consent_declined"
    assert list_lineages(r.common_dir)["lineages"] == []


def test_a_corrupt_lineage_for_the_same_target_stops_status_with_corrupted_or_unverifiable_authority(make_repo):
    r = make_repo()
    started = start(r, "medium")
    f = os.path.join(store_root_for(r.common_dir), started["lineage_id"], "review-state.json")
    Path(f).write_text(json.dumps({**json.loads(Path(f).read_text()), "revision": HASH}))
    with pytest.raises(Exception):
        read_state(r.common_dir, started["lineage_id"])
    env = checked(review_status(str(r.repo)))
    assert env["next_transition"]["kind"] == "stop"
    assert env["next_transition"]["reason_code"] == "corrupted_or_unverifiable_authority"


def test_an_acknowledged_target_stays_terminal_even_with_a_corrupt_lineage_for_the_same_target(make_repo):
    r = make_repo()
    started = start(r, "low")
    ack = started["acknowledgement"]
    acknowledge_approved(r.common_dir, {"lineage": ack["lineage_id"], "target": ack["target_identity"], "expectedRevision": ack["expected_revision"], "token": ack["token"]})
    d = os.path.join(store_root_for(r.common_dir), "review-0000000000000000")
    os.mkdir(d)
    src = Path(os.path.join(store_root_for(r.common_dir), started["lineage_id"], "review-state.json")).read_text()
    Path(d, "review-state.json").write_text(json.dumps({**json.loads(src), "revision": HASH}))
    with pytest.raises(Exception):
        read_state(r.common_dir, "review-0000000000000000")
    env = checked(review_status(str(r.repo)))
    assert env["next_transition"]["reason_code"] == "target_already_acknowledged"


# ---- extra cases ----


def test_base_diff_target_args_and_committed_only(make_repo):
    r = make_repo(False)
    git(r.repo, "checkout", "-q", "-b", "f")
    (r.repo / "a.txt").write_text("changed\nline\n")
    git(r.repo, "commit", "-q", "-am", "c")
    env = checked(review_status(str(r.repo), {"target": {"kind": "base-diff", "baseRef": "main", "committedOnly": True}}))
    ex = env["next_transition"]["execute"]
    assert [a["token"] for a in ex["arguments"][-3:]] == ["--target=base-diff", "--base_ref=main", "--committed_only=true"]
    assert env["projection"]["kind"] == "base-diff"
    env2 = checked(review_status(str(r.repo), {"target": {"kind": "base-diff", "baseRef": "main"}}))
    assert [a["name"] for a in env2["next_transition"]["execute"]["arguments"][-2:]] == ["target", "base_ref"]


def test_invalid_candidates_raise_and_an_empty_ack_object_is_unverifiable(make_repo, tmp_path):
    with pytest.raises(Exception, match="not_a_repository|not inside|does not exist"):
        review_status(str(tmp_path / "missing"))
    with pytest.raises(Exception):
        review_status(str(make_repo().repo), {"target": {"kind": "base-diff", "baseRef": "nope-ref"}})
    r = make_repo()
    started = start(r, "high")
    for lens in started["selected_lenses"]:
        mutate(r, started["lineage_id"], admit(lens.removeprefix("review-")))
    mutate(r, started["lineage_id"], lambda rec: approve(rec, {"now": NOW}))
    assert review_status(str(r.repo), {"acknowledgement": {}})["next_transition"]["reason_code"] == "corrupted_or_unverifiable_authority"
    assert review_status(str(r.repo), {"acknowledgement": None})["next_transition"]["reason_code"] == "acknowledgement_token_unavailable"


def test_projection_reports_the_initial_and_current_identities(make_repo):
    r = make_repo()
    start(r, "medium")
    p = review_status(str(r.repo))["projection"]
    assert p["initial_snapshot_identity"] == p["current_snapshot_identity"] and p["initial_review_tree"] == p["current_candidate_tree"]
    assert p["paths"] == ["a.txt"] and p["schema"] == "odd-claude.review-integration.projection/v1"
