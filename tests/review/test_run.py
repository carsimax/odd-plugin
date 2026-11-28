"""Port of v9 review/run.spec.ts (72 tests) plus extra cases; real temp git repos, nothing outside tmp_path. The reviewer is an in-process
fake that answers from the prompt's own echo line (as in the spec); the integration tests use the fake `claude` binary of test_runner
(the real `claude` is never called). The sandboxed data dir keeps the active-profile read away from the real ~/.odd-claude."""
import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest
from odd_claude.lib.profiles import clear_profile, set_role, use_profile
from odd_claude.lib.state import StateOptions
from odd_claude.review import run as RUN
from odd_claude.review.ack import is_target_consumed
from odd_claude.review.artifact import lens_artifact_subject, tree_diff_paths
from odd_claude.review.capture import begin_correction_validation, capture_lens_result, capture_validator_result, plan_correction
from odd_claude.review.consent import read_decline
from odd_claude.review.run import MAX_TRANSITIONS, AbortSignal, pending_correction_lineage, run_review, validate_reviewer_options
from odd_claude.review.runner import REVIEWER_ARGUMENTS, reviewer_arguments
from odd_claude.review.snapshot import digest_paths, freeze_snapshot, resolve_repository, snapshot_identity
from odd_claude.review.start import start_review
from odd_claude.review.state import begin_validation, state_revision
from odd_claude.review.status import review_status
from odd_claude.review.store import StoreCorruptError, list_lineages, read_receipt, read_state, store_root_for, update_state

from review.conftest import REPO_ROOT
from review.test_runner import fake_factory, make_fake  # noqa: F401

SRC = str(REPO_ROOT / "src")


def git(cwd, *args):
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_")}
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    r = subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-C", str(cwd), *args], env=env, capture_output=True, text=True)
    assert r.returncode == 0, f"git {args} failed: {r.stderr}"
    return r.stdout


@pytest.fixture(autouse=True)
def sandbox(tmp_path, monkeypatch):
    """No test may read the real profile state: the data dir and HOME point into tmp_path."""
    home = tmp_path / "home"
    home.mkdir()
    for k in ("CLAUDE_PLUGIN_DATA", "ODD_CLAUDE_HOME"):
        monkeypatch.delenv(k, raising=False)
    for k in [k for k in os.environ if k.upper().startswith("GIT_")]:
        monkeypatch.delenv(k)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("ODD_CLAUDE_DATA", str(home / "data"))


class Repo:
    def __init__(self, base: Path, dirty: bool):
        (base / "repo").mkdir()
        self.repo = str((base / "repo").resolve())
        git(self.repo, "init", "-q", "-b", "main")
        Path(self.repo, "a.txt").write_text("one\ntwo\nthree\n")
        Path(self.repo, "b.txt").write_text("bee\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "init")
        if dirty:
            Path(self.repo, "a.txt").write_text("one\nTWO\nthree\nfour\nfive\n")
        self.common_dir = os.path.realpath(os.path.join(self.repo, ".git"))

    def write(self, name, text):
        Path(self.repo, name).write_text(text)


@pytest.fixture
def make_repo(tmp_path):
    n = [0]

    def make(dirty=True):
        n[0] += 1
        d = tmp_path / f"w{n[0]}"
        d.mkdir()
        return Repo(d, dirty)

    return make


@pytest.fixture
def r(make_repo):
    return make_repo()


def assess(level):
    return lambda snapshot, repository: {
        "level": level,
        "reasons": [{"code": "non_executable_only"} if level == "low" else {"code": "shell_source", "signal": "shell_process", "path": "a.txt"}],
        "evidence": [] if level == "low" else ["shell scripting in a.txt"],
    }


SEVERE = {
    "location": "a.txt:1", "severity": "CRITICAL", "claim": "a.txt breaks on empty input", "proof_refs": ["a.txt:1 reads the first line unchecked"],
    "evidence_class": "deterministic", "causal_disposition": "introduced",
}


class Calls:
    def __init__(self):
        self.prompts, self.opts, self.roles, self.finished = [], [], [], []
        self.active = self.max_active = 0
        self.lock = threading.Lock()


def section(prompt, name):
    m = re.search(rf"<<<ODD-DATA-\w+ {name}>>>\n([\s\S]*?)\n<<<END-ODD-DATA-\w+ {name}>>>", prompt)
    assert m, f"prompt has a {name} section"
    return m.group(1)


def fake_runner(findings=None, delay_ms=None, raw=None, fail=None, during=None, validator_fails=False):
    """An in-process reviewer: answers from the prompt's own echo line and records every call."""
    calls = Calls()

    def runner(prompt, opts):
        head = re.search(r"Role: (\w+)(?:, lens: (\w+))?\.", prompt)
        role, lens = head.group(1), head.group(2)
        key = lens or role
        with calls.lock:
            calls.prompts.append(prompt)
            calls.opts.append(opts)
            calls.roles.append(key)
            calls.active += 1
            calls.max_active = max(calls.max_active, calls.active)
        try:
            if during:
                during()
            if delay_ms and key in delay_ms:
                time.sleep(delay_ms[key] / 1000)
            if fail and key in fail:
                return fail[key]
            if raw and key in raw:
                return {"ok": True, "stdout": raw[key], "elapsedMs": 1}
            echo = json.loads(re.search(r"Echo these fields verbatim in the result: (\{.*\})", prompt).group(1))
            if role == "lens":
                result = {**echo, "inspection": {"status": "completed", "paths": section(prompt, "changed-path-manifest").split("\n")}, "findings": (findings or {}).get(lens, []), "evidence": ["reviewed the complete candidate scope"]}
            elif role == "refuter":
                ids = [f["id"] for f in json.loads(section(prompt, "findings"))]
                result = {**echo, "results": [{"finding_id": i, "outcome": "refuted", "proof_refs": ["a.txt:1 handles the empty input"]} for i in ids]}
            else:
                result = {**echo, "original_criteria": {"passed": not validator_fails, "evidence": ["a.txt:1 now guards the empty input"]}, "correction_regression": {"passed": True, "evidence": ["the regression test passes"]}, "follow_ups": []}
            return {"ok": True, "stdout": f"```json\n{json.dumps(result)}\n```\n", "elapsedMs": 1}
        finally:
            with calls.lock:
                calls.active -= 1
                calls.finished.append(key)

    return calls, runner


def is_(o, kind):
    assert o["outcome"] == kind, json.dumps(o)[:800]
    return o


def inp(r, **over):
    return {"cwd": r.repo, **over}


def grant(r, level, **extra):
    s = start_review({"cwd": r.repo, "target": {"kind": "current-changes"}, "consent": "granted", "riskAssessor": assess(level), **extra})
    assert s["status"] == "started", s
    return s["result"]["lineage_id"]


def forecast_then_run(r, lineage, deps, **over):
    forecast = is_(run_review(inp(r, lineageId=lineage, **over), deps), "forecast")
    done = run_review(inp(r, lineageId=lineage, **over, reviewerRunAcknowledged=True, reviewerRunBinding=forecast["reviewer_run_binding"]), deps)
    return forecast, done


def state_of(r, lineage):
    return read_state(r.common_dir, lineage)


def state_file(r, lineage):
    return os.path.join(store_root_for(r.common_dir), lineage, "review-state.json")


def sha(path):
    import hashlib

    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def to_correction_required(r, deps):
    lineage = grant(r, "medium")
    is_(forecast_then_run(r, lineage, deps)[1], "input-required")
    assert state_of(r, lineage)["state"] == "correction_required"
    return lineage


ORIGINAL_A = "one\nTWO\nthree\nfour\nfive\n"
FIXED_A = "ONE\nTWO\nthree\nfour\nfive\n"
SEVERE_DEPS = lambda: (lambda c_r: (c_r[0], {"riskAssessor": assess("medium"), "runner": c_r[1]}))(fake_runner(findings={"risk": [SEVERE]}))  # noqa: E731


# ---- low risk, not due, already acknowledged ----


def test_low_risk_approved_immediately_with_0_lenses_acknowledged_no_reviewer_runs(r):
    calls, runner = fake_runner()
    out = is_(run_review(inp(r), {"riskAssessor": assess("low"), "runner": runner}), "closed")
    assert out["risk_level"] == "low"
    assert len(calls.prompts) == 0
    rec = state_of(r, out["lineage_id"])
    assert rec["selected_lenses"] == []
    assert rec["burned"] is True
    assert is_target_consumed(r.common_dir, out["target_identity"])["consumed"] is True
    assert out["acknowledgement"]["outcome"] == "acknowledged"
    again = is_(run_review(inp(r), {"riskAssessor": assess("low"), "runner": runner}), "stopped")
    assert again["reason_code"] == "target_already_acknowledged"
    assert again["terminal"] is True
    assert len(list_lineages(r.common_dir)["lineages"]) == 1


def test_not_due_nothing_changed_nothing_created(make_repo):
    r = make_repo(dirty=False)
    calls, runner = fake_runner()
    out = is_(run_review(inp(r), {"riskAssessor": assess("high"), "runner": runner}), "not-due")
    assert len(calls.prompts) == 0
    assert list_lineages(r.common_dir)["lineages"] == []
    assert "lineage_id" not in out


# ---- consent ----


def test_consent_required_the_envelope_comes_back_untouched_the_run_never_answers_it(r):
    calls, runner = fake_runner()
    out = is_(run_review(inp(r), {"riskAssessor": assess("medium"), "runner": runner}), "consent-required")
    expected = start_review({"cwd": r.repo, "target": {"kind": "current-changes"}, "consent": "relay", "riskAssessor": assess("medium")})
    assert expected["status"] == "consent_required"
    assert out["envelope"] == expected["envelope"]
    assert len(calls.prompts) == 0
    assert list_lineages(r.common_dir)["lineages"] == []
    assert read_decline(r.common_dir, out["envelope"]["target_identity"]) is None


def test_resume_by_lineage_id_after_consent_was_granted_forecast_first_then_the_acknowledged_run_closes_it(r):
    lineage = grant(r, "medium")
    calls, runner = fake_runner()
    deps = {"riskAssessor": assess("medium"), "runner": runner}
    before = state_of(r, lineage)
    forecast = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    assert forecast["lineage_id"] == lineage
    assert [[s["role"], s.get("lens")] for s in forecast["reviewers"]] == [["lens", "risk"]]
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", forecast["reviewer_run_binding"])
    assert forecast["forecast"]["steps"][0]["reason_code"] == "reviewer_results_required"
    assert state_of(r, lineage)["revision"] == before["revision"], "the forecast changed nothing"
    assert len(calls.prompts) == 0
    done = run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=forecast["reviewer_run_binding"]), deps)
    assert is_(done, "closed")["lineage_id"] == lineage
    assert len(calls.prompts) == 1, "exactly one reviewer ran, once"
    assert state_of(r, lineage)["burned"] is True


