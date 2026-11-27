"""Smoke test for the v9 oracle helper (tests/lib/v9_oracle.py)."""
from odd_claude.lib import state

from .v9_oracle import needs_v9, v9, v9_many

pytestmark = needs_v9

SAMPLES = ["abc-DEF_1", "a/b c", "x" * 200, "", "\U0001f600a", " ﻿ ", "\ud800x"]


def test_v9_equals_python_on_ordinary_and_unicode_input():
    for s in SAMPLES:
        assert v9("state", "safeSegment", s) == state.safe_segment(s)


def test_v9_many_matches_single_calls():
    assert v9_many("state", "safeSegment", [[s] for s in SAMPLES]) == [state.safe_segment(s) for s in SAMPLES]


def test_thrown_error_comes_back_as_error_dict():
    r = v9("state", "safeSegment", None)
    assert set(r) == {"__error__"} and isinstance(r["__error__"], str) and r["__error__"]


def test_a_different_expected_value_is_detected():
    assert v9("state", "safeSegment", "a b") != "a b"
    assert v9("state", "safeSegment", "\U0001f600") != "_"
