import os
import stat
import time

import pytest

from odd_claude.lib.scratch import (
    TOMBSTONE_MAX_AGE_MS,
    ScratchListing,
    create_session_scratch,
    list_scratch,
    remove_session_scratch,
    scratch_dir,
    scratch_root,
    sweep_stale_tombstones,
)
from odd_claude.lib.state import StateOptions

from .conftest import run_py

NOW = 1_700_000_000_000


def O(p):
    return StateOptions(data_dir=str(p))


def touch(p, text="x"):
    open(p, "w").write(text)


def test_creates_scratch_session_privately_and_is_idempotent(tmp_path):
    p = create_session_scratch("sess-1", O(tmp_path))
    assert p == str(tmp_path / "scratch" / "sess-1") == scratch_dir("sess-1", O(tmp_path))
    assert os.path.isdir(p) and not os.path.islink(p)
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(scratch_root(O(tmp_path))).st_mode) == 0o700
    touch(os.path.join(p, "keep.txt"))
    assert create_session_scratch("sess-1", O(tmp_path)) == p
    assert os.path.exists(os.path.join(p, "keep.txt")), "re-creating (resume/compact) keeps the contents"


def test_session_ids_are_confined_to_one_path_segment(tmp_path):
    for sid in ["../evil", "a/b", "..", "."]:
        assert os.path.dirname(scratch_dir(sid, O(tmp_path))) == str(tmp_path / "scratch")


def test_removal_deletes_only_that_sessions_scratch(tmp_path):
    a, b = create_session_scratch("a", O(tmp_path)), create_session_scratch("b", O(tmp_path))
    os.mkdir(os.path.join(a, "sub"))
    touch(os.path.join(a, "sub", "f"))
    assert remove_session_scratch("a", O(tmp_path)) == "removed"
    assert not os.path.exists(a)
    assert os.path.exists(b)
    assert remove_session_scratch("a", O(tmp_path)) == "absent"


