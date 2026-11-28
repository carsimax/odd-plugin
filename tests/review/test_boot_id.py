"""Port of v9 review/boot-id.spec.ts (8 test() cases)."""
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from odd_claude.review import boot_id as boot_mod
from odd_claude.review.boot_id import SYSCTL_PATH, BootReaders, is_boot_id, parse_linux_boot, parse_mac_boot, read_boot_id

U = "4fd77cbd-1111-4222-8333-444455556666"


def readers(**over) -> BootReaders:
    base = dict(platform="linux", read_text=lambda p: None, read_link=lambda p: None, sysctl=lambda n: None)
    return BootReaders(**{**base, **over})


def test_linux_boot_id_and_pid_namespace_are_joined():
    assert parse_linux_boot(f"{U}\n", "pid:[4026531836]") == f"{U}/pid:[4026531836]"
    r = readers(
        read_text=lambda p: f"{U}\n" if p == "/proc/sys/kernel/random/boot_id" else None,
        read_link=lambda p: "pid:[4026531836]" if p == "/proc/self/ns/pid" else None,
    )
    assert read_boot_id(r) == f"{U}/pid:[4026531836]"


def test_linux_two_pid_namespaces_of_the_same_boot_differ():
    assert parse_linux_boot(U, "pid:[4026531836]") != parse_linux_boot(U, "pid:[4026532999]")


def test_linux_garbage_oversized_missing_parts_are_none():
    assert parse_linux_boot("garbage", "pid:[1]") is None
    assert parse_linux_boot("a" * 500, "pid:[1]") is None
    assert parse_linux_boot(U, "net:[1]") is None
    assert parse_linux_boot(U, "pid:[x]") is None
    assert parse_linux_boot(U, None) is None
    assert parse_linux_boot(None, "pid:[1]") is None
    assert read_boot_id(readers(read_text=lambda p: "garbage", read_link=lambda p: "pid:[1]")) is None


def test_macos_bootsessionuuid_garbage_and_failures_are_none():
    assert parse_mac_boot(f"{U.upper()}\n") == f"mac:{U}"
    assert read_boot_id(readers(platform="darwin", sysctl=lambda n: f"{U}\n" if n == "kern.bootsessionuuid" else None)) == f"mac:{U}"
    assert parse_mac_boot("nope") is None
    assert parse_mac_boot("x" * 10_000) is None
    assert parse_mac_boot(None) is None
    assert read_boot_id(readers(platform="darwin")) is None


def test_other_platforms_and_raising_readers_are_none_never_raise():
    assert read_boot_id(readers(platform="win32")) is None

    def boom(p):
        raise RuntimeError("boom")

    assert read_boot_id(readers(read_text=boom)) is None


def test_is_boot_id_is_strict():
    assert is_boot_id(f"{U}/pid:[4026531836]")
    assert not is_boot_id("")
    assert not is_boot_id("a b")
    assert not is_boot_id("x" * 129)
    assert not is_boot_id(5)
    assert not is_boot_id("ab\n")


def test_sysctl_is_spawned_by_absolute_path():
    assert SYSCTL_PATH == "/usr/sbin/sysctl"
    assert os.path.isabs(SYSCTL_PATH)


def test_real_readers_bounded_read_rejects_non_regular_and_oversized(tmp_path: Path):
    f = tmp_path / "f"
    f.write_text("hello")
    assert boot_mod._bounded_read(str(f)) == "hello"
    f.write_text("x" * 129)
    assert boot_mod._bounded_read(str(f)) is None
    f.write_text("x" * 128)
    assert boot_mod._bounded_read(str(f)) == "x" * 128
    assert boot_mod._bounded_read(str(tmp_path)) is None  # a directory
    assert boot_mod._bounded_read(str(tmp_path / "missing")) is None


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS only")
def test_darwin_a_fake_sysctl_first_on_path_is_never_spawned(tmp_path: Path):
    fake_uuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    marker = tmp_path / "marker"
    fake = tmp_path / "sysctl"
    fake.write_text(f"#!/bin/sh\necho ran > '{marker}'\necho {fake_uuid}\n")
    fake.chmod(0o755)
    src = Path(__file__).resolve().parents[2] / "src"
    r = subprocess.run(
        [sys.executable, "-c", "from odd_claude.review.boot_id import boot_id; print(boot_id())"],
        env={**os.environ, "PATH": f"{tmp_path}:{os.environ.get('PATH', '')}", "PYTHONPATH": str(src)},
        capture_output=True, text=True, timeout=30,
    )
    assert r.returncode == 0, r.stderr
    assert not marker.exists(), "the fake sysctl from PATH ran"
    assert fake_uuid not in r.stdout
    assert re.fullmatch(r"mac:[0-9a-f-]{36}\n", r.stdout)
