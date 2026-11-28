"""Differential: review/due against v9 dist/review/due.js through the oracle. Both functions are read-only, so v9 and Python read the SAME real
temp git repos (with a local bare origin, upstreams, criss-cross merges, detached and unborn HEADs, Unicode branches and paths, declined and
started candidates, dirty workspaces over a committed range) and must return equal results or thrown messages. Exports: GIT_MS,
committedRangeBase, findDueCandidate."""
import json
import subprocess
from pathlib import Path

import pytest
from lib.v9_oracle import DIST, needs_v9
from odd_claude.review import due as D
from odd_claude.review.consent import record_decline
from odd_claude.review.risk import assess_candidate
from odd_claude.review.snapshot import resolve_repository

from review.conftest import diff_cases
from review.test_due import fx
from review.test_status import assessor, git, start

pytestmark = needs_v9
MOD = "review/due"
PKG = '{"name":"x","dependencies":{"a":"1.0.0"}}\n'


def test_constant_equals_v9():
    js = f'import * as m from {json.dumps((DIST / "review" / "due.js").as_uri())}; process.stdout.write(JSON.stringify(m.GIT_MS))'
    assert json.loads(subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True, check=True).stdout) == D.GIT_MS


class W:
    def __init__(self, tmp: Path):
        self.tmp, self.n, self.repos = tmp, 0, {}

    def new(self, name, *a):
        self.n += 1
        d = self.tmp / f"d{self.n}"
        d.mkdir()
        repo = fx(d, *a)
        self.repos[name] = repo
        return Path(repo), d


def build(tmp: Path) -> dict:
    w = W(tmp)
    w.new("high")
    w.new("low", "a.txt", "two\n")
    r, _ = w.new("clean_main")
    git(r, "checkout", "-q", "main")
    r, _ = w.new("dirty_over_range")
    (r / "package.json").write_text('{"name":"x","dependencies":{"b":"2.0.0"}}\n')
    r, _ = w.new("dirty_low_over_high_range")
    (r / "package.json").write_text(PKG)  # same content as committed: clean worktree
    (r / "notes.md").write_text("# n\n")
    r, _ = w.new("untracked_only")
    (r / "new.txt").write_text("u\n")
    r, _ = w.new("declined_range")
    a = assess_candidate(str(r), {"kind": "base-diff", "baseRef": D.committed_range_base(str(r))})
    record_decline(resolve_repository(str(r))["commonDir"], {"target_identity": a["targetIdentity"], "projection": "committed", "risk_level": "high", "declined_at": "2026-01-01T00:00:00.000Z"})
    r, _ = w.new("no_upstream_branch")
    git(r, "branch", "--unset-upstream", "main")
    git(r, "checkout", "-q", "-b", "g2")
    r, _ = w.new("origin_head_removed")
    git(r, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD")
    git(r, "checkout", "-q", "-b", "nofollow")
    r, _ = w.new("detached")
    git(r, "checkout", "-q", "--detach")
    r, _ = w.new("unicode_branch_and_paths", "café \U0001f600.json", '{"name":"x","dependencies":{"a":"1"}}\n')
    git(r, "checkout", "-q", "-b", "fé\U0001f600")
    (r / "café \U0001f600.json").write_text('{"name":"y"}\n')
    git(r, "commit", "-q", "-am", "u")
    r, _ = w.new("upstream_is_other_branch")
    git(r, "checkout", "-q", "-b", "other", "main")
    (r / "package.json").write_text('{"name":"z","scripts":{"x":"y"},"dependencies":{"q":"1"}}\n')
    git(r, "commit", "-q", "-am", "o")
    git(r, "checkout", "-q", "feature")
    git(r, "branch", "--set-upstream-to=other")
    r, _ = w.new("criss_cross")
    git(r, "checkout", "-q", "main")
    git(r, "checkout", "-q", "-b", "p")
    (r / "p.txt").write_text("p\n")
    git(r, "add", "-A")
    git(r, "commit", "-q", "-m", "p1")
    git(r, "checkout", "-q", "-b", "q", "main")
    (r / "q.txt").write_text("q\n")
    git(r, "add", "-A")
    git(r, "commit", "-q", "-m", "q1")
    q1 = git(r, "rev-parse", "HEAD").strip()
    p1 = git(r, "rev-parse", "p").strip()
    git(r, "checkout", "-q", "p")
    git(r, "merge", "-q", "--no-edit", q1)
    git(r, "checkout", "-q", "q")
    git(r, "merge", "-q", "--no-edit", p1)
    git(r, "checkout", "-q", "p")
    git(r, "branch", "--set-upstream-to=q")
    r, _ = w.new("started_on_range")
    s = None
    from odd_claude.review.start import start_review

    o = start_review({"cwd": str(r), "target": {"kind": "base-diff", "baseRef": D.committed_range_base(str(r)), "committedOnly": True}, "consent": "granted", "riskAssessor": assessor("high")})
    assert o["status"] == "started", o
    r, _ = w.new("unborn")
    d = r.parent / "unborn-repo"
    d.mkdir()
    git(d, "init", "-q", "-b", "main")
    (d / "f").write_text("x")
    w.repos["unborn"] = str(d)
    r, _ = w.new("empty_remote_range")
    git(r, "push", "-q", "origin", "feature")
    git(r, "branch", "-u", "origin/feature")
    return w.repos


@pytest.fixture(scope="module")
def repos(tmp_path_factory):
    return build(tmp_path_factory.mktemp("due-world"))


def test_committed_range_base_equals_v9(repos, tmp_path):
    bad = [str(tmp_path / "missing"), str(tmp_path), "", "rel", "é\U0001f600", repos["high"] + "\x00", repos["high"] + "/package.json", repos["high"] + "/.git"]
    diff_cases(MOD, "committedRangeBase", D.committed_range_base, [[p] for p in [*repos.values(), *bad]] + [[None], [5], [[]], [{}]])


def test_the_scenarios_cover_both_outcomes(repos):
    from lib.v9_oracle import v9

    found = {n: v9(MOD, "findDueCandidate", p) for n, p in repos.items()}
    assert found["high"] and found["dirty_over_range"] and found["unicode_branch_and_paths"] is None and found["low"] is None
    assert len(git(repos["criss_cross"], "merge-base", "--all", "HEAD", "q").split()) == 2, "two merge bases: the upstream is ambiguous, origin/HEAD decides"
    assert found["started_on_range"] is None and found["declined_range"] is None


def test_find_due_candidate_equals_v9(repos, tmp_path):
    bad = [str(tmp_path / "missing"), str(tmp_path), "", "rel", "é\U0001f600", repos["high"] + "\x00", repos["high"] + "/.git"]
    diff_cases(MOD, "findDueCandidate", D.find_due_candidate, [[p] for p in [*repos.values(), *bad]] + [[None], [5], [{}]])