def test_resume_after_consent_declined_a_typed_stop_nothing_runs(r):
    s = start_review({"cwd": r.repo, "target": {"kind": "current-changes"}, "consent": "declined", "riskAssessor": assess("medium")})
    assert s["status"] == "declined"
    calls, runner = fake_runner()
    out = is_(run_review(inp(r), {"riskAssessor": assess("medium"), "runner": runner}), "stopped")
    assert out["reason_code"] == "consent_declined"
    assert out["terminal"] is False
    assert len(calls.prompts) == 0
    unknown = is_(run_review(inp(r, lineageId="review-0123456789abcdef"), {"riskAssessor": assess("medium"), "runner": runner}), "blocked")
    assert unknown["code"] == "unknown_lineage"


# ---- forecast gate ----


def test_forecast_reviewers_run_only_for_the_acknowledged_binding_a_missing_or_different_binding_runs_nothing(r):
    lineage = grant(r, "medium")
    calls, runner = fake_runner()
    deps = {"riskAssessor": assess("medium"), "runner": runner}
    rev = state_of(r, lineage)["revision"]
    assert is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True), deps), "blocked")["code"] == "invalid_input"
    wrong = is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=f"sha256:{'0' * 64}"), deps), "binding-drift")
    assert wrong["field"] == "forecast"
    unack = is_(run_review(inp(r, lineageId=lineage, reviewerRunBinding=f"sha256:{'0' * 64}"), deps), "forecast")
    assert unack["reviewer_run_binding"]
    assert len(calls.prompts) == 0
    assert state_of(r, lineage)["revision"] == rev


def test_forecast_carries_the_validated_model_and_effort(r):
    lineage = grant(r, "medium")
    calls, runner = fake_runner()
    forecast, done = forecast_then_run(r, lineage, {"riskAssessor": assess("medium"), "runner": runner}, model="sonnet", effort="high", timeoutMs=12345)
    assert forecast["model"] == "sonnet"
    assert forecast["effort"] == "high"
    is_(done, "closed")
    assert calls.opts[0]["model"] == "sonnet"
    assert calls.opts[0]["effort"] == "high"
    assert calls.opts[0]["timeoutMs"] == 12345


# ---- model / effort validation ----


def test_validate_reviewer_options_only_the_families_and_efforts_the_runner_forwards():
    assert validate_reviewer_options({}) is None
    assert validate_reviewer_options({"model": "opus", "effort": "max"}) is None
    assert validate_reviewer_options({"model": "haiku"}) is None
    assert validate_reviewer_options({"model": "sonnet", "effort": ""}) is None
    for bad in [{"model": "gpt-4"}, {"model": ""}, {"model": "claude-sonnet-5-5"}, {"effort": "high"}, {"model": "sonnet", "effort": "ultra"}, {"model": "haiku", "effort": "high"}, {"model": "sonnet; rm", "effort": "low"}]:
        assert isinstance(validate_reviewer_options(bad), str), bad


def test_validate_reviewer_options_exact_messages_and_non_string_values():
    assert validate_reviewer_options({"model": "gpt-4"}) == "model must be one of fable, opus, sonnet, haiku"
    assert validate_reviewer_options({"model": "sonnet", "effort": "ultra"}) == "effort must be one of low, medium, high, xhigh, max"
    assert validate_reviewer_options({"effort": "high"}) == "effort needs a model"
    assert validate_reviewer_options({"model": "haiku", "effort": "low"}) == "haiku has no effort levels"
    for bad in [None, 5, True, ["opus"], {"a": 1}]:
        assert validate_reviewer_options({"model": bad}) == "model must be one of fable, opus, sonnet, haiku", bad
        assert validate_reviewer_options({"model": "opus", "effort": bad}) == "effort must be one of low, medium, high, xhigh, max", bad
    assert RUN.REVIEWER_MODELS == ["fable", "opus", "sonnet", "haiku"]
    assert RUN.REVIEWER_EFFORTS == ["low", "medium", "high", "xhigh", "max"]
    assert RUN.DEFAULT_CONCURRENCY == 2


def test_an_invalid_model_or_effort_is_refused_before_anything_starts_or_runs(r):
    calls, runner = fake_runner()
    for bad in [{"model": "gpt-4"}, {"model": "sonnet", "effort": "ultra"}, {"effort": "high"}, {"model": "haiku", "effort": "low"}]:
        out = is_(run_review(inp(r, **bad), {"riskAssessor": assess("low"), "runner": runner}), "blocked")
        assert out["code"] == "invalid_option", bad
    assert len(calls.prompts) == 0
    assert list_lineages(r.common_dir)["lineages"] == [], "no lineage was created"


# ---- group: ordering and concurrency ----


def test_group_out_of_order_completion_is_admitted_in_provider_canonical_order_concurrency_is_bounded(make_repo):
    r = make_repo()
    lineage = grant(r, "high")
    calls, runner = fake_runner(delay_ms={"risk": 120, "resilience": 80, "readability": 40, "reliability": 1})
    deps = {"riskAssessor": assess("high"), "runner": runner, "concurrency": 4}
    forecast, done = forecast_then_run(r, lineage, deps)
    assert [s["lens"] for s in forecast["reviewers"]] == ["risk", "resilience", "readability", "reliability"]
    is_(done, "closed")
    assert calls.finished == ["reliability", "readability", "resilience", "risk"], "the reviewers really finished in reverse"
    assert [e["lens"] for e in state_of(r, lineage)["admitted_role_results"]] == ["risk", "resilience", "readability", "reliability"]
    assert calls.max_active == 4
    r2 = make_repo()
    lineage = grant(r2, "high")
    calls, runner = fake_runner(delay_ms={"risk": 30, "resilience": 30, "readability": 30, "reliability": 30})
    _, done = forecast_then_run(r2, lineage, {"riskAssessor": assess("high"), "runner": runner})
    is_(done, "closed")
    assert calls.max_active == 2, "default bound is 2"


def test_a_concurrency_of_one_runs_the_slots_strictly_one_after_the_other_in_slot_order(r):
    lineage = grant(r, "high")
    calls, runner = fake_runner(delay_ms={"risk": 30, "resilience": 5})
    _, done = forecast_then_run(r, lineage, {"riskAssessor": assess("high"), "runner": runner, "concurrency": 1})
    is_(done, "closed")
    assert calls.max_active == 1
    assert calls.roles == ["risk", "resilience", "readability", "reliability"]


# ---- failed / malformed reviewer output never reaches acknowledgement ----


def test_malformed_reviewer_output_blocked_no_acknowledgement_no_replay_earlier_slots_stay_admitted(r):
    lineage = grant(r, "high")
    calls, runner = fake_runner(raw={"resilience": "I could not review this, sorry"})
    _, done = forecast_then_run(r, lineage, {"riskAssessor": assess("high"), "runner": runner, "concurrency": 4})
    out = is_(done, "blocked")
    assert out["code"] == "reviewer_output_invalid"
    assert out["slot"]["lens"] == "resilience"
    assert out["detail"] == "no_json"
    assert out["status_after"]["kind"] == "collect", "status was re-checked once"
    assert sorted(calls.roles) == ["readability", "reliability", "resilience", "risk"], "each slot ran once: no replay"
    rec = state_of(r, lineage)
    assert [e["lens"] for e in rec["admitted_role_results"]] == ["risk"], "only the slot before the failure was admitted"
    assert rec["state"] == "reviewing"
    assert rec["burned"] is False
    assert not os.path.exists(os.path.join(r.common_dir, "odd-plugin", "review-transactions", "v2", lineage, "review-receipt.json"))
    assert is_target_consumed(r.common_dir, rec["target_identity"])["consumed"] is False


def test_a_typed_runner_failure_is_blocked_as_reviewer_failed_nothing_is_admitted_or_acknowledged(r):
    lineage = grant(r, "medium")
    calls, runner = fake_runner(fail={"risk": {"ok": False, "code": "timeout", "message": "the reviewer exceeded its bound", "elapsedMs": 5}})
    _, done = forecast_then_run(r, lineage, {"riskAssessor": assess("medium"), "runner": runner})
    out = is_(done, "blocked")
    assert out["code"] == "reviewer_failed"
    assert out["message"] == "the reviewer exceeded its bound"
    assert out["detail"] == "timeout"
    assert len(calls.prompts) == 1
    rec = state_of(r, lineage)
    assert len(rec["admitted_role_results"]) == 0
    assert rec["burned"] is False


def test_a_runner_that_raises_is_a_typed_claude_unavailable_failure_never_a_raise(r):
    lineage = grant(r, "medium")

    def boom(prompt, opts):
        raise RuntimeError("spawn exploded")

    _, done = forecast_then_run(r, lineage, {"riskAssessor": assess("medium"), "runner": boom})
    out = is_(done, "blocked")
    assert (out["code"], out["detail"], out["message"]) == ("reviewer_failed", "claude_unavailable", "the reviewer runner failed: spawn exploded")
    assert state_of(r, lineage)["burned"] is False


def test_an_output_that_echoes_another_subject_is_refused_at_capture_blocked_no_acknowledgement(r):
    lineage = grant(r, "medium")
    wrong = json.dumps({"subject_hash": f"sha256:{'1' * 64}", "inspection": {"status": "completed", "paths": ["a.txt"]}, "findings": [], "evidence": ["x"]})
    _, runner = fake_runner(raw={"risk": wrong})
    _, done = forecast_then_run(r, lineage, {"riskAssessor": assess("medium"), "runner": runner})
    out = is_(done, "blocked")
    assert out["code"] == "reviewer_output_invalid"
    assert out["detail"] == "binding_mismatch"
    assert state_of(r, lineage)["burned"] is False


# ---- binding drift ----


def test_binding_drift_mid_run_the_candidate_changes_during_the_reviewer_call(r):
    calls, runner = fake_runner(during=lambda: r.write("a.txt", "completely\ndifferent\n"))
    deps = {"riskAssessor": assess("low"), "runner": runner}
    lineage = grant(r, "medium")
    rev = state_of(r, lineage)["revision"]
    forecast = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    out = is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=forecast["reviewer_run_binding"]), deps), "binding-drift")
    assert len(calls.prompts) == 1, "the reviewer did run on the frozen trees"
    assert out["field"] == "target"
    rec = state_of(r, lineage)
    assert rec["revision"] == rev, "nothing captured"
    assert len(rec["admitted_role_results"]) == 0
    assert rec["burned"] is False


