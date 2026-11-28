"""Port of v9 review/start.spec.ts (21 tests) plus extra cases; real temp git repos, nothing outside tmp_path."""
import json
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from odd_claude.review.ack import _iso_now
from odd_claude.review.consent import REVIEW_CONTRACT, decline_path_for, declines_dir_for, off_path_command, read_decline, record_decline
from odd_claude.review.schema import ValidateOptions, validate
from odd_claude.review.start import MAX_LENS_REASON, START_SCHEMA, snapshot_target_of, start_review
from odd_claude.review.state import burn, correction_budget
from odd_claude.review.store import list_lineages, read_state, update_state

from review.conftest import INTEGRATION_ROOT, clone, read_json

NOW = "2026-02-03T04:05:06.000Z"


def git(cwd, *args):
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_")}
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    r = subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-C", str(cwd), *args], env=env, capture_output=True, text=True)
    assert r.returncode == 0, f"git {args} failed: {r.stderr}"
    return r.stdout


class Repo:
    def __init__(self, base: Path, dirty: bool):
        self.repo = (base / "repo").resolve() if (base / "repo").exists() else base / "repo"
        self.repo.mkdir()
        self.repo = self.repo.resolve()
        git(self.repo, "init", "-q", "-b", "main")
        (self.repo / "a.txt").write_text("one\ntwo\nthree\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "init")
        if dirty:
            (self.repo / "a.txt").write_text("one\nTWO\nthree\nfour\nfive\n")
        self.common_dir = str((self.repo / ".git").resolve())
        self.state_root = Path(self.common_dir) / "odd-plugin" / "review-transactions"

    def write(self, text):
        (self.repo / "a.txt").write_text(text)


@pytest.fixture
def make_repo(tmp_path):
    return lambda dirty=True: Repo(tmp_path, dirty)


def assess(level, **extra):
    return lambda snapshot, repository: {
        "level": level,
        "reasons": [{"code": "non_executable_only"} if level == "low" else {"code": "shell_source", "signal": "shell_process", "path": "a.txt"}],
        "evidence": [] if level == "low" else ["shell scripting in a.txt"],
        **extra,
    }


def base(r, level, **over):
    return {"cwd": str(r.repo), "target": {"kind": "current-changes"}, "consent": "granted", "riskAssessor": assess(level), **over}


V2 = INTEGRATION_ROOT / "v2" / "schemas"


def violations(file, patch, value):
    path = str(V2 / file)
    schema = clone(read_json(path))
    patch(schema)
    return validate(schema, value, ValidateOptions(base=path, load=lambda i: json.loads(Path(i).read_text(encoding="utf-8"))))


def consent_violations(v):
    def patch(s):
        s["properties"]["schema"]["const"] = "odd-claude.review-integration.consent/v3"
        s["properties"]["contract"]["const"] = REVIEW_CONTRACT
        s["properties"]["off_path"]["properties"]["command"]["const"] = off_path_command()
        s["$defs"]["choice"]["properties"]["invocation"]["pattern"] = "^review_answer_consent --contract odd-claude\\.review-integration/v2 .+ --consent (granted|declined)$"

    return violations("consent-v3.schema.json", patch, v)


def start_violations(v):
    def patch(s):
        s["properties"]["schema"]["const"] = START_SCHEMA
        s["properties"]["contract"]["const"] = REVIEW_CONTRACT
        del s["allOf"]
        s["properties"]["acknowledgement"] = True
        del s["dependentRequired"]["target_identity"]
        del s["dependentRequired"]["target_mode"]

    return violations("start-v4.schema.json", patch, v)


def started(o):
    assert o["status"] == "started", json.dumps(o)
    return o["result"]


def test_empty_diff_is_not_due_and_touches_no_store(make_repo):
    r = make_repo(dirty=False)
    o = start_review(base(r, "high"))
    assert o == {"status": "not_due", "reason": "no_changes", "kind": "current-changes", "projection": "workspace"}
    assert not os.path.exists(os.path.join(r.common_dir, "odd-plugin"))


def test_low_risk_is_approved_immediately_token_returned_once_no_consent_needed(make_repo):
    r = make_repo()
    result = started(start_review(base(r, "low", consent="relay")))
    assert result["action"] == "closed" and result["state"] == "approved"
    assert result["selected_lenses"] == [] and result["lenses_required"] is False
    assert start_violations(result) == []
    ack = result["acknowledgement"]
    assert re.fullmatch(r"[0-9a-f]{64}", ack["token"])
    assert ack["lineage_id"] == result["lineage_id"] and ack["target_identity"] == result["target_identity"]
    rec = read_state(r.common_dir, result["lineage_id"])
    assert rec["revision"] == ack["expected_revision"] and rec["state"] == "approved"
    assert ack["token"] not in json.dumps(rec), "raw token is never stored"
    assert burn(rec, {"now": _iso_now(), "token": ack["token"]})["ok"] is True
    again = started(start_review(base(r, "low")))
    assert again["action"] == "replayed" and "acknowledgement" not in again


@pytest.mark.parametrize("level", ["medium", "high"])
def test_medium_and_high_risk_with_relay_return_a_consent_v3_envelope_and_create_no_state(make_repo, level):
    r = make_repo()
    o = start_review(base(r, level, consent="relay"))
    assert o["status"] == "consent_required"
    e = o["envelope"]
    assert consent_violations(e) == []
    assert e["risk_level"] == level and e["blocking"] is True
    assert [c["answer"] for c in e["choices"]] == ["granted", "declined"]
    assert e["risk_evidence"] == ["shell scripting in a.txt"] and e["changed_files"] == 1
    assert re.search(r"--target current-changes ", e["choices"][0]["invocation"])
    assert f"--target-identity {e['target_identity']} " in e["choices"][0]["invocation"]
    assert e["choices"][1]["invocation"].endswith(" --consent declined")
    assert not re.search(r"odd-claude review start|gentle", json.dumps(e))
    assert not r.state_root.exists()
    assert not os.path.exists(os.path.join(r.common_dir, "odd-plugin", "declines"))


def test_relay_envelope_carries_the_explicit_lenses_and_base_diff_flags_es_locale_is_localized(make_repo):
    r = make_repo()
    git(r.repo, "checkout", "-q", "-b", "feat")
    git(r.repo, "commit", "-q", "-am", "work")
    o = start_review(base(r, "medium", consent="relay", target={"kind": "base-diff", "baseRef": "main", "committedOnly": True}, lenses=["review-reliability"], lensesReason="it's a retry loop", locale="es-MX"))
    assert o["status"] == "consent_required"
    assert consent_violations(o["envelope"]) == []
    inv = o["envelope"]["choices"][0]["invocation"]
    assert "--target base-diff --base-ref main --committed-only " in inv
    assert "--lenses reliability --lenses-reason 'it'\\''s a retry loop'" in inv
    assert re.search("revisión", o["envelope"]["headline"])


def test_declined_records_a_candidate_scoped_decline_atomically_and_creates_no_state(make_repo):
    r = make_repo()
    o = start_review(base(r, "high", consent="declined", now=lambda: NOW))
    assert o["status"] == "declined"
    tid = o["target_identity"]
    assert read_decline(r.common_dir, tid) == {"schema": "odd-claude.review-decline/v1", "target_identity": tid, "projection": "workspace", "risk_level": "high", "declined_at": NOW}
    assert o["record_path"] == os.path.join(r.common_dir, "odd-plugin", "declines", f"{tid[7:]}.json")
    assert set(o) == {"status", "target_identity", "projection", "risk_level", "record_path"}
    assert not r.state_root.exists()
    assert os.listdir(os.path.join(r.common_dir, "odd-plugin", "declines")) == [f"{tid[7:]}.json"], "no temp files left"
    start_review(base(r, "high", consent="declined", now=lambda: "2030-01-01T00:00:00.000Z"))
    assert read_decline(r.common_dir, tid)["declined_at"] == NOW
    r.write("other\n")
    assert start_review(base(r, "high", consent="relay"))["status"] == "consent_required"


def test_granted_creates_a_readable_state_with_the_frozen_identity_lenses_and_budget(make_repo):
    r = make_repo()
    for level, lenses in (("medium", ["review-risk"]), ("high", ["review-risk", "review-resilience", "review-readability", "review-reliability"])):
        r.write(f"{level}\n" * 3)
        result = started(start_review(base(r, level)))
        assert result["action"] == "created" and result["state"] == "reviewing"
        assert result["selected_lenses"] == lenses
        assert re.fullmatch(r"review-[0-9a-f]{16}", result["lineage_id"])
        assert "acknowledgement" not in result
        assert start_violations(result) == []
        rec = read_state(r.common_dir, result["lineage_id"])
        assert rec["state"] == "reviewing" and rec["target_identity"] == result["target_identity"] and rec["risk_level"] == level
        assert rec["selected_lenses"] == [x[7:] for x in lenses]
        assert rec["correction_budget"] == correction_budget(rec["original_changed_lines"]) == result["correction_budget"]
        assert result["changed_lines"] == rec["original_changed_lines"] and result["changed_files"] == 1
        assert rec["base_tree"] == result["base_tree"] and rec["candidate_tree"] == result["candidate_tree"]


def test_medium_focus_lens_from_the_assessor_picks_the_lens(make_repo):
    r = make_repo()
    assert started(start_review(base(r, "medium", riskAssessor=assess("medium", focusLens="readability"))))["selected_lenses"] == ["review-readability"]


def test_medium_unknown_focus_lens_is_an_invalid_risk_assessment(make_repo):
    r = make_repo()
    o = start_review(base(r, "medium", riskAssessor=assess("medium", focusLens="nope")))
    assert o == {"status": "refused", "code": "invalid_risk_assessment", "message": 'focusLens "nope" is not a known lens'}
    assert not r.state_root.exists()


def test_explicit_lens_selection_is_honored_when_storable_refused_otherwise(make_repo):
    r = make_repo()

    def code(over, level="medium"):
        o = start_review(base(r, level, **over))
        assert o["status"] == "refused", json.dumps(o)
        return o["code"]

    assert code({"lenses": ["review-nonsense"], "lensesReason": "x"}) == "invalid_lenses"
    assert code({"lenses": ["risk", "risk"], "lensesReason": "x"}, "high") == "invalid_lenses"
    assert code({"lenses": ["readability", "risk"], "lensesReason": "x"}, "high") == "invalid_lenses"
    assert code({"lenses": [], "lensesReason": "x"}) == "invalid_lenses"
    assert code({"lenses": ["risk", "resilience", "readability", "reliability", "risk"], "lensesReason": "x"}, "high") == "invalid_lenses"
    assert code({"lenses": ["risk"]}) == "invalid_lenses"
    assert code({"lenses": ["risk"], "lensesReason": "  "}) == "invalid_lenses"
    assert code({"lenses": ["risk"], "lensesReason": "x" * (MAX_LENS_REASON + 1)}) == "invalid_lenses"
    assert code({"lensesReason": "orphan"}) == "invalid_lenses"
    assert code({"lenses": ["risk"], "lensesReason": "x"}, "low") == "invalid_lenses"
    assert code({"lenses": ["risk", "reliability"], "lensesReason": "x"}) == "invalid_lenses"
    assert not r.state_root.exists(), "refusals create nothing"
    ok = started(start_review(base(r, "medium", lenses=["reliability"], lensesReason="retry logic")))
    assert ok["selected_lenses"] == ["review-reliability"]
    assert read_state(r.common_dir, ok["lineage_id"])["selected_lenses"] == ["reliability"]


def test_lens_refusal_messages_are_exact_and_count_utf16_units(make_repo):
    r = make_repo()
    msg = lambda over, level="medium": start_review(base(r, level, **over))["message"]  # noqa: E731
    assert msg({"lenses": ["bogus"], "lensesReason": "x"}) == 'unknown review lens "bogus"'
    assert msg({"lenses": [5], "lensesReason": "x"}) == "unknown review lens 5"
    assert msg({"lenses": ["risk"]}) == "an explicit lens selection needs a non-empty reason of at most 500 characters"
    assert msg({"lenses": ["risk", "reliability"], "lensesReason": "x"}) == "medium risk reviews exactly one lens"
    assert msg({"lensesReason": "x"}) == "a lens reason needs an explicit lens selection"
    # 251 astral characters are 502 UTF-16 units: refused, although only 251 code points
    assert "non-empty reason" in msg({"lenses": ["risk"], "lensesReason": "\U0001f600" * 251})
    assert start_review(base(r, "medium", lenses=["risk"], lensesReason="\U0001f600" * 250))["status"] == "started"


def test_high_risk_honors_an_explicit_pertinent_subset_and_stores_exactly_those_lenses(make_repo):
    r = make_repo()
    ok = started(start_review(base(r, "high", lenses=["risk", "reliability"], lensesReason="auth + retries")))
    assert ok["selected_lenses"] == ["review-risk", "review-reliability"] and ok["state"] == "reviewing"
    assert start_violations(ok) == []
    assert read_state(r.common_dir, ok["lineage_id"])["selected_lenses"] == ["risk", "reliability"]
    r.write("next\n")
    o = start_review(base(r, "high", consent="relay", lenses=["readability"], lensesReason="naming"))
    assert o["status"] == "consent_required"
    assert "--lenses readability --lenses-reason naming" in o["envelope"]["choices"][0]["invocation"]


def test_explicit_full_lens_set_is_honored_for_high_risk(make_repo):
    r = make_repo()
    allv = ["risk", "resilience", "readability", "reliability"]
    ok = started(start_review(base(r, "high", lenses=allv, lensesReason="whole 4R")))
    assert read_state(r.common_dir, ok["lineage_id"])["selected_lenses"] == allv


def test_a_repeated_start_for_the_same_candidate_replays_the_live_lineage_even_under_relay(make_repo):
    r = make_repo()
    first = started(start_review(base(r, "high")))
    second = started(start_review(base(r, "high")))
    assert second["action"] == "replayed" and second["lineage_id"] == first["lineage_id"] and second["state"] == "reviewing"
    assert start_violations(second) == []
    assert started(start_review(base(r, "high", consent="relay")))["lineage_id"] == first["lineage_id"]
    assert list_lineages(r.common_dir)["lineages"] == [first["lineage_id"]]


def test_a_burned_candidate_is_refused_with_target_already_acknowledged(make_repo):
    r = make_repo()
    first = started(start_review(base(r, "low")))
    ack = first["acknowledgement"]
    update_state(r.common_dir, first["lineage_id"], ack["expected_revision"], lambda rec: burn(rec, {"now": _iso_now(), "token": ack["token"]}))
    for consent in ("granted", "relay", "declined"):
        o = start_review(base(r, "low", consent=consent))
        assert o == {"status": "refused", "code": "target_already_acknowledged", "message": "this candidate was already reviewed and acknowledged", "lineage_id": first["lineage_id"]}
    assert list_lineages(r.common_dir)["lineages"] == [first["lineage_id"]]


def test_concurrent_starts_for_one_candidate_create_exactly_one_lineage(make_repo):
    r = make_repo()
    with ThreadPoolExecutor(8) as pool:
        outcomes = list(pool.map(lambda _: start_review(base(r, "high")), range(8)))
    results = [started(o) for o in outcomes]
    assert len({x["lineage_id"] for x in results}) == 1
    assert sum(x["action"] == "created" for x in results) == 1
    assert sum(x["action"] == "replayed" for x in results) == 7
    assert len(list_lineages(r.common_dir)["lineages"]) == 1


def test_a_different_candidate_gets_its_own_lineage(make_repo):
    r = make_repo()
    a = started(start_review(base(r, "medium")))
    r.write("changed again\n")
    b = started(start_review(base(r, "medium")))
    assert a["lineage_id"] != b["lineage_id"] and a["target_identity"] != b["target_identity"]
    assert len(list_lineages(r.common_dir)["lineages"]) == 2


def test_bad_input_and_bad_risk_assessments_are_refused_before_anything_is_written(make_repo):
    r = make_repo()

    def refused(over):
        o = start_review(base(r, "high", **over))
        assert o["status"] == "refused"
        return o["code"], o["message"]

    assert refused({"consent": "maybe"}) == ("invalid_input", "consent must be relay, granted or declined")
    assert refused({"target": {"kind": "bogus"}}) == ("invalid_input", "target kind must be current-changes or base-diff")
    assert refused({"target": {"kind": "base-diff", "baseRef": ""}}) == ("invalid_input", "base-diff needs a non-empty baseRef")
    assert refused({"projection": "nope"}) == ("invalid_input", "projection must be workspace or staged")
    assert refused({"riskAssessor": lambda s, rp: {"level": "extreme", "reasons": [], "evidence": []}})[0] == "invalid_risk_assessment"
    assert refused({"riskAssessor": assess("high", reasons=[])}) == ("invalid_risk_assessment", "the risk assessment needs a low/medium/high level, at least one reason and an evidence list")
    assert refused({"riskAssessor": None}) == ("invalid_input", "riskAssessor is required")
    assert refused({"target": None}) == ("invalid_input", "target is required")
    assert refused({"target": {"kind": "base-diff", "baseRef": " ﻿ "}}) == ("invalid_input", "base-diff needs a non-empty baseRef")
    assert not r.state_root.exists()


def test_staged_projection_freezes_the_index_and_reports_it(make_repo):
    r = make_repo()
    git(r.repo, "add", "a.txt")
    result = started(start_review(base(r, "medium", projection="staged")))
    assert result["projection"] == "staged"
    assert read_state(r.common_dir, result["lineage_id"])["projection"] == "staged"


def test_expected_target_identity_a_different_candidate_is_binding_drift_and_the_right_one_starts(make_repo):
    r = make_repo()
    consent = start_review(base(r, "medium", consent="relay"))
    assert consent["status"] == "consent_required"
    wrong = "sha256:" + "0" * 64
    drift = start_review(base(r, "medium", consent="granted", expectedTargetIdentity=wrong))
    assert drift == {"status": "refused", "code": "binding_drift", "message": "the candidate is no longer the one the consent was asked for; nothing was started"}
    assert list_lineages(r.common_dir)["lineages"] == []
    assert start_review(base(r, "medium", consent="declined", expectedTargetIdentity=wrong))["status"] == "refused"
    assert read_decline(r.common_dir, consent["envelope"]["target_identity"]) is None
    ok = start_review(base(r, "medium", consent="granted", expectedTargetIdentity=consent["envelope"]["target_identity"]))
    assert ok["status"] == "started" and len(list_lineages(r.common_dir)["lineages"]) == 1


def corrupt(r, lineage):
    f = Path(r.common_dir) / "odd-plugin" / "review-transactions" / "v2" / lineage / "review-state.json"
    f.write_text(json.dumps({**json.loads(f.read_text()), "revision": "sha256:" + "7" * 64}))


def test_a_corrupt_lineage_for_the_same_target_refuses_start_with_authority_error(make_repo):
    r = make_repo()
    first = started(start_review(base(r, "low")))
    corrupt(r, first["lineage_id"])
    o = start_review(base(r, "low"))
    assert o["status"] == "refused" and o["code"] == "authority_error" and o["lineage_id"] == first["lineage_id"]
    assert o["message"] == f"lineage {first['lineage_id']} cannot be read safely; no new review is opened until it is repaired"
    assert len(list_lineages(r.common_dir)["lineages"]) == 1


def test_record_decline_is_create_only_an_existing_valid_record_is_never_replaced(make_repo):
    r = make_repo()
    tid = "sha256:" + "a" * 64
    rec = {"target_identity": tid, "projection": "workspace", "risk_level": "high", "declined_at": "2026-01-01T00:00:00.000Z"}
    path = decline_path_for(r.common_dir, tid)
    os.makedirs(declines_dir_for(r.common_dir))
    existing = json.dumps({"schema": "odd-claude.review-decline/v1", "target_identity": tid, "projection": "staged", "risk_level": "medium", "declined_at": "2020-01-01T00:00:00.000Z"})
    Path(path).write_text(existing)
    assert read_decline(r.common_dir, tid)
    assert record_decline(r.common_dir, rec)["created"] is False
    assert Path(path).read_text() == existing
    other = "sha256:" + "b" * 64
    assert record_decline(r.common_dir, {**rec, "target_identity": other})["created"] is True
    assert read_decline(r.common_dir, other)["declined_at"] == rec["declined_at"]
    assert record_decline(r.common_dir, {**rec, "target_identity": other, "declined_at": "2027-01-01T00:00:00.000Z"})["created"] is False


def test_a_malformed_existing_decline_file_is_replaced_by_the_first_valid_record(make_repo):
    r = make_repo()
    tid = "sha256:" + "c" * 64
    rec = {"target_identity": tid, "projection": "workspace", "risk_level": "high", "declined_at": "2026-01-01T00:00:00.000Z"}
    os.makedirs(declines_dir_for(r.common_dir))
    Path(decline_path_for(r.common_dir, tid)).write_text("not json")
    assert read_decline(r.common_dir, tid) is None
    assert record_decline(r.common_dir, rec)["created"] is True
    assert read_decline(r.common_dir, tid)["declined_at"] == rec["declined_at"]


def test_a_corrupt_lineage_for_a_different_target_does_not_block_start(make_repo):
    r = make_repo()
    first = started(start_review(base(r, "low")))
    corrupt(r, first["lineage_id"])
    r.write("completely\ndifferent\ncontent\n")
    second = started(start_review(base(r, "low")))
    assert second["lineage_id"] != first["lineage_id"]
    assert len(list_lineages(r.common_dir)["lineages"]) == 2


def test_snapshot_target_of_maps_targets():
    assert snapshot_target_of({}) == {"kind": "current-changes", "projection": "workspace"}
    assert snapshot_target_of({"projection": "staged"}) == {"kind": "current-changes", "projection": "staged"}
    assert snapshot_target_of({"target": {"kind": "base-diff", "baseRef": "m", "committedOnly": True}}) == {"kind": "base-diff", "baseRef": "m"}
    assert snapshot_target_of({"target": {"kind": "base-diff", "baseRef": "m"}}) == {"kind": "base-workspace-overlay", "baseRef": "m"}


def test_seams_make_lineage_token_and_time_deterministic(make_repo):
    r = make_repo()
    result = started(start_review(base(r, "low", randomLineage=lambda: "review-" + "ab" * 8, randomToken=lambda: "c" * 64, now=lambda: NOW)))
    assert result["lineage_id"] == "review-" + "ab" * 8 and result["acknowledgement"]["token"] == "c" * 64
    assert read_state(r.common_dir, result["lineage_id"])["created_at"] == NOW


def test_a_lineage_id_collision_is_retried_then_raised(make_repo):
    from odd_claude.review.store import StoreAlreadyExistsError

    r = make_repo()
    started(start_review(base(r, "high", randomLineage=lambda: "review-" + "11" * 8)))
    r.write("second\n")
    seq = iter(["review-" + "11" * 8, "review-" + "22" * 8])
    assert started(start_review(base(r, "high", randomLineage=lambda: next(seq))))["lineage_id"] == "review-" + "22" * 8
    r.write("third\n")
    with pytest.raises(StoreAlreadyExistsError):
        start_review(base(r, "high", randomLineage=lambda: "review-" + "11" * 8))
