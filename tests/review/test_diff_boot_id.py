"""Differential: review/boot_id against v9 dist/review/boot-id.js through the oracle."""
import os
import sys

import pytest

from lib.v9_oracle import needs_v9, v9
from odd_claude.review.boot_id import SYSCTL_PATH, boot_id, is_boot_id, parse_linux_boot, parse_mac_boot, read_boot_id
from review.conftest import diff_cases

pytestmark = needs_v9

U = "4fd77cbd-1111-4222-8333-444455556666"
TEXTS = [
    U, U.upper(), f"{U}\n", f" \t{U}\r\n", f"﻿{U} ", f"\x1c{U}", f"{U}\x85", "garbage", "", " ", "a" * 500, U + "x", U[:-1], U.replace("-", ""), "\U0001f600", "\ud800",
    "pid:[4026531836]", "pid:[1]", " pid:[1]\n", "pid:[]", "pid:[x]", "net:[1]", "pid:[" + "9" * 20 + "]", "pid:[" + "9" * 21 + "]", "pid:[1]\n\n", "PID:[1]",
    f"{U}/pid:[1]", f"mac:{U}", "x" * 10_000,
]


def test_parse_linux_boot_matches_v9():
    calls = [[a, b] for a in (U, f"{U}\n", U.upper(), "garbage", "") for b in ("pid:[4026531836]", " pid:[1]\n", "net:[1]", "pid:[x]", "", " pid:[1]﻿")]
    calls += [[t, "pid:[1]"] for t in TEXTS] + [[U, t] for t in TEXTS]
    diff_cases("review/boot-id", "parseLinuxBoot", parse_linux_boot, calls)


def test_parse_mac_boot_matches_v9():
    diff_cases("review/boot-id", "parseMacBoot", parse_mac_boot, [[t] for t in TEXTS])


def test_is_boot_id_matches_v9_including_non_strings():
    values = [*TEXTS, f"{U}/pid:[4026531836]", "a b", "x" * 128, "x" * 129, "a/b:c_d.e-f[g]", "é", "ab\n", 5, None, True, [], {}, 1.5, " "]
    diff_cases("review/boot-id", "isBootId", is_boot_id, [[t] for t in values])


def test_the_real_boot_identity_matches_v9_on_this_machine():
    assert v9("review/boot-id", "readBootId") == read_boot_id()
    assert v9("review/boot-id", "bootId") == boot_id()
    assert SYSCTL_PATH == "/usr/sbin/sysctl"
    if sys.platform in ("darwin", "linux"):
        assert boot_id() is not None


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS sysctl")
def test_a_fake_sysctl_on_path_changes_neither_side(tmp_path):
    fake = tmp_path / "sysctl"
    fake.write_text("#!/bin/sh\necho dddddddd-dddd-4ddd-8ddd-dddddddddddd\n")
    fake.chmod(0o755)
    env = {"PATH": f"{tmp_path}:{os.environ.get('PATH', '')}"}
    assert v9("review/boot-id", "bootId", env=env) == boot_id()
