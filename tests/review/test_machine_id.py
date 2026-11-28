"""Port of v9 review/machine-id.spec.ts (11 test() cases; the file-content loop expands to 4)."""
import os
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

from odd_claude.review.machine_id import is_machine_id, load_machine_id, state_home

SRC = Path(__file__).resolve().parents[2] / "src"
ENV = {**os.environ, "PYTHONPATH": str(SRC)}
OTHER = "33333333-3333-4333-8333-333333333333\n"


def paths(d: Path) -> tuple[Path, Path]:
    return d / "odd-plugin", d / "odd-plugin" / "machine-id"


def test_created_once_0600_regular_uuid_and_reused(tmp_path: Path):
    a = load_machine_id(str(tmp_path))
    assert is_machine_id(a)
    _, f = paths(tmp_path)
    st = f.stat()
    assert stat.S_ISREG(st.st_mode)
    assert st.st_mode & 0o777 == 0o600
    assert load_machine_id(str(tmp_path)) == a
    assert f.read_text().strip() == a
    assert os.listdir(tmp_path / "odd-plugin") == ["machine-id"]
    assert (tmp_path / "odd-plugin").stat().st_mode & 0o777 == 0o700


@pytest.mark.parametrize("content", ["hello\n", "", "a" * 200 + "\n", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA\n"], ids=["corrupt", "empty", "oversized", "uppercase"])
def test_unusable_file_is_none_never_raises_file_untouched(tmp_path: Path, content: str):
    d, f = paths(tmp_path)
    d.mkdir()
    f.write_text(content)
    assert load_machine_id(str(tmp_path)) is None
    assert f.read_text() == content


def test_a_hardlinked_file_is_rejected(tmp_path: Path):
    d, f = paths(tmp_path)
    d.mkdir()
    other = tmp_path / "other"
    other.write_text(OTHER)
    os.link(other, f)
    assert load_machine_id(str(tmp_path)) is None


def test_symlinked_file_is_never_followed(tmp_path: Path):
    d, f = paths(tmp_path)
    d.mkdir()
    target = tmp_path / "target"
    target.write_text(OTHER)
    os.symlink(target, f)
    assert load_machine_id(str(tmp_path)) is None


def test_symlinked_odd_plugin_directory_is_never_followed(tmp_path: Path):
    real = tmp_path / "real"
    real.mkdir()
    os.symlink(real, tmp_path / "odd-plugin")
    assert load_machine_id(str(tmp_path)) is None
    assert os.listdir(real) == []


def test_unreadable_file_and_unusable_state_dir_are_none(tmp_path: Path):
    d, f = paths(tmp_path)
    d.mkdir()
    f.write_text(OTHER)
    f.chmod(0)
    if os.getuid() != 0:
        assert load_machine_id(str(tmp_path)) is None
    f.chmod(0o600)
    blocker = tmp_path / "blocker"
    blocker.write_text("x")
    assert load_machine_id(str(blocker / "sub")) is None  # ENOTDIR


def test_state_home_honors_an_absolute_xdg_state_home_only():
    assert state_home({"XDG_STATE_HOME": "/x/y"}) == "/x/y"
    assert state_home({"XDG_STATE_HOME": "relative"}) != "relative"
    assert state_home({}) is None or state_home({}) != ""
    assert state_home({"XDG_STATE_HOME": ""}) == state_home({})


_LOAD = "import sys; from odd_claude.review.machine_id import load_machine_id; sys.stdout.write(str(load_machine_id(sys.argv[1])))"


def _race(d: str, n: int = 8) -> list[str]:
    ps = [subprocess.Popen([sys.executable, "-c", _LOAD, d], env=ENV, stdout=subprocess.PIPE, text=True) for _ in range(n)]
    return [p.communicate()[0] for p in ps]


def test_concurrent_first_creation_by_several_processes_yields_one_id(tmp_path: Path):
    ids = _race(str(tmp_path))
    assert is_machine_id(ids[0]), ids
    assert set(ids) == {ids[0]}
    assert paths(tmp_path)[1].read_text().strip() == ids[0]
    assert os.listdir(tmp_path / "odd-plugin") == ["machine-id"]


def test_b2_concurrent_first_creation_never_yields_none_20_rounds(tmp_path: Path):
    for rnd in range(20):
        d = tmp_path / f"r{rnd}"
        d.mkdir()
        ids = _race(str(d))
        assert is_machine_id(ids[0]), f"round {rnd}: {ids}"
        assert set(ids) == {ids[0]}, f"round {rnd}: {ids}"


def test_b2_machine_id_does_not_cache_a_failure_and_caches_the_first_success(tmp_path: Path):
    a, b = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    script = f"""
import json, os, sys
from odd_claude.review.machine_id import machine_id
file, other = sys.argv[1], sys.argv[2]
os.makedirs(os.path.dirname(file), exist_ok=True)
open(other, "w").write("{a}\\n")
os.link(other, file)  # persistent hardlink: nlink 2
r1 = machine_id()
os.unlink(other)
r2 = machine_id()
open(file, "w").write("{b}\\n")
r3 = machine_id()
sys.stdout.write(json.dumps([r1, r2, r3]))
"""
    r = subprocess.run([sys.executable, "-c", script, str(paths(tmp_path)[1]), str(tmp_path / "other")], env={**ENV, "XDG_STATE_HOME": str(tmp_path)}, capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    import json

    assert json.loads(r.stdout) == [None, a, a]


def test_b2_a_persistent_hardlink_gives_up_within_a_bound(tmp_path: Path):
    d, f = paths(tmp_path)
    d.mkdir()
    other = tmp_path / "other"
    other.write_text(OTHER)
    os.link(other, f)
    t0 = time.perf_counter()
    assert load_machine_id(str(tmp_path)) is None
    assert (time.perf_counter() - t0) * 1000 < 1000