def test_a_lineage_whose_candidate_moved_before_the_run_is_a_binding_drift_not_a_fresh_review(r):
    lineage = grant(r, "medium")
    r.write("a.txt", "moved\non\n")
    calls, runner = fake_runner()
    out = is_(run_review(inp(r, lineageId=lineage), {"riskAssessor": assess("medium"), "runner": runner}), "binding-drift")
    assert out["field"] == "target"
    assert out["message"] == "the candidate changed since this lineage was started"
    assert len(calls.prompts) == 0


# ---- bounded loop and cancellation ----


def test_transition_limit_the_loop_is_bounded(r):
    assert MAX_TRANSITIONS == 24
    _, runner = fake_runner()
    out = is_(run_review(inp(r), {"riskAssessor": assess("low"), "runner": runner, "maxTransitions": 1}), "transition-limit")
    assert out["limit"] == 1
    assert out["transitions"] == 1


def test_cancelled_before_the_run_and_while_a_reviewer_is_running_nothing_is_captured(r):
    calls, runner = fake_runner()
    ac = AbortSignal()
    ac.abort()
    early = is_(run_review(inp(r, signal=ac), {"riskAssessor": assess("low"), "runner": runner}), "cancelled")
    assert "lineage_id" not in early
    assert list_lineages(r.common_dir)["lineages"] == []
    assert len(calls.prompts) == 0

    lineage = grant(r, "medium")
    ac2 = AbortSignal()
    mid = fake_runner(during=ac2.abort, delay_ms={"risk": 20})
    deps = {"riskAssessor": assess("medium"), "runner": mid[1]}
    forecast = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    out = is_(run_review(inp(r, lineageId=lineage, signal=ac2, reviewerRunAcknowledged=True, reviewerRunBinding=forecast["reviewer_run_binding"]), deps), "cancelled")
    assert out["lineage_id"] == lineage
    rec = state_of(r, lineage)
    assert len(rec["admitted_role_results"]) == 0
    assert rec["burned"] is False


def test_a_threading_event_is_accepted_as_the_cancellation_signal(r):
    ev = threading.Event()
    ev.set()
    calls, runner = fake_runner()
    out = is_(run_review(inp(r, signal=ev), {"riskAssessor": assess("low"), "runner": runner}), "cancelled")
    assert out["transitions"] == 0
    assert len(calls.prompts) == 0


def test_deps_none_and_an_unset_signal_run_with_the_defaults(make_repo):
    r = make_repo(dirty=False)
    assert run_review(inp(r)) == {"outcome": "not-due", "transitions": 1, "target_identity": run_review(inp(r))["target_identity"]}
    assert run_review(inp(r, signal=None), None)["outcome"] == "not-due"


# ---- input-required and resume after the correction ----


def test_input_required_severe_finding_opens_the_correction_plan_resume_after_the_correction_validates_and_closes(r):
    lineage = grant(r, "medium")
    calls, runner = fake_runner(findings={"risk": [SEVERE]})
    deps = {"riskAssessor": assess("medium"), "runner": runner}
    plan = is_(forecast_then_run(r, lineage, deps)[1], "input-required")
    assert plan["lineage_id"] == lineage
    assert [f["id"] for f in plan["correction"]["findings"]] == ["R1-1"]
    assert plan["correction"]["allowed_paths"] == ["a.txt"]
    assert state_of(r, lineage)["state"] == "correction_required"
    assert state_of(r, lineage)["burned"] is False
    assert is_(run_review(inp(r, lineageId=lineage), deps), "input-required")["correction"]["revision"] == plan["correction"]["revision"]
    r.write("a.txt", FIXED_A)
    forecast = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    assert forecast["reviewers"][0]["role"] == "validator"
    assert state_of(r, lineage)["state"] == "correction_required", "the forecast wrote nothing"
    assert len(calls.prompts) == 1, "the forecast ran no reviewer"
    closed = is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=forecast["reviewer_run_binding"]), deps), "closed")
    assert closed["lineage_id"] == lineage
    assert calls.roles == ["risk", "validator"]
    assert state_of(r, lineage)["burned"] is True


def test_a_correction_outside_the_frozen_findings_is_refused_the_lineage_stays_in_correction_required(r):
    lineage = grant(r, "medium")
    calls, runner = fake_runner(findings={"risk": [SEVERE]})
    deps = {"riskAssessor": assess("medium"), "runner": runner}
    is_(forecast_then_run(r, lineage, deps)[1], "input-required")
    rev = state_of(r, lineage)["revision"]
    r.write("b.txt", "changed elsewhere\n")
    out = is_(run_review(inp(r, lineageId=lineage), deps), "blocked")
    assert out["code"] == "correction_refused"
    assert out["detail"] == "correction_out_of_scope"
    assert state_of(r, lineage)["revision"] == rev
    assert state_of(r, lineage)["state"] == "correction_required"
    assert len(calls.prompts) == 1


def held_refuter(r, lineage):
    rec = state_of(r, lineage)
    subject = lens_artifact_subject(r.common_dir, rec, "risk")
    held = capture_lens_result(
        r.common_dir, lineage, rec["revision"],
        {"lens": "risk", "subject": subject, "result": {"subject_hash": subject["subject_hash"], "inspection": {"status": "completed", "paths": tree_diff_paths(r.common_dir, rec["base_tree"], rec["candidate_tree"])}, "findings": [{**SEVERE, "evidence_class": "inferential"}], "evidence": ["x"]}},
        {"awaitRefuter": True},
    )
    assert held["ok"] and held["state"] == "reviewing"


def test_an_optional_refuter_that_status_offers_is_run_admitted_and_the_review_settles(r):
    lineage = grant(r, "medium")
    held_refuter(r, lineage)
    calls, runner = fake_runner()
    forecast, done = forecast_then_run(r, lineage, {"riskAssessor": assess("medium"), "runner": runner})
    assert [s["role"] for s in forecast["reviewers"]] == ["refuter"]
    is_(done, "closed")
    assert calls.roles == ["refuter"]
    assert state_of(r, lineage)["burned"] is True


# ---- request context and unknown lineage ----


def test_a_request_context_needs_a_fresh_review_resuming_a_lineage_with_one_is_blocked(r):
    lineage = grant(r, "medium")
    _, runner = fake_runner()
    out = is_(run_review(inp(r, lineageId=lineage, requestContextPath=os.path.join(r.repo, "ctx.md")), {"riskAssessor": assess("medium"), "runner": runner}), "blocked")
    assert out["code"] == "request_context_requires_fresh_review"
    assert out["message"] == "a request context is only accepted when a fresh review starts"


# ---- integration with the fake claude binary (the real claude is never called) ----


def fake_for(fake_factory, r, lineage, stdout):
    rec = state_of(r, lineage)
    subject = lens_artifact_subject(r.common_dir, rec, "risk")
    paths = tree_diff_paths(r.common_dir, rec["base_tree"], rec["candidate_tree"])
    return fake_factory({"stdout": stdout if isinstance(stdout, str) else stdout(subject["subject_hash"], paths)})


def ok_answer(h, paths):
    return json.dumps({"subject_hash": h, "inspection": {"status": "completed", "paths": paths}, "findings": [], "evidence": ["read it all"]})


def test_integration_fake_claude_binary_a_granted_medium_review_closes_the_child_got_the_isolated_flags_and_the_model(r, fake_factory):
    lineage = grant(r, "medium")
    fake = fake_for(fake_factory, r, lineage, ok_answer)
    _, done = forecast_then_run(r, lineage, {}, claudePath=fake.binary, model="opus", effort="high")
    is_(done, "closed")
    rec = fake.record
    assert "--print" in rec["args"] and "--bare" not in rec["args"]
    i = rec["args"].index("--model")
    assert rec["args"][i : i + 4] == ["--model", "opus", "--effort", "high"]
    assert re.search(r"Role: lens, lens: risk\.", rec["stdin"])
    assert state_of(r, lineage)["burned"] is True


def test_integration_fake_claude_binary_garbage_on_stdout_is_never_admitted_or_acknowledged(r, fake_factory):
    lineage = grant(r, "medium")
    fake = fake_for(fake_factory, r, lineage, "this is not json at all")
    _, done = forecast_then_run(r, lineage, {}, claudePath=fake.binary)
    assert is_(done, "blocked")["code"] == "reviewer_output_invalid"
    rec = state_of(r, lineage)
    assert len(rec["admitted_role_results"]) == 0
    assert rec["burned"] is False


# ---- B1/B2/B3 + A2/A3 (verification of ea05430) ----


def test_correction_close_consumes_the_corrected_candidate_never_the_original(r):
    _, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    original = state_of(r, lineage)["target_identity"]
    r.write("a.txt", FIXED_A)
    forecast = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    closed = is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=forecast["reviewer_run_binding"]), deps), "closed")
    assert closed["target_identity"] != original
    assert closed["acknowledgement"]["target_identity"] == closed["target_identity"]
    rec = state_of(r, lineage)
    assert rec["burned"] is True
    assert rec["target_identity"] == closed["target_identity"], "the lineage's current candidate is the corrected one"
    assert rec["original_target_identity"] == original, "the reviewed original is kept as history"
    assert read_receipt(r.common_dir, lineage)["target_identity"] == closed["target_identity"]
    assert is_target_consumed(r.common_dir, closed["target_identity"])["status"] == "consumed"
    assert is_target_consumed(r.common_dir, original)["status"] == "not_consumed"
    assert is_target_consumed(r.common_dir, original)["consumed"] is False
    on_corrected = review_status(r.repo, {})
    assert on_corrected["target_identity"] == closed["target_identity"]
    assert on_corrected["next_transition"]["reason_code"] == "target_already_acknowledged"
    assert on_corrected["consumed"]["status"] == "consumed"
    assert on_corrected["projection"]["initial_snapshot_identity"] == original
    r.write("a.txt", ORIGINAL_A)
    on_original = review_status(r.repo, {})
    assert on_original["target_identity"] == original
    assert on_original["next_transition"]["reason_code"] != "target_already_acknowledged"
    assert on_original["consumed"]["status"] == "not_consumed"


def test_validator_forecast_changes_nothing_a_refined_correction_stays_plannable(r):
    calls, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    before = state_of(r, lineage)
    r.write("a.txt", FIXED_A)
    f1 = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    after = state_of(r, lineage)
    assert after["revision"] == before["revision"], "a forecast writes nothing"
    assert after["state"] == "correction_required"
    assert after["correction_attempts"] == 0, "a forecast does not spend the single correction attempt"
    r.write("a.txt", "UNO\nTWO\nthree\nfour\nfive\n")
    f2 = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    assert f2["reviewer_run_binding"] != f1["reviewer_run_binding"]
    assert state_of(r, lineage)["revision"] == before["revision"]
    assert plan_correction(r.common_dir, lineage)["ok"] is True, "the correction is still plannable"
    stale = is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=f1["reviewer_run_binding"]), deps), "binding-drift")
    assert stale["field"] == "forecast"
    assert state_of(r, lineage)["revision"] == before["revision"]
    assert len(calls.prompts) == 1, "no validator ran"
    closed = is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=f2["reviewer_run_binding"]), deps), "closed")
    assert closed["lineage_id"] == lineage
    assert calls.roles == ["risk", "validator"]
    assert state_of(r, lineage)["correction_attempts"] == 1
    assert state_of(r, lineage)["burned"] is True


