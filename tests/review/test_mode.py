"""Port of v9 review/mode.spec.ts (14 tests) plus extra cases (byte-exact files, modes, fail-closed reads)."""
import json
import os
import shutil
import stat
import subprocess
import time
from pathlib import Path

import pytest

from odd_claude.lib.state import StateOptions
from odd_claude.review.mode import (
    CLONE_MODE_SCHEMA, MODE_SCHEMA, MODE_STATE_NAME, ModeOptions, ReviewModeError, clone_mode_path, is_global_mode_on, read_review_mode, set_review_mode,
)
from odd_claude.review.snapshot import SnapshotError, resolve_repository

GIT_ENV = {**{k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_")}, "GIT_CONFIG_NOSYSTEM": "1"}


class Fx:
    def __init__(self, base: Path):
        d = base.resolve()
        self.dir = d
        self.repo = str(d / "repo")
        self.plain = str(d / "plain")
        os.mkdir(self.repo)
        os.mkdir(self.plain)
        assert subprocess.run(["git", "-C", self.repo, "init", "-q", "-b", "main"], env=GIT_ENV).returncode == 0
        self.data = str(d / "data")
        self.common = os.path.realpath(os.path.join(self.repo, ".git"))
        self.opts = ModeOptions(data_dir=self.data)


@pytest.fixture
def f(tmp_path):
    return Fx(tmp_path)


def tree(d) -> list[str]:
    d = Path(d)
    if not d.exists():
        return []
    out = []
    for p in sorted(d.rglob("*")):
        out.append(str(p) + ("/" if p.is_dir() and not p.is_symlink() else ":" + p.read_text()))
    return out


def test_default_is_off_nothing_stored_nothing_set_source_default(f, tmp_path):
    assert read_review_mode(f.repo, f.opts) == {"effective": "off", "source": "default", "global": "unset", "cloneLocal": "unset", "problems": []}
    assert read_review_mode(None, f.opts)["effective"] == "off"
    assert read_review_mode(f.repo, ModeOptions(env={"ODD_CLAUDE_HOME": os.path.join(f.data, "nohome")}))["effective"] == "off"


def test_global_enable_disable_on_only_after_enable_off_again_after_disable(f):
    on = set_review_mode("enable", "global", f.repo, f.opts)
    assert on["effective"] == "on" and on["source"] == "global"
    assert read_review_mode(f.repo, f.opts)["effective"] == "on"
    assert read_review_mode(f.plain, f.opts)["effective"] == "on"  # global applies outside a repo too
    off = set_review_mode("disable", "global", f.repo, f.opts)
    assert [off["effective"], off["source"], off["global"]] == ["off", "global", "off"]


def test_clone_scope_disable_stores_an_off_only_override_enable_clears_it_and_never_forces_on(f, tmp_path):
    set_review_mode("enable", "global", f.repo, f.opts)
    off = set_review_mode("disable", "clone", f.repo, f.opts)
    assert [off["effective"], off["source"], off["cloneLocal"], off["global"]] == ["off", "clone-local", "off", "on"]
    assert clone_mode_path(f.common) == os.path.join(f.common, "odd-plugin", "review-mode.json")
    assert os.path.isfile(clone_mode_path(f.common)) and not os.path.islink(clone_mode_path(f.common))
    (tmp_path / "o").mkdir()
    other = Fx(tmp_path / "o")
    assert read_review_mode(other.repo, f.opts)["effective"] == "on"  # the override is per clone
    cleared = set_review_mode("enable", "clone", f.repo, f.opts)
    assert [cleared["effective"], cleared["source"], cleared["cloneLocal"]] == ["on", "global", "unset"]
    assert not os.path.exists(clone_mode_path(f.common))
    set_review_mode("disable", "global", f.repo, f.opts)
    assert set_review_mode("enable", "clone", f.repo, f.opts)["effective"] == "off"  # cannot turn it on
    assert set_review_mode("enable", "clone", f.repo, f.opts)["cloneLocal"] == "unset"  # already clear: no-op


def test_clone_scope_without_a_repository_global_scope_with_a_relative_data_dir_typed_errors_nothing_written(f):
    for args in (("disable", "clone", f.plain), ("disable", "clone", None)):
        with pytest.raises(ReviewModeError):
            set_review_mode(*args, f.opts)
    with pytest.raises(ReviewModeError, match="cannot write the global review mode: data dir must be an absolute path"):
        set_review_mode("enable", "global", f.repo, ModeOptions(data_dir="relative"))
    assert tree(f.data) == []
    assert tree(os.path.join(f.common, "odd-plugin")) == []


def test_status_is_read_only_reading_writes_and_creates_nothing_before_and_after_a_write(f):
    plug = lambda: [t for t in tree(f.common) if "odd-plugin" in t]  # noqa: E731
    before = [tree(f.data), plug()]
    read_review_mode(f.repo, f.opts)
    assert [tree(f.data), plug()] == before
    set_review_mode("enable", "global", f.repo, f.opts)
    set_review_mode("disable", "clone", f.repo, f.opts)
    snap = [tree(f.data), tree(os.path.join(f.common, "odd-plugin"))]
    for _ in range(3):
        read_review_mode(f.repo, f.opts)
    assert [tree(f.data), tree(os.path.join(f.common, "odd-plugin"))] == snap


def test_a_clone_override_that_cannot_be_read_or_is_malformed_fails_closed_off_and_says_why(f):
    set_review_mode("enable", "global", f.repo, f.opts)
    os.makedirs(os.path.join(f.common, "odd-plugin"))
    p = clone_mode_path(f.common)
    for body in ("{not json", json.dumps({"schema": "other", "mode": "off"}), json.dumps({"schema": "odd-claude.review-mode-override/v1", "mode": "on"})):
        Path(p).write_text(body)
        s = read_review_mode(f.repo, f.opts)
        assert [s["effective"], s["source"], s["cloneLocal"]] == ["off", "clone-local", "unreadable"], body
        assert len(s["problems"]) == 1
    os.unlink(p)
    os.symlink(f.plain, p)  # a symlink is never followed
    s = read_review_mode(f.repo, f.opts)
    assert [s["effective"], s["cloneLocal"]] == ["off", "unreadable"]
    os.unlink(p)
    Path(f.data, "review-mode.json").write_text("garbage")  # a corrupt global file reads as unset (default off), never on
    assert read_review_mode(f.repo, f.opts)["effective"] == "off"


def test_a_symlinked_odd_plugin_dir_enable_refuses_and_the_external_file_survives_disable_refuses_reads_fail_closed_to_off(f):
    set_review_mode("enable", "global", f.repo, f.opts)
    outside = os.path.join(f.plain, "elsewhere")
    os.mkdir(outside)
    external = os.path.join(outside, "review-mode.json")
    Path(external).write_text(json.dumps({"schema": "odd-claude.review-mode-override/v1", "mode": "off"}) + "\n")
    os.symlink(outside, os.path.join(f.common, "odd-plugin"))
    with pytest.raises(ReviewModeError):
        set_review_mode("enable", "clone", f.repo, f.opts)
    assert os.path.exists(external)
    with pytest.raises(ReviewModeError):
        set_review_mode("disable", "clone", f.repo, f.opts)
    assert '"off"' in Path(external).read_text()
    assert os.listdir(outside) == ["review-mode.json"]
    Path(external).write_text(json.dumps({"schema": "other"}))
    s = read_review_mode(f.repo, f.opts)
    assert [s["effective"], s["source"], s["cloneLocal"]] == ["off", "clone-local", "unreadable"]
    assert len(s["problems"]) == 1


def test_a_symlinked_odd_plugin_dir_pointing_at_an_empty_directory_reads_unreadable_off_even_with_global_on(f):
    set_review_mode("enable", "global", f.repo, f.opts)
    empty = os.path.join(f.plain, "empty-target")
    os.mkdir(empty)
    os.symlink(empty, os.path.join(f.common, "odd-plugin"))
    s = read_review_mode(f.repo, f.opts)
    assert [s["effective"], s["source"], s["cloneLocal"]] == ["off", "clone-local", "unreadable"]
    assert len(s["problems"]) == 1
    assert os.listdir(empty) == []


def test_enable_clone_refuses_a_symlinked_or_non_regular_override_file_and_leaves_it_alone(f):
    os.mkdir(os.path.join(f.common, "odd-plugin"))
    target = os.path.join(f.plain, "t.json")
    Path(target).write_text("x")
    p = clone_mode_path(f.common)
    os.symlink(target, p)
    with pytest.raises(ReviewModeError):
        set_review_mode("enable", "clone", f.repo, f.opts)
    assert os.path.exists(target) and os.path.islink(p)
    os.unlink(p)
    os.mkdir(p)
    with pytest.raises(ReviewModeError):
        set_review_mode("enable", "clone", f.repo, f.opts)
    assert os.path.isdir(p) and not os.path.islink(p)


def test_reading_never_rewrites_the_global_file_inode_mtime_and_bytes_unchanged_after_three_reads(f):
    set_review_mode("enable", "global", f.repo, f.opts)
    file = os.path.join(f.data, "review-mode.json")
    before = os.stat(file)
    data = Path(file).read_bytes()
    time.sleep(0.03)
    for _ in range(3):
        read_review_mode(f.repo, f.opts)
    after = os.stat(file)
    assert (after.st_ino, after.st_mtime_ns, Path(file).read_bytes()) == (before.st_ino, before.st_mtime_ns, data)


def _fake_git(dir_: str, trigger: str, action: str) -> str:
    os.makedirs(dir_)
    real = shutil.which("git")
    Path(dir_, "git").write_text(f'#!/bin/sh\ncase "$*" in *{trigger}*) {action};; esac\nexec {real} "$@"\n')
    os.chmod(os.path.join(dir_, "git"), 0o755)
    return dir_


def test_git_failing_while_resolving_the_repository_override_read_from_nearest_dot_git_off_wins_file_followed_unlocatable_leaves_global_no_repository_n_a(f, monkeypatch):
    set_review_mode("enable", "global", f.repo, f.opts)
    bin_ = _fake_git(os.path.join(f.plain, "bin"), "--git-common-dir", 'echo "fatal: boom" >&2; exit 128')
    sub = os.path.join(f.repo, "a", "b")
    os.makedirs(sub)
    set_review_mode("disable", "clone", f.repo, f.opts)
    path = os.environ["PATH"]
    monkeypatch.setenv("PATH", f"{bin_}:{path}")
    off = read_review_mode(sub, f.opts)
    assert (off["effective"], off["cloneLocal"]) == ("off", "off")
    monkeypatch.setenv("PATH", path)
    set_review_mode("enable", "clone", f.repo, f.opts)
    monkeypatch.setenv("PATH", f"{bin_}:{path}")
    none = read_review_mode(sub, f.opts)
    assert (none["effective"], none["cloneLocal"]) == ("on", "unset")
    wt = os.path.join(f.plain, "wt")
    os.mkdir(wt)
    Path(wt, ".git").write_text("gitdir: /nowhere\n")
    slow = _fake_git(os.path.join(f.plain, "slow"), "--show-toplevel", "exec sleep 3")
    monkeypatch.setenv("PATH", f"{slow}:{path}")
    lost = read_review_mode(wt, ModeOptions(data_dir=f.data, git_timeout_ms=800))
    assert (lost["effective"], lost["cloneLocal"]) == ("on", "n/a")
    assert "could not be located" in "\n".join(lost["problems"])
    monkeypatch.setenv("PATH", path)
    plain = os.path.join(f.plain, "empty")
    os.mkdir(plain)
    assert read_review_mode(plain, f.opts)["cloneLocal"] == "n/a"


def test_git_timing_out_dot_git_file_parsing_follows_git_crlf_absolute_with_spaces_and_unsafe_links_never_read_as_off(f, monkeypatch):
    set_review_mode("enable", "global", f.repo, f.opts)
    slow = _fake_git(os.path.join(f.plain, "slow"), "--show-toplevel", "exec sleep 3")
    opts = ModeOptions(data_dir=f.data, git_timeout_ms=400)
    root = os.path.join(f.plain, "layouts")
    os.mkdir(root)
    set_review_mode("disable", "clone", f.repo, f.opts)
    assert read_review_mode(f.repo, opts)["cloneLocal"] == "off"
    spaced = os.path.join(root, "my main repo")
    os.mkdir(spaced)
    assert subprocess.run(["git", "-C", spaced, "init", "-q", "-b", "main"], env=GIT_ENV).returncode == 0
    set_review_mode("disable", "clone", spaced, f.opts)
    spaced_common = os.path.realpath(os.path.join(spaced, ".git"))
    assert " " in spaced_common

    def layout(name, git_file, setup):
        wt, gd = os.path.join(root, name), os.path.join(root, f"{name}-gitdir")
        os.mkdir(wt)
        os.mkdir(gd)
        Path(wt, ".git").write_text(git_file(gd))
        setup(gd)
        return wt

    def status(wt):
        s = read_review_mode(wt, opts)
        return [s["effective"], s["cloneLocal"]]

    monkeypatch.setenv("PATH", f"{slow}:{os.environ['PATH']}")
    t0 = time.time()
    crlf = layout("crlf", lambda g: f"gitdir: {os.path.relpath(g, os.path.join(root, 'crlf'))}\r\n", lambda g: Path(g, "commondir").write_text(f"{os.path.relpath(f.common, g)}\r\n"))
    assert status(crlf) == ["off", "off"]
    sp = layout("sp ace", lambda g: f"gitdir: {g}\n", lambda g: Path(g, "commondir").write_text(f"{spaced_common}\n"))
    assert status(sp) == ["off", "off"]
    link = layout("link", lambda g: f"gitdir: {g}\n", lambda g: os.symlink(f.common, os.path.join(g, "commondir")))
    assert status(link) == ["on", "n/a"]
    fifo = layout("fifo", lambda g: f"gitdir: {g}\n", lambda g: os.mkfifo(os.path.join(g, "commondir")))
    assert status(fifo) == ["on", "n/a"]
    assert time.time() - t0 < 3


def test_dubious_ownership_classifier_a_warning_line_is_not_the_fatal_line(f, monkeypatch):
    bin_ = _fake_git(
        os.path.join(f.plain, "bin"), "--show-toplevel",
        "printf '%s\\n' \"warning: detected dubious ownership in repository at 'x'\" \"\tgit config --global --add safe.directory x\" >&2; exit 128",
    )
    monkeypatch.setenv("PATH", f"{bin_}:{os.environ['PATH']}")
    with pytest.raises(SnapshotError) as e:
        resolve_repository(f.repo, {"gitTimeoutMs": 800})
    assert e.value.code == "not_a_repository"


def test_is_global_mode_on_is_true_only_for_a_readable_global_on_and_agrees_with_read_review_mode_for_every_state(tmp_path):
    opts = ModeOptions(data_dir=str(tmp_path))
    file = tmp_path / "review-mode.json"
    envelope = lambda data, version=1: json.dumps({"version": version, "sessionId": "review-mode", "data": data})  # noqa: E731
    assert is_global_mode_on(opts) is False
    file.write_text(envelope({"mode": "on"}))
    assert is_global_mode_on(opts) is True
    assert read_review_mode(None, opts)["effective"] == "on"
    for name, body in (("off", envelope({"mode": "off"})), ("corrupt", "{nope"), ("wrong version", envelope({"mode": "on"}, 99)), ("unknown value", envelope({"mode": "maybe"})), ("no data", envelope(None))):
        file.write_text(body)
        assert is_global_mode_on(opts) is False, name
        assert read_review_mode(None, opts)["effective"] == "off", name
    file.unlink()
    file.mkdir()  # unreadable: a directory where the file belongs
    assert is_global_mode_on(opts) is False
    assert read_review_mode(None, opts)["effective"] == "off"


def test_is_global_mode_on_defaults_to_the_environment_state_options(tmp_path):
    assert is_global_mode_on() in (True, False)
    assert is_global_mode_on(StateOptions(data_dir=str(tmp_path))) is False


def test_mode_files_are_byte_exact_and_private(f):
    set_review_mode("enable", "global", f.repo, f.opts)
    g = Path(f.data, "review-mode.json")
    assert g.read_text() == '{\n  "version": 1,\n  "sessionId": "review-mode",\n  "data": {\n    "mode": "on"\n  }\n}\n'
    set_review_mode("disable", "clone", f.repo, f.opts)
    c = Path(clone_mode_path(f.common))
    assert c.read_text() == '{"schema":"odd-claude.review-mode-override/v1","mode":"off"}\n'
    assert stat.S_IMODE(c.stat().st_mode) == 0o600
    assert stat.S_IMODE(Path(f.common, "odd-plugin").stat().st_mode) == 0o700
    assert (MODE_STATE_NAME, MODE_SCHEMA, CLONE_MODE_SCHEMA) == ("review-mode", "odd-claude.review-mode/v1", "odd-claude.review-mode-override/v1")


def test_an_oversized_or_unlocatable_clone_override_fails_closed(f):
    os.mkdir(os.path.join(f.common, "odd-plugin"))
    Path(clone_mode_path(f.common)).write_text(" " * 5000)
    s = read_review_mode(f.repo, f.opts)
    assert (s["effective"], s["cloneLocal"]) == ("off", "unreadable")
    assert s["problems"] == [f"clone-local review mode is not a small regular file: {clone_mode_path(f.common)}"]
