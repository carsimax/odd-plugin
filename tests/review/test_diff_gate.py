"""Differential: review/gate against v9 dist/review/gate.js through the oracle. `deliveryNotice` is read-only, so v9 and Python read the SAME
real temp git repos and data dirs: a high-risk range, a dirty workspace, a declined candidate, a low-risk range, a clean main, a clone-local
override, global mode on/off/unset/corrupt, with a wide set of delivery commands (word-match edge cases, Unicode whitespace, non-string
commands) and bad inputs. HOME and the data-dir variables are sandboxed for both sides. Exports: UNREVIEWED_DELIVERY_NOTICE, deliveryNotice."""
import json
import subprocess
from pathlib import Path

import pytest
from lib.v9_oracle import DIST, needs_v9
from odd_claude.lib.state import StateOptions
from odd_claude.review import gate as G
from odd_claude.review.mode import set_review_mode

from review.conftest import diff_cases
from review.test_due import fx
from review.test_status import git

pytestmark = needs_v9
MOD = "review/gate"

COMMANDS = [
    "git push", "git push origin feature", "git -C . push -u origin feature", "gh pr create --fill", "gh pr merge 1 --squash", "FOO=1 git push", "git add -A; git push", "git commit -am x && git push",
    "git push && git commit -m x", "ls", "git status", "gh pr view 1", "git pushx", "git push-x", "gh pr create-x", "gh pr createx", "gh pr  merge", "gh pr\tcreate", "gh pr create", "git push",
    "git﻿push", "git push", "git　push", "git\x1cpush", "git\x85push", "git\x0bpush", "git\npush", "git push\n", "git push\r\n", "git push; ls", "echo git push", "echo 'git push'", "/usr/bin/git push",
    "xgit push", "git_push", "git-push", "GIT push", "Git Push", "gh PR create", "égit push", "git pushé", "gité push", "git puésh", "git é push", "git push \U0001f600", "git; push", "git | push",
    "git & push", "git && push", "git \n push", "gh pr view; gh pr merge 1", "gh pr view && gh pr create", "gh pr; create", "git pull && git push", "git -C . merge main && git push", "git reset --hard; git push",
    "git checkout x; git push", "git switch x && git push", "git cherry-pick x; git push", "git revert HEAD; git push", "git am p.patch; git push", "git update-ref x y; git push", "git rebase main && git push",
    "git commit", "git merge", "git commit-tree x; git push", "git amend; git push", "git  push", "git\tpush", "git push" * 3, "git" + " x" * 50 + " push", " ".join(["git"] * 5) + " push", "", " ", " ",
]
ODD_COMMANDS = [5, 0, True, False, None, [], ["git push"], ["git", "push"], [["git push"]], [None, "git push"], {}, {"command": "git push"}, 1.5, "git push\u0000", "git push\ud83d"]


def test_constant_equals_v9():
    js = f'import * as m from {json.dumps((DIST / "review" / "gate.js").as_uri())}; process.stdout.write(JSON.stringify(m.UNREVIEWED_DELIVERY_NOTICE))'
    assert json.loads(subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True, check=True).stdout) == G.UNREVIEWED_DELIVERY_NOTICE


def py_notice(inp, o=None):
    o = o or {}
    return G.delivery_notice(inp, StateOptions(data_dir=o.get("dataDir"), env=o.get("env")))


class W:
    def __init__(self, tmp: Path):
        self.tmp, self.n = tmp, 0
        self.env = {"HOME": str(tmp / "home"), "ODD_CLAUDE_DATA": str(tmp / "envdata"), "ODD_CLAUDE_HOME": "", "CLAUDE_PLUGIN_DATA": ""}

    def new(self, *a):
        self.n += 1
        d = self.tmp / f"g{self.n}"
        d.mkdir()
        return Path(fx(d, *a))

    def data(self, mode=None, raw=None):
        self.n += 1
        d = self.tmp / f"data{self.n}"
        d.mkdir()
        if mode:
            set_review_mode("enable" if mode == "on" else "disable", "global", None, StateOptions(data_dir=str(d)))
        if raw is not None:
            (d / "review-mode.json").write_text(raw)
        return str(d)


@pytest.fixture(scope="module")
def world(tmp_path_factory):
    return W(tmp_path_factory.mktemp("gate-world"))


@pytest.fixture(autouse=True)
def sandbox_env(world, monkeypatch):
    for k, v in world.env.items():
        monkeypatch.setenv(k, v)


def run(world, calls):
    diff_cases(MOD, "deliveryNotice", py_notice, calls, env=world.env)