def test_cancelled_no_queued_reviewer_is_spawned_after_the_run_returns(r):
    lineage = grant(r, "high")
    ac = AbortSignal()
    calls, runner = fake_runner(delay_ms={"risk": 30, "resilience": 30}, during=ac.abort)
    deps = {"riskAssessor": assess("high"), "runner": runner, "concurrency": 2}
    forecast = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    out = is_(run_review(inp(r, lineageId=lineage, signal=ac, reviewerRunAcknowledged=True, reviewerRunBinding=forecast["reviewer_run_binding"]), deps), "cancelled")
    assert out["lineage_id"] == lineage
    at_return = len(calls.prompts)
    assert 1 <= at_return <= 2, "at most the reviewers of the first two slots were spawned"
    time.sleep(0.2)
    assert len(calls.prompts) == at_return, "nothing was spawned after the run returned"
    assert len(state_of(r, lineage)["admitted_role_results"]) == 0


def test_blocked_once_a_slot_fails_no_queued_reviewer_is_spawned(r):
    lineage = grant(r, "high")
    calls, runner = fake_runner(fail={"risk": {"ok": False, "code": "nonzero_exit", "message": "boom", "elapsedMs": 1}}, delay_ms={"resilience": 40})
    deps = {"riskAssessor": assess("high"), "runner": runner, "concurrency": 2}
    _, done = forecast_then_run(r, lineage, deps)
    assert is_(done, "blocked")["code"] == "reviewer_failed"
    time.sleep(0.2)
    assert len(calls.prompts) == 2, "readability and reliability never started"
    assert len(state_of(r, lineage)["admitted_role_results"]) == 0


def test_a_forecast_for_one_model_effort_does_not_authorize_a_run_with_another(r):
    lineage = grant(r, "medium")
    calls, runner = fake_runner()
    deps = {"riskAssessor": assess("medium"), "runner": runner}
    forecast = is_(run_review(inp(r, lineageId=lineage, model="haiku"), deps), "forecast")
    for other in [{"model": "opus", "effort": "max"}, {"model": "sonnet"}, {}]:
        out = is_(run_review(inp(r, lineageId=lineage, **other, reviewerRunAcknowledged=True, reviewerRunBinding=forecast["reviewer_run_binding"]), deps), "binding-drift")
        assert out["field"] == "forecast"
    assert len(calls.prompts) == 0
    is_(run_review(inp(r, lineageId=lineage, model="haiku", reviewerRunAcknowledged=True, reviewerRunBinding=forecast["reviewer_run_binding"]), deps), "closed")
    assert calls.opts[0]["model"] == "haiku"


def test_without_lineage_id_a_corrected_candidate_of_a_lineage_in_correction_required_reports_that_lineage_instead_of_opening_a_new_review(r):
    calls, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    rev = state_of(r, lineage)["revision"]
    r.write("a.txt", FIXED_A)
    out = is_(run_review(inp(r), deps), "blocked")
    assert out["code"] == "correction_lineage_pending"
    assert out["message"] == f"lineage {lineage} is waiting for its correction (correction_required); resume it with lineageId instead of opening a new review"
    assert out["lineage_id"] == lineage
    assert list_lineages(r.common_dir)["lineages"] == [lineage], "no new lineage was opened"
    assert state_of(r, lineage)["revision"] == rev
    assert len(calls.prompts) == 1
    f = is_(run_review(inp(r, lineageId=out["lineage_id"]), deps), "forecast")
    is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=f["reviewer_run_binding"]), deps), "closed")


# ---- legacy validating records, escalation binding, abort seams (re-verification of 4863518) ----


def test_legacy_validating_record_no_correction_candidate_tree_never_consumes_the_original(r):
    _, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    original = state_of(r, lineage)["target_identity"]
    r.write("a.txt", FIXED_A)
    frozen = freeze_snapshot(r.repo, {"kind": "current-changes", "projection": "workspace"})
    assert frozen["status"] == "frozen"
    rev = state_of(r, lineage)["revision"]
    update_state(r.common_dir, lineage, rev, lambda rec: begin_validation(rec, {"now": iso_now(), "actualCorrectionLines": 1, "correctionTargetIdentity": frozen["snapshot"]["identity"]}))
    assert "correction_candidate_tree" not in state_of(r, lineage)
    forecast = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    closed = is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=forecast["reviewer_run_binding"]), deps), "closed")
    assert closed["target_identity"] == frozen["snapshot"]["identity"]
    assert is_target_consumed(r.common_dir, frozen["snapshot"]["identity"])["status"] == "consumed"
    assert is_target_consumed(r.common_dir, original)["status"] == "not_consumed"
    assert state_of(r, lineage)["original_target_identity"] == original


def test_an_escalated_correction_binds_the_corrected_candidate_a_run_without_lineage_id_reports_the_escalated_lineage_not_a_new_review(r):
    calls, runner = fake_runner(findings={"risk": [SEVERE]}, validator_fails=True)
    deps = {"riskAssessor": assess("medium"), "runner": runner}
    lineage = to_correction_required(r, deps)
    original = state_of(r, lineage)["target_identity"]
    r.write("a.txt", FIXED_A)
    f = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    reopened = is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=f["reviewer_run_binding"]), deps), "input-required")
    assert reopened["lineage_id"] == lineage
    assert reopened["correction"]["attempts_remaining"] == 1
    assert reopened["correction"]["allowed_paths"] == ["a.txt"]
    mid = state_of(r, lineage)
    assert mid["state"] == "correction_required"
    assert mid["correction_attempts"] == 1
    assert mid["original_target_identity"] == original
    r.write("a.txt", "UNO\nTWO\nthree\nfour\nfive\n")
    f2 = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    esc = is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=f2["reviewer_run_binding"]), deps), "stopped")
    assert esc["reason_code"] == "escalated"
    rec = state_of(r, lineage)
    assert rec["state"] == "escalated"
    assert rec["correction_attempts"] == 2
    assert rec["target_identity"] != original
    assert rec["original_target_identity"] == original
    again = is_(run_review(inp(r), deps), "stopped")
    assert again["reason_code"] == "escalated"
    assert again["lineage_id"] == lineage
    assert list_lineages(r.common_dir)["lineages"] == [lineage], "no new review was offered"
    assert len(calls.prompts) == 3
    assert is_target_consumed(r.common_dir, rec["target_identity"])["consumed"] is False


def test_abort_recheck_before_capture_an_abort_that_lands_after_the_reviewer_answered_captures_nothing(r):
    lineage = grant(r, "medium")
    _, runner = fake_runner()
    ac = AbortSignal()
    deps = {"riskAssessor": assess("medium"), "runner": runner, "hooks": {"beforeCapture": ac.abort}}
    f = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    out = is_(run_review(inp(r, lineageId=lineage, signal=ac, reviewerRunAcknowledged=True, reviewerRunBinding=f["reviewer_run_binding"]), deps), "cancelled")
    assert out["lineage_id"] == lineage
    rec = state_of(r, lineage)
    assert len(rec["admitted_role_results"]) == 0, "nothing was captured after the abort"
    assert rec["burned"] is False


def test_abort_recheck_before_acknowledge_an_abort_that_lands_after_approval_burns_nothing(r):
    _, runner = fake_runner()
    ac = AbortSignal()
    deps = {"riskAssessor": assess("low"), "runner": runner, "hooks": {"beforeAcknowledge": ac.abort}}
    out = is_(run_review(inp(r, signal=ac), deps), "cancelled")
    rec = state_of(r, out["lineage_id"])
    assert rec["state"] == "approved"
    assert rec["burned"] is False, "an aborted run never acknowledges"
    assert is_target_consumed(r.common_dir, rec["target_identity"])["consumed"] is False


# ---- unchanged correction, residual shape, pre-963094d records (verification of 963094d) ----


def test_an_unchanged_corrected_candidate_never_opens_validation_the_original_is_not_consumed_and_the_state_is_byte_identical(r):
    _, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    original = state_of(r, lineage)["target_identity"]
    frozen = freeze_snapshot(r.repo, {"kind": "current-changes", "projection": "workspace"})
    assert frozen["snapshot"]["identity"] == original, "nothing was corrected"
    before = sha(state_file(r, lineage))
    repo = resolve_repository(r.repo)
    snap = frozen["snapshot"]
    began = begin_correction_validation(repo, lineage, state_of(r, lineage)["revision"], {"candidateTree": snap["candidateTree"], "identity": snap["identity"]})
    assert began["ok"] is False, "an unchanged candidate is not a correction"
    assert began["code"] == "correction_unavailable"
    other = f"sha256:{'3' * 64}"
    assert begin_correction_validation(repo, lineage, state_of(r, lineage)["revision"], {"candidateTree": snap["candidateTree"], "identity": other})["code"] == "correction_unavailable"
    assert begin_correction_validation(repo, lineage, state_of(r, lineage)["revision"], {"candidateTree": state_of(r, lineage)["base_tree"], "identity": snap["identity"]})["code"] == "correction_unavailable"
    assert sha(state_file(r, lineage)) == before, "state unchanged byte for byte"
    out = is_(run_review(inp(r, lineageId=lineage), deps), "input-required")
    assert out["lineage_id"] == lineage
    assert sha(state_file(r, lineage)) == before
    assert is_target_consumed(r.common_dir, original)["status"] == "not_consumed"


def test_residual_shape_validating_without_correction_target_identity_never_approves_no_run_closes_state_byte_identical_original_not_consumed(r):
    _, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    original = state_of(r, lineage)["target_identity"]
    update_state(r.common_dir, lineage, state_of(r, lineage)["revision"], lambda rec: begin_validation(rec, {"now": iso_now(), "actualCorrectionLines": 1}))
    h0 = sha(state_file(r, lineage))
    rec = state_of(r, lineage)
    res = {"targeted_validation_request_hash": f"sha256:{'0' * 64}", "correction_target_identity": original, "original_criteria": {"passed": True, "evidence": ["x"]}, "correction_regression": {"passed": True, "evidence": ["y"]}, "follow_ups": []}
    cap = capture_validator_result(r.common_dir, lineage, rec["revision"], {"result": res, "correctionCandidateTree": rec["candidate_tree"]})
    assert cap["ok"] is False
    a = run_review(inp(r, lineageId=lineage), deps)
    b = run_review(inp(r), deps)
    r.write("a.txt", FIXED_A)
    c = run_review(inp(r, lineageId=lineage), deps)
    d = run_review(inp(r), deps)
    for o in (a, b, c, d):
        assert o["outcome"] != "closed", json.dumps(o)[:300]
    assert is_(c, "binding-drift")["field"] == "target"
    assert sha(state_file(r, lineage)) == h0, "refusals leave the state byte-identical"
    assert is_target_consumed(r.common_dir, original)["status"] == "not_consumed"


