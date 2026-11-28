"""Port of v9 review/gate.spec.ts (6 tests; the hook-run scenarios go through `delivery_notice`, the hook runner is Phase 4) plus extra cases."""
import os
import re
from pathlib import Path

import pytest
from odd_claude.lib.state import StateOptions
from odd_claude.review import gate as G
from odd_claude.review.consent import record_decline
from odd_claude.review.due import committed_range_base
from odd_claude.review.mode import set_review_mode
from odd_claude.review.risk import assess_candidate
from odd_claude.review.snapshot import resolve_repository

from review.test_due import fx
from review.test_status import git

NOTICE = "RDD: this repository has an unreviewed candidate; review it before delivery."


class F:
    def __init__(self, tmp_path, *a):
        self.dir = tmp_path
        self.repo = fx(tmp_path, *a)
        self.data = str(tmp_path / "data")
        self.o = StateOptions(data_dir=self.data)

    def on(self):
        set_review_mode("enable", "global", self.repo, StateOptions(data_dir=self.data))

    def off(self):
        set_review_mode("disable", "global", self.repo, StateOptions(data_dir=self.data))

    def notice(self, command, cwd=None):
        return G.delivery_notice({"cwd": cwd or self.repo, "command": command}, self.o)


def test_the_notice_constant_and_rdd_on_each_delivery_command_shows_the_notice(tmp_path):
    f = F(tmp_path)
    f.on()
    assert G.UNREVIEWED_DELIVERY_NOTICE == NOTICE
    for c in ["git push", "git push origin feature", "git -C . push -u origin feature", "gh pr create --fill", "gh pr merge 1 --squash", "FOO=1 git push"]:
        assert f.notice(c) == NOTICE, c


def test_delivery_notice_pins_its_word_match(tmp_path):
    f = F(tmp_path)
    f.on()
    for c in ["FOO=1 git push", "git -C . push", "git add -A; git push"]:
        assert f.notice(c) == NOTICE, c
    assert f.notice("git commit -am x && git push") is None


def test_rdd_off_non_delivery_commands_and_a_chain_that_changes_the_candidate_stay_silent(tmp_path):
    f = F(tmp_path)
    for c in ["git push", "gh pr create --fill"]:
        assert f.notice(c) is None, f"default off: {c}"
    f.off()
    assert f.notice("git push") is None
    f.on()
    for c in ["ls", "git status", "gh pr view 1", "git pushx", "git commit -m x && git push", "git -C . merge main && git push", "git pull && git push"]:
        assert f.notice(c) is None, c
    assert f.notice("git push") == NOTICE, "control"


def test_a_reviewed_declined_low_risk_or_empty_candidate_shows_nothing(tmp_path):
    f = F(tmp_path)
    low_dir = tmp_path / "lowdir"
    low_dir.mkdir()
    low = F(low_dir, "a.txt", "two\n")
    f.on()
    assert f.notice("git push") == NOTICE
    base = committedRangeBase = committed_range_base(f.repo)
    a = assess_candidate(f.repo, {"kind": "base-diff", "baseRef": base})
    assert a["status"] == "assessed"
    record_decline(resolve_repository(f.repo)["commonDir"], {"target_identity": a["targetIdentity"], "projection": "committed", "risk_level": "high", "declined_at": "2026-01-01T00:00:00.000Z"})
    assert f.notice("git push") is None, "declined"
    low.on()
    assert low.notice("git push") is None, "low risk is not due"
    git(f.repo, "push", "-q", "origin", "feature")
    git(f.repo, "fetch", "-q", "origin")
    git(f.repo, "checkout", "-q", "main")
    assert f.notice("git push") is None, "nothing to deliver"
    assert committedRangeBase is not None


def test_every_failure_is_silent_not_a_repository_missing_directory_broken_repository_bad_input(tmp_path):
    f = F(tmp_path)
    f.on()
    plain = tmp_path / "plain"
    plain.mkdir()
    assert f.notice("git push", str(plain)) is None
    assert f.notice("git push", str(tmp_path / "missing")) is None
    for bad in [{}, {"command": "git push"}, {"cwd": f.repo}, {"cwd": "", "command": "git push"}, {"cwd": f.repo, "command": 5}, {"cwd": f.repo, "command": None}, {"cwd": 5, "command": "git push"}]:
        assert G.delivery_notice(bad, f.o) is None, bad
    Path(f.repo, ".git", "HEAD").write_text("garbage\n")
    assert f.notice("git push") is None, "broken repository"
    assert G.delivery_notice({"cwd": f.repo, "command": "git push"}, StateOptions(data_dir=str(tmp_path / "no" / "such"))) is None


def test_the_notice_module_can_never_deny_no_permission_or_decision_shape_in_the_gate():
    text = Path(G.__file__).read_text(encoding="utf-8")
    assert not re.search(r"permission[A-Z]|\"deny\"|\"ask\"|\bdecision\s*:|\"decision\"|continue\s*:\s*false|stopReason", text)


def test_unicode_and_odd_commands(tmp_path):
    f = F(tmp_path)
    f.on()
    assert f.notice("git push é\U0001f600") == NOTICE
    assert f.notice("git push") == NOTICE, "JS \\s includes NBSP"
    assert f.notice("git﻿push") == NOTICE, "JS \\s includes the BOM"
    assert f.notice("git\x1cpush") is None, "JS \\s excludes FS"
    assert f.notice("git push\n") == NOTICE
    assert f.notice("") is None
    assert os.path.isdir(f.repo)
