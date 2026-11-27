# v9 has no exploration-budget spec; these cases pin the documented behavior (thresholds, counting, once-per-turn notice).
import pytest

from odd_claude.lib.exploration_budget import (
    EXPLORATION_MAX_BYTES,
    EXPLORATION_MAX_LOOKUPS,
    exploration_notice,
    is_exploration_tool,
    record_exploration,
    reset_exploration,
    response_text_bytes,
)
from odd_claude.lib.state import read_session_state, write_session_state


def test_thresholds_are_the_upstream_ones():
    assert (EXPLORATION_MAX_LOOKUPS, EXPLORATION_MAX_BYTES) == (3, 40_000)


def test_tool_names():
    for n in ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "mcp__codegraph__codegraph_explore"]:
        assert is_exploration_tool(n)
    for n in ["Edit", "Bash", "read", "mcp__engram__mem_save", "x__mcp__codegraph__y"]:
        assert not is_exploration_tool(n)


def test_response_text_bytes_counts_utf8_text_and_skips_type_and_non_strings():
    assert response_text_bytes("héllo") == 6
    assert response_text_bytes({"type": "text", "text": "ab", "n": 5, "ok": True, "x": None}) == 2
    assert response_text_bytes([{"type": "text", "text": "abc"}, {"content": ["de", {"a": "f"}]}]) == 6
    assert response_text_bytes(None) == 0 and response_text_bytes(7) == 0
    deep: object = "zz"
    for _ in range(10):
        deep = {"a": deep}
    assert response_text_bytes(deep) == 0, "depth beyond 8 is not counted"
    shallow: object = "zz"
    for _ in range(8):
        shallow = {"a": shallow}
    assert response_text_bytes(shallow) == 2


def test_notice_text_formats_thousands_and_is_advisory():
    n = exploration_notice(4, 41_234)
    assert n.startswith("Exploration budget: 4 tracked lookups and 41,234 UTF-8 text bytes (an approximate evidence budget).")
    assert "it blocks nothing and grants no mutation authority." in n


def test_the_fourth_lookup_notifies_once_and_state_keeps_counting(opts):
    for i in range(3):
        assert record_exploration("s", "x", True, opts) is None, i
    notice = record_exploration("s", "x", True, opts)
    assert notice and "4 tracked lookups and 4 UTF-8 text bytes" in notice
    assert record_exploration("s", "x", True, opts) is None, "once per turn"
    assert read_session_state("s", opts)["exploration"] == {"lookups": 5, "bytes": 5, "notified": True}


def test_the_byte_threshold_notifies_and_notify_false_only_counts(opts):
    assert record_exploration("s", "x" * 40_000, True, opts) is None
    assert "2 tracked lookups" in record_exploration("s", "y", True, opts)
    assert record_exploration("q", "x" * 50_000, False, opts) is None
    assert read_session_state("q", opts)["exploration"] == {"lookups": 1, "bytes": 50_000, "notified": False}


def test_reset_clears_the_counters_and_keeps_other_keys(opts):
    write_session_state("s", {"keep": "me"}, opts)
    for _ in range(4):
        record_exploration("s", "x", True, opts)
    reset_exploration("s", opts)
    assert read_session_state("s", opts) == {"keep": "me", "exploration": {"lookups": 0, "bytes": 0, "notified": False}}
    assert record_exploration("s", "x", True, opts) is None


def test_tampered_counters_read_as_zero(opts):
    write_session_state("s", {"exploration": {"lookups": "many", "bytes": True, "notified": "yes"}}, opts)
    assert record_exploration("s", "ab", True, opts) is None
    assert read_session_state("s", opts)["exploration"] == {"lookups": 1, "bytes": 2, "notified": False}


def test_a_state_of_another_schema_version_raises_and_is_left_alone(opts):
    from odd_claude.lib.state import session_state_path

    write_session_state("s", {}, opts)
    p = session_state_path("s", opts)
    other = '{"version": 2, "sessionId": "s", "data": {}}'
    open(p, "w").write(other)
    with pytest.raises(ValueError):
        record_exploration("s", "x", True, opts)
    assert open(p).read() == other