def test_a_pre_963094d_approved_record_is_unreadable_unknown_for_gates_authority_error_for_a_run(r):
    _, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    r.write("a.txt", FIXED_A)
    cur = state_of(r, lineage)
    corr = freeze_snapshot(r.repo, {"kind": "current-changes", "projection": "workspace"})
    legacy = {
        **cur, "state": "approved", "correction_attempts": 1, "actual_correction_lines": 1, "correction_target_identity": corr["snapshot"]["identity"],
        "admitted_role_results": [*cur["admitted_role_results"], {"role": "validator", "result_hash": f"sha256:{'7' * 64}"}],
        "approved_ack_token_hash": f"sha256:{'8' * 64}", "evidence_hash": f"sha256:{'9' * 64}",
    }
    legacy["revision"] = state_revision(legacy)
    Path(state_file(r, lineage)).write_text(json.dumps(legacy))
    with pytest.raises(StoreCorruptError):
        read_state(r.common_dir, lineage)
    scan = is_target_consumed(r.common_dir, cur["target_identity"])
    assert scan["status"] == "unknown"
    assert scan["consumed"] is False
    assert [p["code"] for p in scan["problems"]] == ["state_unreadable"]
    out = is_(run_review(inp(r, lineageId=lineage), deps), "blocked")
    assert out["code"] == "authority_error"
    assert out["detail"] == "StoreCorruptError"


# ---- defense in depth: store rejects an unchanged-correction record; a run checks the corrected snapshot's projection and base ----


def forge_validating(r, lineage, shape):
    cur = state_of(r, lineage)
    forged = {
        **cur, "state": "validating", "correction_attempts": 1, "actual_correction_lines": 1,
        "correction_target_identity": cur["target_identity"] if shape == "identity" else f"sha256:{'4' * 64}",
        "correction_candidate_tree": cur["candidate_tree"] if shape == "tree" else "d" * 40,
    }
    forged["revision"] = state_revision(forged)
    Path(state_file(r, lineage)).write_text(json.dumps(forged))
    return cur


@pytest.mark.parametrize("shape", ["identity", "tree"])
def test_a_hand_crafted_validating_record_whose_correction_candidate_equals_the_reviewed_one_is_unreadable_fail_closed(r, shape):
    _, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    forge_validating(r, lineage, shape)
    with pytest.raises(StoreCorruptError):
        read_state(r.common_dir, lineage)


@pytest.mark.parametrize("variant", ["projection", "base"])
def test_after_correction_a_corrected_snapshot_with_another_projection_or_base_is_binding_drift_and_captures_nothing(r, variant):
    calls, runner = fake_runner(findings={"risk": [SEVERE]})
    deps = {"riskAssessor": assess("medium"), "runner": runner}
    lineage = to_correction_required(r, deps)
    before = sha(state_file(r, lineage))
    spawned = len(calls.prompts)
    r.write("a.txt", FIXED_A)
    over = {}
    if variant == "projection":
        git(r.repo, "add", "a.txt")
        over = {"projection": "staged"}
    else:
        r.write("b.txt", "bee\nmoved base\n")
        git(r.repo, "add", "b.txt")
        git(r.repo, "commit", "-q", "-m", "move the base")
    out = is_(run_review(inp(r, lineageId=lineage, **over), deps), "binding-drift")
    assert re.search("projection" if variant == "projection" else "base", out["field"])
    assert sha(state_file(r, lineage)) == before, "nothing captured"
    assert len(calls.prompts) == spawned, "no reviewer ran"


# ---- A2 accepts the upstream correction shapes (base == reviewed base OR reviewed candidate); A1 fails closed (verification of da3943b) ----


def test_a2_commit_the_reviewed_work_then_correct_in_the_worktree_base_is_the_reviewed_candidate_tree_validates_and_closes_the_lineage_keeps_its_base_tree(r):
    _, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    rec = state_of(r, lineage)
    git(r.repo, "commit", "-q", "-am", "reviewed work")
    assert git(r.repo, "rev-parse", "HEAD^{tree}").strip() == rec["candidate_tree"], "the new base is exactly the reviewed tree"
    r.write("a.txt", FIXED_A)
    closed = is_(forecast_then_run(r, lineage, deps)[1], "closed")
    assert closed["target_identity"] != rec["target_identity"]
    after = state_of(r, lineage)
    assert after["state"] == "approved"
    assert after["burned"] is True
    assert after["base_tree"] == rec["base_tree"], "the lineage keeps its original base_tree"
    assert after["original_target_identity"] == rec["target_identity"]
    assert is_target_consumed(r.common_dir, closed["target_identity"])["status"] == "consumed"
    assert is_target_consumed(r.common_dir, rec["target_identity"])["status"] == "not_consumed"


def test_s2_commit_the_reviewed_work_the_first_correction_fails_the_second_correction_on_the_same_base_validates(r):
    failing = {"riskAssessor": assess("medium"), "runner": fake_runner(findings={"risk": [SEVERE]}, validator_fails=True)[1]}
    lineage = to_correction_required(r, failing)
    rec = state_of(r, lineage)
    git(r.repo, "commit", "-q", "-am", "reviewed work")
    r.write("a.txt", FIXED_A)
    first = is_(forecast_then_run(r, lineage, failing)[1], "input-required")
    assert first["correction"]["attempts_remaining"] == 1
    mid = state_of(r, lineage)
    assert mid["state"] == "correction_required"
    assert mid["correction_attempts"] == 1
    assert mid["original_target_identity"] == rec["target_identity"]
    passing = {"riskAssessor": assess("medium"), "runner": fake_runner()[1]}
    r.write("a.txt", "UNO\nTWO\nthree\nfour\nfive\n")
    pending = pending_correction_lineage(r.repo, {"kind": "current-changes", "projection": "workspace"})
    assert pending is not None and pending["rec"]["lineage_id"] == lineage, "the reopened lineage is still the pending correction"
    lineageless = run_review(inp(r), passing)
    assert lineageless["lineage_id"] == lineage, "a run without lineage reports the reopened lineage, never a new review"
    assert lineageless["outcome"] != "closed"
    closed = is_(forecast_then_run(r, lineage, passing)[1], "closed")
    after = state_of(r, lineage)
    assert after["state"] == "approved"
    assert after["correction_attempts"] == 2
    assert after["original_target_identity"] == rec["target_identity"]
    assert after["base_tree"] == rec["base_tree"]
    assert is_target_consumed(r.common_dir, closed["target_identity"])["status"] == "consumed"
    assert is_target_consumed(r.common_dir, rec["target_identity"])["status"] == "not_consumed"


def test_s2_a_record_in_validating_attempts_1_resumes_and_a_failing_validator_reopens_the_second_correction(r):
    failing = {"riskAssessor": assess("medium"), "runner": fake_runner(findings={"risk": [SEVERE]}, validator_fails=True)[1]}
    lineage = to_correction_required(r, failing)
    r.write("a.txt", FIXED_A)
    frozen = freeze_snapshot(r.repo, {"kind": "current-changes", "projection": "workspace"})
    began = begin_correction_validation(resolve_repository(r.repo), lineage, state_of(r, lineage)["revision"], {"candidateTree": frozen["snapshot"]["candidateTree"], "identity": frozen["snapshot"]["identity"]})
    assert began["ok"] is True
    assert state_of(r, lineage)["state"] == "validating"
    out = is_(forecast_then_run(r, lineage, failing)[1], "input-required")
    assert out["correction"]["attempts_remaining"] == 1
    rec = state_of(r, lineage)
    assert rec["state"] == "correction_required"
    assert rec["correction_attempts"] == 1


def test_a2_a_base_that_is_neither_the_reviewed_base_nor_the_reviewed_candidate_is_binding_drift_base_nothing_written_committed_only_base_branch_moved(r):
    git(r.repo, "checkout", "-q", "-b", "feat")
    git(r.repo, "commit", "-q", "-am", "feature")
    target = {"kind": "base-diff", "baseRef": "main", "committedOnly": True}
    s = start_review({"cwd": r.repo, "target": target, "consent": "granted", "riskAssessor": assess("medium")})
    assert s["status"] == "started"
    lineage = s["result"]["lineage_id"]
    calls, runner = fake_runner(findings={"risk": [SEVERE]})
    deps = {"riskAssessor": assess("medium"), "runner": runner}
    is_(forecast_then_run(r, lineage, deps, target=target)[1], "input-required")
    git(r.repo, "checkout", "-q", "main")
    r.write("c.txt", "sea\n")
    git(r.repo, "add", "c.txt")
    git(r.repo, "commit", "-q", "-m", "main moves")
    git(r.repo, "checkout", "-q", "feat")
    r.write("a.txt", FIXED_A)
    git(r.repo, "commit", "-q", "-am", "fix")
    h0 = sha(state_file(r, lineage))
    n0 = len(calls.prompts)
    out = is_(run_review(inp(r, lineageId=lineage, target=target), deps), "binding-drift")
    assert re.search("base", out["field"])
    assert sha(state_file(r, lineage)) == h0, "nothing written"
    assert len(calls.prompts) == n0, "no reviewer ran"


def test_a2_a_workspace_lineage_resumed_with_projection_staged_is_binding_drift_projection_nothing_written(r):
    calls, runner = fake_runner(findings={"risk": [SEVERE]})
    deps = {"riskAssessor": assess("medium"), "runner": runner}
    lineage = to_correction_required(r, deps)
    r.write("a.txt", FIXED_A)
    git(r.repo, "add", "a.txt")
    h0 = sha(state_file(r, lineage))
    n0 = len(calls.prompts)
    out = is_(run_review(inp(r, lineageId=lineage, projection="staged"), deps), "binding-drift")
    assert re.search("projection", out["field"])
    assert sha(state_file(r, lineage)) == h0
    assert len(calls.prompts) == n0


