"""v9 review/due.ts has no own spec: its behavior is pinned through the v9 gate spec (ported in test_gate.py) and covered here."""
import os

import pytest
from odd_claude.review import due as D
from odd_claude.review.status import review_status

from review.test_status import git


def fx(tmp_path, file="package.json", change='{"name":"x","dependencies":{"a":"1.0.0"}}\n'):
    repo = tmp_path / "repo"
    origin = tmp_path / "origin.git"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    (repo / file).write_text('{"name":"x"}\n' if file == "package.json" else "one\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "init")
    git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "-q", "-u", "origin", "main")
    git(repo, "remote", "set-head", "origin", "main")
    git(repo, "checkout", "-q", "-b", "feature")
    (repo / file).write_text(change)
    git(repo, "commit", "-q", "-am", "change")
    return str(repo.resolve())


def test_constants():
    assert D.GIT_MS == 5000


def test_committed_range_base_is_the_merge_base_of_a_non_empty_range(tmp_path):
    repo = fx(tmp_path)
    assert D.committed_range_base(repo) == git(repo, "rev-parse", "main").strip()
    assert D.committed_range_base(str(tmp_path / "nope")) is None
    git(repo, "checkout", "-q", "main")
    assert D.committed_range_base(repo) is None, "HEAD is the merge base: nothing to deliver"


def test_committed_range_base_without_upstream_or_remote_is_none(tmp_path):
    (tmp_path / "r").mkdir()
    repo = tmp_path / "r"
    git(repo, "init", "-q", "-b", "main")
    (repo / "a").write_text("x")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "i")
    assert D.committed_range_base(str(repo)) is None


def test_find_due_candidate_high_risk_committed_range_only(tmp_path):
    repo = fx(tmp_path)
    c = D.find_due_candidate(repo)
    assert c is not None and c["target"] == {"kind": "base-diff", "baseRef": D.committed_range_base(repo), "committedOnly": True}
    assert c["status"]["next_transition"]["execute"]["operation"] == "review.start"
    low = tmp_path / "low"
    low.mkdir()
    assert D.find_due_candidate(fx(low, "a.txt", "two\n")) is None, "low risk is not due"


def test_find_due_candidate_dirty_workspace_wins_and_declined_or_missing_is_none(tmp_path):
    repo = fx(tmp_path)
    (tmp_path / "repo" / "package.json").write_text('{"name":"x","dependencies":{"b":"2.0.0"}}\n')
    c = D.find_due_candidate(repo)
    assert c["target"] == {"kind": "current-changes"} and c["status"] == review_status(repo, {"gitTimeoutMs": D.GIT_MS})
    with pytest.raises(Exception):
        D.find_due_candidate(str(tmp_path / "missing"))
