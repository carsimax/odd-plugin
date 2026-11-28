"""Differential: review/machine_id against v9 dist/review/machine-id.js through the oracle."""
import os
import stat
from pathlib import Path

import pytest

from lib.v9_oracle import needs_v9, v9
from odd_claude.review.machine_id import is_machine_id, load_machine_id, machine_id, state_home
from review.conftest import diff_cases

pytestmark = needs_v9

A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
IDS = [A, A.upper(), f"{A}\n", f" {A}", "", "x", "11111111-1111-4111-8111-11111111111", "g" * 8 + A[8:], f"{A}\n\n", "\U0001f600", "\ud800", A + " ", 5, None, True, [], {}, "12345678-1234-1234-1234-123456789abc"]


def test_is_machine_id_matches_v9():
    diff_cases("review/machine-id", "isMachineId", is_machine_id, [[v] for v in IDS])


def test_state_home_matches_v9():
    envs = [{"XDG_STATE_HOME": p} for p in ("/x/y", "/x/y/", "//x//y", "/", "relative", "", "~/x", "/\U0001f600", " /x", "./x", "/x/../y")] + [{}]
    diff_cases("review/machine-id", "stateHome", state_home, [[e] for e in envs])


def test_state_home_default_env_matches_v9_with_and_without_xdg(tmp_path: Path):
    for env in ({"XDG_STATE_HOME": str(tmp_path)}, {"XDG_STATE_HOME": "rel"}, {"XDG_STATE_HOME": ""}, {"HOME": "/h//o/../me"}, {"HOME": "/h/"}, {"HOME": ""}):
        base = {"XDG_STATE_HOME": "", "HOME": os.environ.get("HOME", "")}
        want = v9("review/machine-id", "stateHome", env={**base, **env})
        got = state_home_with(env, base)
        assert want == got, f"env={env}: v9={want!r} python={got!r}"


def state_home_with(env: dict, base: dict):
    saved = dict(os.environ)
    try:
        os.environ.update({**base, **env})
        return state_home()
    finally:
        os.environ.clear()
        os.environ.update(saved)


def _shape(d: Path):
    f = d / "odd-plugin" / "machine-id"
    st = f.lstat()
    return {"mode": stat.S_IMODE(st.st_mode), "dirmode": stat.S_IMODE(f.parent.stat().st_mode), "len": st.st_size, "names": sorted(os.listdir(f.parent)), "valid": is_machine_id(f.read_text().rstrip("\n"))}


def test_a_file_created_by_each_side_has_the_same_shape_and_is_read_by_the_other(tmp_path: Path):
    d1, d2 = tmp_path / "v9", tmp_path / "py"
    d1.mkdir(), d2.mkdir()
    a = v9("review/machine-id", "loadMachineId", str(d1))
    b = load_machine_id(str(d2))
    assert is_machine_id(a) and is_machine_id(b)
    assert _shape(d1) == _shape(d2)
    assert load_machine_id(str(d1)) == a  # python reads what v9 wrote
    assert v9("review/machine-id", "loadMachineId", str(d2)) == b  # v9 reads what python wrote


def test_load_machine_id_matches_v9_on_unusable_state_dirs(tmp_path: Path):
    for i, content in enumerate(["hello\n", "", "a" * 200 + "\n", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA\n", f"{A}\n\n", f"{A}\r\n", "﻿" + A, f"{A}", f"{A} "]):
        d = tmp_path / f"c{i}"
        (d / "odd-plugin").mkdir(parents=True)
        (d / "odd-plugin" / "machine-id").write_text(content)
        assert load_machine_id(str(d)) == v9("review/machine-id", "loadMachineId", str(d)), repr(content)
    d = tmp_path / "links"
    (d / "odd-plugin").mkdir(parents=True)
    other = d / "other"
    other.write_text(A + "\n")
    os.link(other, d / "odd-plugin" / "machine-id")
    assert load_machine_id(str(d)) is None and v9("review/machine-id", "loadMachineId", str(d)) is None
    s = tmp_path / "sym"
    (s / "odd-plugin").mkdir(parents=True)
    os.symlink(other, s / "odd-plugin" / "machine-id")
    assert load_machine_id(str(s)) is None and v9("review/machine-id", "loadMachineId", str(s)) is None
    t = tmp_path / "symdir"
    t.mkdir()
    os.symlink(tmp_path, t / "odd-plugin")
    assert load_machine_id(str(t)) is None and v9("review/machine-id", "loadMachineId", str(t)) is None
    blocker = tmp_path / "blocker"
    blocker.write_text("x")
    assert load_machine_id(str(blocker / "sub")) is None and v9("review/machine-id", "loadMachineId", str(blocker / "sub")) is None


@pytest.mark.parametrize("sub", ["a//b", "a/./b/../c", "x/", "\U0001f600 sp/é"])
def test_load_machine_id_creates_the_same_normalized_path(tmp_path: Path, sub: str):
    d9, dp = str(tmp_path / "v9") + "/" + sub, str(tmp_path / "py") + "/" + sub
    a, b = v9("review/machine-id", "loadMachineId", d9), load_machine_id(dp)
    assert is_machine_id(a) and is_machine_id(b)
    walk = lambda r: sorted(str(p.relative_to(r)) for p in Path(r).rglob("*"))  # noqa: E731
    assert walk(tmp_path / "v9") == walk(tmp_path / "py")


def test_machine_id_with_xdg_state_home_reads_the_file_v9_created(tmp_path: Path):
    env = {"XDG_STATE_HOME": str(tmp_path)}
    a = v9("review/machine-id", "machineId", env=env)
    assert is_machine_id(a)
    saved = os.environ.get("XDG_STATE_HOME")
    os.environ["XDG_STATE_HOME"] = str(tmp_path)
    try:
        import odd_claude.review.machine_id as m

        m._cached = None
        assert machine_id() == a
    finally:
        os.environ.pop("XDG_STATE_HOME")
        if saved is not None:
            os.environ["XDG_STATE_HOME"] = saved
        m._cached = None