def test_a2_does_not_drift_legitimate_corrections_staged_lineage_plus_staged_fix_committed_only_plus_committed_fix_s1(make_repo):
    r = make_repo()
    git(r.repo, "add", "a.txt")
    s = start_review({"cwd": r.repo, "target": {"kind": "current-changes"}, "projection": "staged", "consent": "granted", "riskAssessor": assess("medium")})
    assert s["status"] == "started"
    lineage = s["result"]["lineage_id"]
    deps = {"riskAssessor": assess("medium"), "runner": fake_runner(findings={"risk": [SEVERE]})[1]}
    is_(forecast_then_run(r, lineage, deps, projection="staged")[1], "input-required")
    r.write("a.txt", FIXED_A)
    git(r.repo, "add", "a.txt")
    is_(forecast_then_run(r, lineage, deps, projection="staged")[1], "closed")
    assert state_of(r, lineage)["state"] == "approved"
    r = make_repo()
    git(r.repo, "checkout", "-q", "-b", "feat")
    git(r.repo, "commit", "-q", "-am", "feature")
    target = {"kind": "base-diff", "baseRef": "main", "committedOnly": True}
    s = start_review({"cwd": r.repo, "target": target, "consent": "granted", "riskAssessor": assess("medium")})
    assert s["status"] == "started"
    lineage = s["result"]["lineage_id"]
    deps = {"riskAssessor": assess("medium"), "runner": fake_runner(findings={"risk": [SEVERE]})[1]}
    is_(forecast_then_run(r, lineage, deps, target=target)[1], "input-required")
    r.write("a.txt", FIXED_A)
    git(r.repo, "commit", "-q", "-am", "fix")
    is_(forecast_then_run(r, lineage, deps, target=target)[1], "closed")
    assert state_of(r, lineage)["state"] == "approved"


@pytest.mark.parametrize("shape", ["identity", "tree"])
def test_forged_unchanged_correction_validating_gates_read_unknown_and_a_resumed_run_is_blocked_s1(r, shape):
    calls, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    cur = forge_validating(r, lineage, shape)
    h0 = sha(state_file(r, lineage))
    n0 = len(calls.prompts)
    with pytest.raises(StoreCorruptError):
        read_state(r.common_dir, lineage)
    scan = is_target_consumed(r.common_dir, cur["target_identity"])
    assert scan["status"] == "unknown"
    assert scan["consumed"] is False
    assert [p["code"] for p in scan["problems"]] == ["state_unreadable"]
    assert is_(run_review(inp(r, lineageId=lineage), deps), "blocked")["code"] == "authority_error"
    r.write("a.txt", FIXED_A)
    assert is_(run_review(inp(r, lineageId=lineage), deps), "blocked")["code"] == "authority_error"
    assert sha(state_file(r, lineage)) == h0, "refusals leave the file byte-identical"
    assert len(calls.prompts) == n0, "no reviewer ran"


@pytest.mark.parametrize("shape", ["identity", "tree"])
def test_a1_a_run_without_lineage_id_over_an_unreadable_correction_lineage_with_the_same_base_projection_is_blocked_never_a_new_review(r, shape):
    _, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    forge_validating(r, lineage, shape)
    h0 = sha(state_file(r, lineage))
    before = len(list_lineages(r.common_dir)["lineages"])
    r.write("a.txt", FIXED_A)
    out = is_(run_review(inp(r), deps), "blocked")
    assert out["code"] in ("authority_error", "correction_lineage_pending"), out["code"]
    assert out["lineage_id"] == lineage
    assert len(list_lineages(r.common_dir)["lineages"]) == before, "no new lineage"
    assert sha(state_file(r, lineage)) == h0


# ---- U12d: scope probes P1/P1b/P1c, candidate-as-base reporting (P4), secure raw read (B1), corrected identity (A1) ----


def test_p1_reviewed_work_committed_then_an_unrelated_file_plus_the_fix_in_the_worktree_refused_out_of_scope_nothing_written(r):
    calls, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    git(r.repo, "commit", "-q", "-am", "reviewed work")
    r.write("a.txt", FIXED_A)
    r.write("b.txt", "unrelated big change\n" * 50)
    r.write("z.txt", "new unrelated\n")
    git(r.repo, "add", "z.txt")
    h0 = sha(state_file(r, lineage))
    n0 = len(calls.prompts)
    out = is_(run_review(inp(r, lineageId=lineage), deps), "blocked")
    assert out["code"] == "correction_refused"
    assert out["detail"] == "correction_out_of_scope"
    assert sha(state_file(r, lineage)) == h0
    assert len(calls.prompts) == n0


def test_p1b_reviewed_work_plus_an_unrelated_change_both_committed_fix_in_the_worktree_binding_drift_base_nothing_written(r):
    calls, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    r.write("b.txt", "unrelated\n")
    git(r.repo, "commit", "-q", "-am", "reviewed work + unrelated")
    r.write("a.txt", FIXED_A)
    h0 = sha(state_file(r, lineage))
    n0 = len(calls.prompts)
    out = is_(run_review(inp(r, lineageId=lineage), deps), "binding-drift")
    assert re.search("base", out["field"])
    assert sha(state_file(r, lineage)) == h0
    assert len(calls.prompts) == n0


def test_p1c_reviewed_work_committed_the_fix_in_the_finding_file_over_the_correction_budget_refused_nothing_written(r):
    calls, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    git(r.repo, "commit", "-q", "-am", "reviewed work")
    r.write("a.txt", FIXED_A + "x\n" * 400)
    h0 = sha(state_file(r, lineage))
    n0 = len(calls.prompts)
    out = is_(run_review(inp(r, lineageId=lineage), deps), "blocked")
    assert out["code"] == "correction_refused", json.dumps(out)
    assert sha(state_file(r, lineage)) == h0
    assert len(calls.prompts) == n0


def test_p4_a_run_without_lineage_id_on_a_candidate_as_base_correction_is_reported_as_pending_never_a_new_review(r):
    calls, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    git(r.repo, "commit", "-q", "-am", "reviewed work")
    r.write("a.txt", FIXED_A)
    before = len(list_lineages(r.common_dir)["lineages"])
    n0 = len(calls.prompts)
    b = is_(run_review(inp(r), deps), "blocked")
    assert b["code"] == "correction_lineage_pending"
    assert b["lineage_id"] == lineage
    assert len(list_lineages(r.common_dir)["lineages"]) == before, "no new lineage"
    assert len(calls.prompts) == n0


def test_p4b_the_same_shape_over_a_forged_unreadable_lineage_is_reported_too_never_a_new_review(r):
    _, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    forge_validating(r, lineage, "tree")
    git(r.repo, "commit", "-q", "-am", "reviewed work")
    r.write("a.txt", FIXED_A)
    before = len(list_lineages(r.common_dir)["lineages"])
    b = is_(run_review(inp(r), deps), "blocked")
    assert b["lineage_id"] == lineage
    assert len(list_lineages(r.common_dir)["lineages"]) == before


def run_in_child(cwd):
    """Runs `run_review` (no lineageId) in a child with a hard timeout; the repo is prepared by the caller."""
    script = (
        "import json, sys\n"
        "from odd_claude.review.run import run_review\n"
        "assess = lambda s, r: {'level': 'medium', 'reasons': [{'code': 'shell_source', 'signal': 'shell_process', 'path': 'a.txt'}], 'evidence': ['x']}\n"
        f"print(json.dumps(run_review({{'cwd': {cwd!r}}}, {{'riskAssessor': assess}})))\n"
    )
    env = {**os.environ, "PYTHONPATH": SRC}
    res = subprocess.run([sys.executable, "-I", "-c", script], capture_output=True, text=True, timeout=30, env=env, cwd=cwd)
    return res


def test_pending_correction_lineage_never_blocks_on_a_fifo_review_state_json_s1_s4(r):
    _, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    f = state_file(r, lineage)
    os.remove(f)
    os.mkfifo(f)
    r.write("a.txt", FIXED_A)
    res = run_in_child(r.repo)
    assert res.returncode == 0, res.stderr
    out = json.loads(res.stdout)
    assert out["outcome"] == "blocked", res.stdout
    assert out["lineage_id"] == lineage, "an unreadable lineage fails closed, never a new review"


def test_pending_correction_lineage_never_follows_a_symlinked_review_state_json_to_a_file_outside_the_store(r, tmp_path):
    _, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    f = state_file(r, lineage)
    outside = tmp_path / "outside.json"
    outside.write_text("{}")
    os.remove(f)
    os.symlink(outside, f)
    r.write("a.txt", FIXED_A)
    res = run_in_child(r.repo)
    assert res.returncode == 0, res.stderr
    out = json.loads(res.stdout)
    assert out["outcome"] == "blocked", res.stdout
    assert out["lineage_id"] == lineage
    assert outside.read_text() == "{}", "the external file is untouched"
    os.remove(f)
    os.symlink("/dev/zero", f)
    z = run_in_child(r.repo)
    assert z.returncode == 0, z.stderr
    assert json.loads(z.stdout)["lineage_id"] == lineage


def test_a1_after_a_candidate_as_base_correction_the_adopted_identity_is_original_base_corrected_tree_its_paths_receipt_self_consistent(r):
    _, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    rec = state_of(r, lineage)
    git(r.repo, "commit", "-q", "-am", "reviewed work")
    r.write("a.txt", FIXED_A)
    closed = is_(forecast_then_run(r, lineage, deps)[1], "closed")
    rc = read_receipt(r.common_dir, lineage)
    after = state_of(r, lineage)
    assert rc["base_tree"] == rec["base_tree"]
    assert rc["target_identity"] == closed["target_identity"]
    paths = tree_diff_paths(r.common_dir, rc["base_tree"], rc["candidate_tree"])
    expected = snapshot_identity("current-changes", after["projection"], rc["base_tree"], rc["candidate_tree"], digest_paths(paths))
    assert rc["target_identity"] == expected, "identity recomputes from the receipt's own base/candidate"
    assert after["target_identity"] == expected
    assert is_target_consumed(r.common_dir, expected)["status"] == "consumed"
    assert is_target_consumed(r.common_dir, rec["target_identity"])["status"] == "not_consumed"
    git(r.repo, "commit", "-q", "-am", "fix")
    first = git(r.repo, "rev-list", "--max-parents=0", "HEAD").strip()
    view = review_status(r.repo, {"target": {"kind": "base-diff", "baseRef": first, "committedOnly": True}})
    assert view["target_identity"] != expected
    assert view["consumed"]["status"] == "not_consumed"