def test_a_symlinked_session_dir_is_refused_and_its_target_is_left_intact(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    touch(outside / "precious")
    (tmp_path / "data" / "scratch").mkdir(parents=True)
    os.symlink(outside, tmp_path / "data" / "scratch" / "evil")
    assert remove_session_scratch("evil", O(tmp_path / "data")) == "refused"
    assert (outside / "precious").exists()
    with pytest.raises(Exception):
        create_session_scratch("evil", O(tmp_path / "data"))


def test_a_symlinked_scratch_root_is_refused_for_create_and_remove(tmp_path):
    outside = tmp_path / "outside"
    (outside / "s").mkdir(parents=True)
    (tmp_path / "data").mkdir()
    os.symlink(outside, tmp_path / "data" / "scratch")
    assert remove_session_scratch("s", O(tmp_path / "data")) == "refused"
    assert (outside / "s").exists()
    with pytest.raises(Exception, match="unsafe scratch path"):
        create_session_scratch("s", O(tmp_path / "data"))


def test_a_symlink_inside_the_scratch_is_unlinked_never_followed(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    touch(outside / "precious")
    p = create_session_scratch("s", O(tmp_path / "data"))
    os.symlink(outside, os.path.join(p, "link"))
    assert remove_session_scratch("s", O(tmp_path / "data")) == "removed"
    assert (outside / "precious").exists()


def test_list_scratch_reports_entries_and_tolerates_a_missing_dir(tmp_path):
    p = create_session_scratch("s", O(tmp_path))
    touch(os.path.join(p, "a.txt"), "12345")
    os.mkdir(os.path.join(p, "d"))
    assert list_scratch(p) == ScratchListing(exists=True, entries=["a.txt", "d/"], bytes=5)
    assert list_scratch(str(tmp_path / "nope")) == ScratchListing(exists=False, entries=[], bytes=0)


def test_hostile_session_ids_never_leave_root_a_sibling_victim_survives(tmp_path):
    d = tmp_path / "data"
    d.mkdir()
    (tmp_path / "victim").mkdir()
    touch(tmp_path / "victim" / "marker")
    touch(tmp_path / "marker")
    for sid in ["..", "../..", "/", "a/../../x", "../victim"]:
        assert os.path.dirname(scratch_dir(sid, O(d))) == str(d / "scratch")
        create_session_scratch(sid, O(d))
        remove_session_scratch(sid, O(d))
        assert (tmp_path / "victim" / "marker").exists(), sid
        assert (tmp_path / "marker").exists()
        assert (d / "scratch").exists(), "root is never removed"


def test_a_relative_data_dir_is_refused_by_create_and_remove_and_deletes_nothing(tmp_path, monkeypatch):
    os.makedirs(tmp_path / "scratch" / "sess-2")
    monkeypatch.chdir(tmp_path)
    with pytest.raises(Exception, match="absolute"):
        remove_session_scratch("sess-2", StateOptions(data_dir="."))
    with pytest.raises(Exception, match="absolute"):
        remove_session_scratch("sess-2", StateOptions(env={"CLAUDE_PLUGIN_DATA": "."}))
    with pytest.raises(Exception, match="absolute"):
        create_session_scratch("sess-2", StateOptions(data_dir="."))
    assert (tmp_path / "scratch" / "sess-2").exists()


@pytest.mark.parametrize("kind", ["file", "symlink"])
def test_a_file_or_symlink_planted_at_the_predicted_tombstone_name_aborts_the_removal(tmp_path, monkeypatch, kind):
    d, outside = tmp_path / "data", tmp_path / "outside"
    p = create_session_scratch("sess-1", O(d))
    touch(os.path.join(p, "keep"))
    (outside / "victim").mkdir(parents=True)
    touch(outside / "victim" / "MARK")
    monkeypatch.setattr(time, "time", lambda: NOW / 1000)
    tomb = os.path.join(os.path.realpath(d / "scratch"), f".rm-{os.getpid()}-{NOW}-sess-1")
    if kind == "file":
        touch(tomb, "planted")
    else:
        os.symlink(outside / "victim", tomb)
    assert remove_session_scratch("sess-1", O(d)) == "refused"
    assert os.path.exists(os.path.join(p, "keep")), "session dir kept"
    assert (outside / "victim" / "MARK").exists(), "victim intact"


@pytest.mark.skipif(os.getuid() == 0, reason="root ignores directory modes")
def test_a_read_only_scratch_root_refuses_the_removal_and_keeps_the_dir(tmp_path):
    p = create_session_scratch("sess-1", O(tmp_path))
    root = tmp_path / "scratch"
    os.chmod(root, 0o500)
    try:
        assert remove_session_scratch("sess-1", O(tmp_path)) == "refused"
        assert os.path.exists(p)
        assert "scratch removal aborted" in open(tmp_path / "logs" / "hooks.log").read()
    finally:
        os.chmod(root, 0o700)


def test_a_leftover_tombstone_of_a_crashed_removal_is_never_touched_by_another_sessions_removal(tmp_path):
    create_session_scratch("a", O(tmp_path))
    left = tmp_path / "scratch" / ".rm-1-1700000000000-crashed"
    left.mkdir()
    touch(left / "f")
    assert remove_session_scratch("a", O(tmp_path)) == "removed"
    assert (left / "f").exists()


def test_sweep_removes_only_stale_real_directory_tombstones_inside_the_root_and_never_follows_symlinks(tmp_path):
    outside = tmp_path / "outside"
    root = tmp_path / "data" / "scratch"
    create_session_scratch("live", O(tmp_path / "data"))
    stale, fresh = root / f".rm-1-{NOW - 2 * 3600_000}-old", root / f".rm-1-{NOW - 60_000}-new"
    link, file, odd = root / f".rm-1-{NOW - 2 * 3600_000}-link", root / f".rm-1-{NOW - 2 * 3600_000}-file", root / ".rm-garbage"
    for d in (stale, fresh, odd):
        d.mkdir()
        touch(d / "f")
    touch(file)
    (outside / "victim").mkdir(parents=True)
    touch(outside / "victim" / "MARK")
    os.symlink(outside / "victim", link)
    assert sweep_stale_tombstones(O(tmp_path / "data"), NOW) == 1
    assert not stale.exists()
    assert fresh.exists() and odd.exists() and file.exists(), "fresh, unparseable and non-directory entries are kept"
    assert link.is_symlink()
    assert (outside / "victim" / "MARK").exists()
    assert (root / "live").exists()


def test_sweep_is_a_no_op_for_a_missing_or_symlinked_root(tmp_path):
    outside = tmp_path / "outside"
    (tmp_path / "data").mkdir()
    assert sweep_stale_tombstones(O(tmp_path / "data"), 1e15) == 0
    (outside / ".rm-1-1-old").mkdir(parents=True)
    os.symlink(outside, tmp_path / "data" / "scratch")
    assert sweep_stale_tombstones(O(tmp_path / "data"), 1e15) == 0
    assert (outside / ".rm-1-1-old").exists()


def test_a_tombstone_leftover_does_not_break_removal_and_the_dir_ends_up_gone(tmp_path):
    p = create_session_scratch("s", O(tmp_path))
    touch(os.path.join(p, "f"))
    assert remove_session_scratch("s", O(tmp_path)) == "removed"
    assert list_scratch(str(tmp_path / "scratch")).entries == []


def test_sweep_unlinks_symlinks_inside_a_stale_tombstone_without_following_them(tmp_path):
    outside, root = tmp_path / "outside", tmp_path / "data" / "scratch"
    root.mkdir(parents=True)
    tomb = root / f".rm-1-{NOW - 2 * 3600_000}-x"
    tomb.mkdir()
    (outside / "victim").mkdir(parents=True)
    touch(outside / "victim" / "MARKER")
    os.symlink(outside / "victim", tomb / "link")
    assert sweep_stale_tombstones(O(tmp_path / "data"), NOW) == 1
    assert not tomb.exists()
    assert (outside / "victim" / "MARKER").exists()


def test_sweep_ignores_malformed_and_future_dated_names(tmp_path):
    root = tmp_path / "scratch"
    root.mkdir()
    names = [".rm-x-y-z", ".rm--1000-x", ".rm-1-1000", ".rm-1-1e3-x", ".rm-1-99999999999999999-a"]
    for n in names:
        (root / n).mkdir()
    assert sweep_stale_tombstones(O(tmp_path), NOW) == 0
    assert all((root / n).exists() for n in names)


def test_sweep_honours_the_200_cap_and_counts_only_tombstone_entries(tmp_path):
    root = tmp_path / "scratch"
    root.mkdir()
    for i in range(250):
        (root / f".rm-1-{NOW - 2 * 3600_000}-t{i}").mkdir()
    assert sweep_stale_tombstones(O(tmp_path), NOW) == 200
    assert sweep_stale_tombstones(O(tmp_path), NOW) == 50
    assert sweep_stale_tombstones(O(tmp_path), NOW) == 0


def test_non_tombstone_entries_do_not_starve_the_sweep(tmp_path):
    root = tmp_path / "scratch"
    root.mkdir()
    for i in range(250):
        (root / f"a-session-{i}").mkdir()
    tomb = root / f".rm-1-{NOW - 2 * 3600_000}-z"
    tomb.mkdir()
    assert sweep_stale_tombstones(O(tmp_path), NOW) == 1
    assert not tomb.exists()


SWEEP = """
import sys
from odd_claude.lib.scratch import sweep_stale_tombstones
from odd_claude.lib.state import StateOptions
sweep_stale_tombstones(StateOptions(data_dir=sys.argv[1]))
"""


def test_concurrent_sweeps_ignore_enoent_silently_no_hooks_log_flood(tmp_path):
    from .conftest import spawn_py

    root = tmp_path / "scratch"
    root.mkdir()
    old = int(time.time() * 1000) - 2 * 3600_000
    for i in range(200):
        t = root / f".rm-1-{old}-c{i}"
        (t / "a" / "b").mkdir(parents=True)
        touch(t / "a" / "b" / "f")
    procs = [spawn_py(SWEEP, str(tmp_path)) for _ in range(4)]
    assert [c.wait(timeout=60) for c in procs] == [0] * 4
    log = tmp_path / "logs" / "hooks.log"
    text = log.read_text() if log.exists() else ""
    assert "No such file" not in text and "Errno 2" not in text, text
    assert os.listdir(root) == []


def test_tombstone_max_age_is_one_hour():
    assert TOMBSTONE_MAX_AGE_MS == 3_600_000