def test_high_risk_range_with_global_on_off_and_unset_equals_v9(world):
    repo = str(world.new())
    on, off, unset = world.data("on"), world.data("off"), world.data()
    run(world, [[{"cwd": repo, "command": c}, {"dataDir": on}] for c in COMMANDS] + [[{"cwd": repo, "command": "git push"}, {"dataDir": d}] for d in (off, unset, str(world.tmp / "nope"))])
    assert py_notice({"cwd": repo, "command": "git push"}, {"dataDir": on}) == G.UNREVIEWED_DELIVERY_NOTICE


def test_non_string_commands_and_bad_inputs_equal_v9(world):
    repo = str(world.new())
    on = world.data("on")
    o = {"dataDir": on}
    run(world, [[{"cwd": repo, "command": c}, o] for c in ODD_COMMANDS]
        + [[i, o] for i in [{}, {"command": "git push"}, {"cwd": repo}, {"cwd": "", "command": "git push"}, {"cwd": 5, "command": "git push"}, {"cwd": None, "command": "git push"}, {"cwd": [repo], "command": "git push"},
                            {"cwd": repo + "\x00", "command": "git push"}, {"cwd": "rel", "command": "git push"}, {"cwd": repo, "command": "git push", "extra": 1}, None, "x", 5, [], [{"cwd": repo}], True]])


def test_global_mode_files_and_option_shapes_equal_v9(world):
    repo = str(world.new())
    envelope = lambda d, v=1: json.dumps({"version": v, "sessionId": "review-mode", "data": d})  # noqa: E731
    datas = [world.data("on"), world.data(raw=envelope({"mode": "on"}, 2)), world.data(raw="{nope"), world.data(raw=envelope({"mode": "maybe"})), world.data(raw=envelope(None)), world.data(raw=""), world.data(raw="[]")]
    calls = [[{"cwd": repo, "command": "git push"}, {"dataDir": d}] for d in datas]
    calls += [[{"cwd": repo, "command": "git push"}, o] for o in [{}, {"dataDir": "relative"}, {"dataDir": ""}, {"env": {"ODD_CLAUDE_HOME": str(world.tmp / "nohome")}}, {"env": {"ODD_CLAUDE_DATA": datas[0]}},
                                                                {"env": {"HOME": str(world.tmp / "h2")}}, {"dataDir": datas[0], "env": {"ODD_CLAUDE_DATA": str(world.tmp / "zz")}}, {"dataDir": datas[0], "extra": 1}]]
    run(world, calls)


def test_workspace_declined_low_clean_and_clone_override_equal_v9(world):
    on = world.data("on")
    o = {"dataDir": on}
    dirty = world.new()
    (dirty / "package.json").write_text('{"name":"x","dependencies":{"b":"2.0.0"}}\n')
    low = world.new("a.txt", "two\n")
    clean = world.new()
    git(clean, "checkout", "-q", "main")
    override = world.new()
    set_review_mode("disable", "clone", str(override), StateOptions(data_dir=on))
    from odd_claude.review.consent import record_decline
    from odd_claude.review.due import committed_range_base
    from odd_claude.review.risk import assess_candidate
    from odd_claude.review.snapshot import resolve_repository

    declined = world.new()
    a = assess_candidate(str(declined), {"kind": "base-diff", "baseRef": committed_range_base(str(declined))})
    record_decline(resolve_repository(str(declined))["commonDir"], {"target_identity": a["targetIdentity"], "projection": "committed", "risk_level": "high", "declined_at": "2026-01-01T00:00:00.000Z"})
    broken = world.new()
    (broken / ".git" / "HEAD").write_text("garbage\n")
    uni = world.new("café \U0001f600.json", '{"name":"x","dependencies":{"a":"1"}}\n')
    git(uni, "checkout", "-q", "-b", "fé\U0001f600")
    (uni / "café \U0001f600.json").write_text('{"name":"y"}\n')
    git(uni, "commit", "-q", "-am", "u")
    plain = world.tmp / "plain"
    plain.mkdir()
    cases = [[{"cwd": str(r), "command": c}, o] for r in (dirty, low, clean, override, declined, broken, uni, plain, world.tmp / "missing") for c in ("git push", "gh pr create --fill", "git commit -m x && git push")]
    run(world, cases)
    assert py_notice({"cwd": str(dirty), "command": "git push"}, o) == G.UNREVIEWED_DELIVERY_NOTICE
    assert py_notice({"cwd": str(override), "command": "git push"}, o) is None