def test_a1_a_committed_only_lineage_corrected_on_the_branch_a_fresh_status_over_the_committed_range_from_the_original_base_is_consumed(r):
    git(r.repo, "checkout", "-q", "-b", "feat")
    git(r.repo, "commit", "-q", "-am", "feature")
    target = {"kind": "base-diff", "baseRef": "main", "committedOnly": True}
    s = start_review({"cwd": r.repo, "target": target, "consent": "granted", "riskAssessor": assess("medium")})
    assert s["status"] == "started"
    lineage = s["result"]["lineage_id"]
    deps = {"riskAssessor": assess("medium"), "runner": fake_runner(findings={"risk": [SEVERE]})[1]}
    is_(forecast_then_run(r, lineage, deps, target=target)[1], "input-required")
    original = state_of(r, lineage)["target_identity"]
    r.write("a.txt", FIXED_A)
    git(r.repo, "commit", "-q", "-am", "fix")
    closed = is_(forecast_then_run(r, lineage, deps, target=target)[1], "closed")
    view = review_status(r.repo, {"target": target})
    assert view["target_identity"] == closed["target_identity"]
    assert view["consumed"]["status"] == "consumed"
    assert view["next_transition"]["reason_code"] == "target_already_acknowledged"
    assert view["target_identity"] != original


# ---- U12e: unsafe vs skipped raw state files, other-candidate skip, corrected tree back on the original base ----


def unrelated_setup(r, deps):
    lineage = to_correction_required(r, deps)
    git(r.repo, "commit", "-q", "-am", "x")
    r.write("b.txt", "bee\ny\n")
    git(r.repo, "commit", "-q", "-am", "y")
    r.write("b.txt", "bee\ny\nz\n")
    return lineage


@pytest.mark.parametrize("shape", ["hardlink", "symlink"])
def test_an_unsafe_state_file_of_an_unrelated_lineage_blocks_a_lineage_less_run_nothing_written_no_reviewer_no_new_lineage(r, tmp_path, shape):
    calls, deps = SEVERE_DEPS()
    lineage = unrelated_setup(r, deps)
    f = state_file(r, lineage)
    alias = tmp_path / "alias.json"
    if shape == "hardlink":
        os.link(f, alias)
    else:
        alias.write_bytes(Path(f).read_bytes())
        os.remove(f)
        os.symlink(alias, f)
    h0 = sha(alias)
    before = len(list_lineages(r.common_dir)["lineages"])
    n0 = len(calls.prompts)
    out = is_(run_review(inp(r), deps), "blocked")
    assert out["lineage_id"] == lineage
    assert "is a pending correction" not in out["message"]
    assert out["message"] == f"lineage {lineage} cannot be read safely; no new review is opened until it is repaired"
    assert out["code"] == "authority_error"
    assert out["detail"] == "StoreCorruptError"
    assert len(calls.prompts) == n0
    assert len(list_lineages(r.common_dir)["lineages"]) == before, "no new lineage"
    assert sha(alias) == h0, "state bytes unchanged"


def test_an_oversized_1_mib_regular_state_file_is_skipped_like_any_content_error_a_fresh_review_is_offered(r):
    _, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    f = state_file(r, lineage)
    cur = state_of(r, lineage)
    Path(f).write_text(json.dumps({"state": "correction_required", "base_tree": cur["base_tree"], "projection": cur["projection"]}) + " " * ((1 << 20) + 16))
    r.write("a.txt", FIXED_A)
    h0 = sha(f)
    out = run_review(inp(r), deps)
    assert out["outcome"] == "consent-required", json.dumps(out)[:300]
    assert sha(f) == h0


def test_an_unreadable_lineage_about_another_candidate_is_skipped_a_fresh_review_is_offered(r):
    _, deps = SEVERE_DEPS()
    lineage = unrelated_setup(r, deps)
    cur = state_of(r, lineage)
    Path(state_file(r, lineage)).write_text(json.dumps({**cur, "revision": f"sha256:{'0' * 64}"}))
    with pytest.raises(StoreCorruptError):
        read_state(r.common_dir, lineage)
    out = run_review(inp(r), deps)
    assert out["outcome"] == "consent-required", json.dumps(out)[:300]


def test_a1_after_a_candidate_as_base_correction_head_back_on_the_original_base_with_the_corrected_tree_is_target_already_acknowledged(r):
    _, deps = SEVERE_DEPS()
    lineage = to_correction_required(r, deps)
    git(r.repo, "commit", "-q", "-am", "reviewed work")
    r.write("a.txt", FIXED_A)
    closed = is_(forecast_then_run(r, lineage, deps)[1], "closed")
    git(r.repo, "commit", "-q", "-am", "fix")
    git(r.repo, "reset", "-q", "--soft", "HEAD~2")
    view = review_status(r.repo, {})
    assert view["target_identity"] == closed["target_identity"], "same identity: original base + corrected tree"
    assert view["consumed"]["status"] == "consumed"
    assert view["next_transition"]["reason_code"] == "target_already_acknowledged"


# ---- T2 / S3: reviewer runs follow the active profile route of their role ----


def route_of(calls):
    return {k: f"{o.get('model', '-')}/{o.get('effort', '-')}" for k, o in zip(calls.roles, calls.opts)}


@pytest.fixture
def profile_dir(tmp_path):
    d = tmp_path / "profile-data"
    d.mkdir()
    return str(d)


def test_s3_balanced_by_default_no_profile_state_risk_lens_opus_medium_the_other_three_lenses_sonnet_medium(r, profile_dir):
    lineage = grant(r, "high")
    calls, runner = fake_runner()
    _, done = forecast_then_run(r, lineage, {"riskAssessor": assess("high"), "runner": runner, "profileState": {"dataDir": profile_dir}})
    is_(done, "closed")
    assert route_of(calls) == {"risk": "opus/medium", "resilience": "sonnet/medium", "readability": "sonnet/medium", "reliability": "sonnet/medium"}


def test_s3_balanced_by_default_the_refuter_and_the_targeted_validator_run_opus_medium(make_repo, profile_dir):
    ps = {"dataDir": profile_dir}
    r = make_repo()
    lineage = grant(r, "medium")
    held_refuter(r, lineage)
    calls, runner = fake_runner()
    is_(forecast_then_run(r, lineage, {"riskAssessor": assess("medium"), "runner": runner, "profileState": ps})[1], "closed")
    assert route_of(calls) == {"refuter": "opus/medium"}
    r = make_repo()
    lineage = grant(r, "medium")
    calls, runner = fake_runner(findings={"risk": [SEVERE]})
    deps = {"riskAssessor": assess("medium"), "runner": runner, "profileState": ps}
    is_(forecast_then_run(r, lineage, deps)[1], "input-required")
    r.write("a.txt", FIXED_A)
    forecast = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=forecast["reviewer_run_binding"]), deps), "closed")
    assert route_of(calls) == {"risk": "opus/medium", "validator": "opus/medium"}


def test_s3_economy_stored_lenses_haiku_without_effort_refuter_and_validator_sonnet_medium(make_repo, profile_dir):
    use_profile("economy", StateOptions(data_dir=profile_dir))
    ps = {"dataDir": profile_dir}
    r = make_repo()
    lineage = grant(r, "high")
    calls, runner = fake_runner()
    is_(forecast_then_run(r, lineage, {"riskAssessor": assess("high"), "runner": runner, "profileState": ps})[1], "closed")
    assert route_of(calls) == {"risk": "haiku/-", "resilience": "haiku/-", "readability": "haiku/-", "reliability": "haiku/-"}
    r = make_repo()
    lineage = grant(r, "medium")
    held_refuter(r, lineage)
    calls, runner = fake_runner()
    is_(forecast_then_run(r, lineage, {"riskAssessor": assess("medium"), "runner": runner, "profileState": ps})[1], "closed")
    assert route_of(calls) == {"refuter": "sonnet/medium"}
    r = make_repo()
    lineage = grant(r, "medium")
    calls, runner = fake_runner(findings={"risk": [SEVERE]})
    deps = {"riskAssessor": assess("medium"), "runner": runner, "profileState": ps}
    is_(forecast_then_run(r, lineage, deps)[1], "input-required")
    r.write("a.txt", FIXED_A)
    forecast = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=forecast["reviewer_run_binding"]), deps), "closed")
    assert route_of(calls) == {"risk": "haiku/-", "validator": "sonnet/medium"}


def test_s3_an_explicit_caller_model_wins_for_every_role_and_keeps_the_callers_effort_handling(make_repo, profile_dir):
    ps = {"dataDir": profile_dir}
    r = make_repo()
    lineage = grant(r, "high")
    calls, runner = fake_runner()
    is_(forecast_then_run(r, lineage, {"riskAssessor": assess("high"), "runner": runner, "profileState": ps}, model="haiku")[1], "closed")
    assert route_of(calls) == {"risk": "haiku/-", "resilience": "haiku/-", "readability": "haiku/-", "reliability": "haiku/-"}
    r = make_repo()
    lineage = grant(r, "medium")
    held_refuter(r, lineage)
    calls, runner = fake_runner()
    is_(forecast_then_run(r, lineage, {"riskAssessor": assess("medium"), "runner": runner, "profileState": ps}, model="sonnet", effort="high")[1], "closed")
    assert route_of(calls) == {"refuter": "sonnet/high"}


def test_s3_a_profile_change_between_forecast_and_acknowledgement_is_binding_drift_never_a_different_model(r, profile_dir):
    use_profile("economy", StateOptions(data_dir=profile_dir))
    lineage = grant(r, "high")
    calls, runner = fake_runner()
    deps = {"riskAssessor": assess("high"), "runner": runner, "profileState": {"dataDir": profile_dir}}
    forecast = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    use_profile("max", StateOptions(data_dir=profile_dir))
    out = is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=forecast["reviewer_run_binding"]), deps), "binding-drift")
    assert out["field"] == "forecast"
    assert len(calls.roles) == 0, "no reviewer ran"


def test_s3_the_same_profile_acknowledged_runs_normally_and_the_forecast_slot_view_shows_the_resolved_model_effort(make_repo, profile_dir):
    use_profile("economy", StateOptions(data_dir=profile_dir))
    r = make_repo()
    lineage = grant(r, "high")
    calls, runner = fake_runner()
    forecast, done = forecast_then_run(r, lineage, {"riskAssessor": assess("high"), "runner": runner, "profileState": {"dataDir": profile_dir}})
    is_(done, "closed")
    assert len(forecast["reviewers"]) == 4
    for v in forecast["reviewers"]:
        assert v["model"] == "haiku"
        assert "effort" not in v, "haiku carries no effort"
    assert len(calls.roles) == 4
    clear_profile(StateOptions(data_dir=profile_dir))
    r = make_repo()
    lineage = grant(r, "high")
    _, runner = fake_runner()
    forecast = is_(run_review(inp(r, lineageId=lineage), {"riskAssessor": assess("high"), "runner": runner, "profileState": {"dataDir": profile_dir}}), "forecast")
    assert {v["lens"]: f"{v['model']}/{v['effort']}" for v in forecast["reviewers"]} == {"risk": "opus/medium", "resilience": "sonnet/medium", "readability": "sonnet/medium", "reliability": "sonnet/medium"}


def test_s3_an_unreadable_profile_state_never_raises_the_review_runs_with_the_balanced_route(r):
    lineage = grant(r, "medium")
    calls, runner = fake_runner()
    is_(forecast_then_run(r, lineage, {"riskAssessor": assess("medium"), "runner": runner, "profileState": {"dataDir": "relative/not/absolute"}})[1], "closed")
    assert route_of(calls) == {"risk": "opus/medium"}


def test_s3_integration_fake_claude_binary_the_argument_vector_differs_from_the_explicit_model_one_only_by_model_effort(r, fake_factory, profile_dir):
    lineage = grant(r, "medium")
    fake = fake_for(fake_factory, r, lineage, ok_answer)
    is_(forecast_then_run(r, lineage, {"profileState": {"dataDir": profile_dir}}, claudePath=fake.binary)[1], "closed")
    rec = fake.record
    assert rec["args"] == [*REVIEWER_ARGUMENTS, "--model", "opus", "--effort", "medium"]
    assert "\0".join(reviewer_arguments({"model": "opus", "effort": "medium"})) == "\0".join(rec["args"])


def test_s3_b1_economy_to_max_binding_drift_zero_calls_then_fresh_forecast_under_max_runs_opus(r, profile_dir):
    use_profile("economy", StateOptions(data_dir=profile_dir))
    lineage = grant(r, "high")
    calls, runner = fake_runner()
    deps = {"riskAssessor": assess("high"), "runner": runner, "profileState": {"dataDir": profile_dir}}
    f1 = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    use_profile("max", StateOptions(data_dir=profile_dir))
    is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=f1["reviewer_run_binding"]), deps), "binding-drift")
    assert len(calls.roles) == 0
    f2 = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    assert f2["reviewer_run_binding"] != f1["reviewer_run_binding"]
    for v in f2["reviewers"]:
        assert v["model"] == "opus"
    is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=f2["reviewer_run_binding"]), deps), "closed")
    assert [x.split("/")[0] for x in route_of(calls).values()] == ["opus"] * 4
    assert sorted(x.split("/")[1] for x in route_of(calls).values()) == sorted(v["effort"] for v in f2["reviewers"])


def test_s3_b1_balanced_default_clear_and_balanced_economy_and_custom_one_role_change(make_repo, tmp_path):
    def drift_case(change):
        d = tmp_path / f"pd{len(list(tmp_path.glob('pd*')))}"
        d.mkdir()
        ps = StateOptions(data_dir=str(d))
        r = make_repo()
        lineage = grant(r, "high")
        calls, runner = fake_runner()
        deps = {"riskAssessor": assess("high"), "runner": runner, "profileState": {"dataDir": str(d)}}
        f = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
        change(ps)
        is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=f["reviewer_run_binding"]), deps), "binding-drift")
        assert len(calls.roles) == 0

    drift_case(lambda ps: use_profile("economy", ps))
    drift_case(lambda ps: set_role("odd-review-readability", "sonnet", "high", ps))
    d = tmp_path / "pdx"
    d.mkdir()
    ps = StateOptions(data_dir=str(d))
    use_profile("balanced", ps)
    r = make_repo()
    lineage = grant(r, "high")
    calls, runner = fake_runner()
    deps = {"riskAssessor": assess("high"), "runner": runner, "profileState": {"dataDir": str(d)}}
    f = is_(run_review(inp(r, lineageId=lineage), deps), "forecast")
    clear_profile(ps)
    is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=f["reviewer_run_binding"]), deps), "closed")
    assert route_of(calls) == {"risk": "opus/medium", "resilience": "sonnet/medium", "readability": "sonnet/medium", "reliability": "sonnet/medium"}


def test_s3_b1_explicit_caller_model_profile_change_does_not_drift_runs_caller_model_view_shows_caller_model(make_repo, profile_dir):
    use_profile("economy", StateOptions(data_dir=profile_dir))
    r = make_repo()
    lineage = grant(r, "high")
    calls, runner = fake_runner()
    deps = {"riskAssessor": assess("high"), "runner": runner, "profileState": {"dataDir": profile_dir}}
    f = is_(run_review(inp(r, lineageId=lineage, model="sonnet", effort="high"), deps), "forecast")
    assert f["model"] == "sonnet"
    for v in f["reviewers"]:
        assert (v["model"], v["effort"]) == ("sonnet", "high")
    use_profile("max", StateOptions(data_dir=profile_dir))
    is_(run_review(inp(r, lineageId=lineage, model="sonnet", effort="high", reviewerRunAcknowledged=True, reviewerRunBinding=f["reviewer_run_binding"]), deps), "closed")
    assert route_of(calls) == {"risk": "sonnet/high", "resilience": "sonnet/high", "readability": "sonnet/high", "reliability": "sonnet/high"}
    clear_profile(StateOptions(data_dir=profile_dir))
    r = make_repo()
    lineage = grant(r, "high")
    calls, runner = fake_runner()
    deps = {"riskAssessor": assess("high"), "runner": runner, "profileState": {"dataDir": profile_dir}}
    f = is_(run_review(inp(r, lineageId=lineage, model="haiku"), deps), "forecast")
    is_(run_review(inp(r, lineageId=lineage, reviewerRunAcknowledged=True, reviewerRunBinding=f["reviewer_run_binding"]), deps), "binding-drift")
    assert len(calls.roles) == 0


@pytest.mark.parametrize("economy,want", [(False, "opus/medium"), (True, "sonnet/medium")])
def test_s3_b1_refuter_slot_view_shows_resolved_route_balanced_opus_medium_economy_sonnet_medium(r, profile_dir, economy, want):
    if economy:
        use_profile("economy", StateOptions(data_dir=profile_dir))
    lineage = grant(r, "medium")
    held_refuter(r, lineage)
    calls, runner = fake_runner()
    forecast, done = forecast_then_run(r, lineage, {"riskAssessor": assess("medium"), "runner": runner, "profileState": {"dataDir": profile_dir}})
    is_(done, "closed")
    assert [f"{v['role']}:{v['model']}/{v['effort']}" for v in forecast["reviewers"]] == [f"refuter:{want}"]
    assert route_of(calls) == {"refuter": want}


def test_s2_after_a_reopened_correction_a_base_that_is_none_of_base_candidate_original_is_binding_drift_base_nothing_written(r):
    calls, runner = fake_runner(findings={"risk": [SEVERE]}, validator_fails=True)
    deps = {"riskAssessor": assess("medium"), "runner": runner}
    lineage = to_correction_required(r, deps)
    git(r.repo, "commit", "-q", "-am", "reviewed work")
    r.write("a.txt", FIXED_A)
    is_(forecast_then_run(r, lineage, deps)[1], "input-required")
    assert state_of(r, lineage)["correction_attempts"] == 1
    r.write("b.txt", "unrelated\n")
    git(r.repo, "add", "b.txt")
    git(r.repo, "commit", "-q", "-m", "unrelated")
    r.write("a.txt", "UNO\nTWO\nthree\nfour\nfive\n")
    before = state_of(r, lineage)["revision"]
    spawned = len(calls.prompts)
    out = is_(run_review(inp(r, lineageId=lineage), deps), "binding-drift")
    assert out["field"] == "base"
    after = state_of(r, lineage)
    assert after["revision"] == before, "nothing written"
    assert after["state"] == "correction_required"
    assert len(calls.prompts) == spawned, "no reviewer ran"


# ---- extras: capture mode, pending_correction_lineage on a clean store ----


def test_stop_after_batch_ends_with_captured_carrying_the_capture_envelope_and_acknowledges_nothing(r):
    lineage = grant(r, "medium")
    _, runner = fake_runner()
    deps = {"riskAssessor": assess("medium"), "runner": runner, "stopAfterBatch": True}
    _, done = forecast_then_run(r, lineage, deps)
    out = is_(done, "captured")
    assert out["capture"]["outcome"] == "captured"
    assert out["capture"]["next"] == "approved"
    assert out["capture"]["acknowledgement"]["token"]
    assert state_of(r, lineage)["burned"] is False


def test_pending_correction_lineage_is_none_without_a_pending_lineage_and_for_an_empty_candidate(make_repo):
    r = make_repo()
    assert pending_correction_lineage(r.repo, {"kind": "current-changes", "projection": "workspace"}) is None
    clean = make_repo(dirty=False)
    assert pending_correction_lineage(clean.repo, {"kind": "current-changes", "projection": "workspace"}) is None


def test_an_abort_while_a_slow_reviewer_runs_returns_promptly_and_captures_nothing(r):
    lineage = grant(r, "medium")
    ac = AbortSignal()
    # the abort lands 100 ms after the reviewer started, while it still runs
    calls, runner = fake_runner(delay_ms={"risk": 1500}, during=lambda: threading.Timer(0.1, ac.abort).start())
    deps = {"riskAssessor": assess("medium"), "runner": runner}
    f = run_review(inp(r, lineageId=lineage), deps)
    t0 = time.monotonic()
    out = run_review(inp(r, lineageId=lineage, signal=ac, reviewerRunAcknowledged=True, reviewerRunBinding=f["reviewer_run_binding"]), deps)
    assert out["outcome"] == "cancelled" and time.monotonic() - t0 < 1.2 and calls.roles == ["risk"]
    time.sleep(1.6)  # the abandoned reviewer finishes; its answer must not be captured
    assert len(state_of(r, lineage)["admitted_role_results"]) == 0


def test_with_concurrency_one_an_abort_inside_the_first_reviewer_starts_no_queued_reviewer(r):
    lineage = grant(r, "high")
    ac = AbortSignal()
    calls, runner = fake_runner(during=ac.abort)
    deps = {"riskAssessor": assess("high"), "runner": runner, "concurrency": 1}
    f = run_review(inp(r, lineageId=lineage), deps)
    assert run_review(inp(r, lineageId=lineage, signal=ac, reviewerRunAcknowledged=True, reviewerRunBinding=f["reviewer_run_binding"]), deps)["outcome"] == "cancelled"
    time.sleep(0.2)
    assert calls.roles == ["risk"]


def test_concurrency_three_never_exceeds_three_live_reviewers(r):
    lineage = grant(r, "high")
    calls, runner = fake_runner(delay_ms={"risk": 60, "resilience": 60, "readability": 60, "reliability": 60})
    _, done = forecast_then_run(r, lineage, {"riskAssessor": assess("high"), "runner": runner, "concurrency": 3})
    assert done["outcome"] == "closed" and calls.max_active == 3
