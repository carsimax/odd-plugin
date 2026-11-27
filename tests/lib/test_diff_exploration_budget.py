"""Differential test: Python lib/exploration_budget.py against the compiled v9 lib/exploration-budget.js."""
import json
import tempfile
from pathlib import Path

from odd_claude.lib import exploration_budget as e
from odd_claude.lib.state import StateOptions

from .v9_oracle import needs_v9, v9, v9_many

pytestmark = needs_v9

NAMES = [
    "Read", "Grep", "Glob", "WebFetch", "WebSearch", "Bash", "Edit", "read", "READ", "Read ", " Read", "", "mcp__codegraph__codegraph_explore", "mcp__codegraph__", "mcp__codegraph",
    "xmcp__codegraph__a", "mcp__codegraph_x", "MCP__CODEGRAPH__a", "mcp__engram__mem_save", "mcp__codegraph__\U0001f600", "\U0001f600", "\ud800", "﻿Read", "Read ",
    "mcp__codegraph__a\nb", "\nmcp__codegraph__a", "constructor", "__proto__", "toString", "x" * 5000, "Glob ",
]
ASTRAL = "\U0001f600"
DEEP = {"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": {"i": "x" * 5, "j": ["yy"]}}}}}}}}}
RESPONSES = [
    "", "abc", "é", "€", ASTRAL, ASTRAL * 100, "\ud800", "a\ud800b", "\udc00", "\ud83d", " ﻿ ", "x" * 40_001, "é" * 20_001, "€" * 13_334,
    None, 0, 5, True, False, 1.5, [], {}, ["a", "b"], ["a", ["b", ["c"]]], {"type": "text", "text": "hello"}, {"type": "text", "text": ASTRAL}, {"type": "file", "file": {"type": "x", "content": "abc"}},
    {"content": [{"type": "text", "text": "abc"}, {"type": "image", "source": {"type": "base64", "data": "AAAA"}}]},
    {"kéy": "v", "\U0001f600": "w"}, {"type": {"type": "inner", "z": "zz"}}, {"type": "ignored", "type2": "counted"}, {"nested": {"type": "t", "text": "x"}},
    [None, 1, "s", [None]], {"a": None, "b": [1, 2, "three"]},
    DEEP, {"l0": {"l1": {"l2": {"l3": {"l4": {"l5": {"l6": {"l7": {"l8": "deep", "n": "x"}}}}}}}}},
    {"l0": {"l1": {"l2": {"l3": {"l4": {"l5": {"l6": {"l7": {"l8": {"l9": "too deep"}}}}}}}}}},
    [[[[[[[[["nine"]]]]]]]]], [[[[[[[[["ten", "x"]]]]]]]]], [[[[[[[[[["eleven"]]]]]]]]]],
    {"a": "x" * 10_000, "b": "y" * 30_001}, {"type": "text", "text": "x" * 40_000}, {"type": "text", "text": "x" * 39_999}, {"type": "text", "text": "x" * 40_001},
]
NUMS = [0, 1, 2, 3, 4, 999, 1000, 1234, 12345, 1234567, 40_000, 40_001, 2**31, 2**53, -1, -1234, 0.5, 1234.5678, 1234.5, 0.0001, 1.0005, 999999.9996, 1e21, 1e-7, 123456789.123456789, -0.5]


def snap(d: str) -> dict:
    return {str(f.relative_to(d)): f.read_bytes() for f in sorted(Path(d).rglob("*")) if f.is_file()}


def test_is_exploration_tool():
    assert v9_many("exploration-budget", "isExplorationTool", [[n] for n in NAMES]) == [e.is_exploration_tool(n) for n in NAMES]


def test_response_text_bytes():
    got = v9_many("exploration-budget", "responseTextBytes", [[r] for r in RESPONSES])
    for r, g in zip(RESPONSES, got):
        assert g == e.response_text_bytes(r), repr(r)[:80]
    # explicit depth argument
    for d in (0, 1, 8, 9, 100):
        for r in (DEEP, "abc", ["a", ["b"]]):
            assert v9("exploration-budget", "responseTextBytes", r, d) == e.response_text_bytes(r, d), (d, r)


def test_exploration_notice_number_formatting():
    calls = [[a, b] for a in NUMS for b in NUMS[:12] + [0.5, 1234.5678, 1e21]]
    got = v9_many("exploration-budget", "explorationNotice", calls)
    for c, g in zip(calls, got):
        assert g == e.exploration_notice(*c), c


def _seed(d: str, sid: str, expl) -> None:
    Path(d, "sessions").mkdir()
    Path(d, "sessions", f"{sid}.json").write_text(json.dumps({"version": 1, "sessionId": sid, "data": {"keep": "k", **({} if expl is ... else {"exploration": expl})}}))


SEED_STATES = [
    ..., None, {}, [], 5, "x", {"lookups": 2, "bytes": 100, "notified": False}, {"lookups": 3, "bytes": 0, "notified": False}, {"lookups": 2, "bytes": 39_999, "notified": False},
    {"lookups": 0, "bytes": 40_000, "notified": False}, {"lookups": 9, "bytes": 99_999, "notified": True}, {"lookups": 9, "bytes": 99_999, "notified": "true"},
    {"lookups": "3", "bytes": "x", "notified": 1}, {"lookups": None, "bytes": [], "notified": None}, {"lookups": True, "bytes": False}, {"lookups": 2.5, "bytes": 0.5},
    {"lookups": -5, "bytes": -100}, {"lookups": 1e21, "bytes": 0.5}, {"lookups": 2**53, "bytes": 2**53}, {"lookups": 12345678901234567890, "bytes": 1}, {"lookups": 1.0, "bytes": 2.0}, {"lookups": 1e-7, "bytes": 1e-7}, {"lookups": 1, "bytes": 1e-7, "extra": 1e-7},
    {"lookups": 1, "bytes": 1, "notified": False, "extra": [1, 2]},
]


def test_record_exploration_results_and_files():
    for expl in SEED_STATES:
        for resp in ("abc", {"type": "text", "text": "x" * 40_001}, ASTRAL, None, ["\ud800"]):
            for notify in (True, False):
                with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
                    _seed(dj, "s1", expl)
                    _seed(dp, "s1", expl)
                    rj = v9("exploration-budget", "recordExploration", "s1", resp, notify, {"dataDir": dj})
                    assert rj == e.record_exploration("s1", resp, notify, StateOptions(data_dir=dp)), (expl, notify)
                    assert snap(dj) == snap(dp), (expl, notify)


def test_record_exploration_fresh_state_over_a_turn_and_reset():
    with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
        oj, op = {"dataDir": dj}, StateOptions(data_dir=dp)
        for i in range(6):
            resp = "x" * (9000 if i == 4 else 10)
            assert v9("exploration-budget", "recordExploration", "s", resp, True, oj) == e.record_exploration("s", resp, True, op), i
            assert snap(dj) == snap(dp), i
        assert v9("exploration-budget", "resetExploration", "s", oj) == e.reset_exploration("s", op)
        assert snap(dj) == snap(dp)
        assert v9("exploration-budget", "recordExploration", "s", "x", True, oj) == e.record_exploration("s", "x", True, op)
        assert snap(dj) == snap(dp)


def test_reset_exploration_over_seeded_state_and_odd_session_ids():
    for expl in SEED_STATES:
        with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
            _seed(dj, "s1", expl)
            _seed(dp, "s1", expl)
            assert v9("exploration-budget", "resetExploration", "s1", {"dataDir": dj}) == e.reset_exploration("s1", StateOptions(data_dir=dp))
            assert snap(dj) == snap(dp), expl
    for sid in ("", ASTRAL, "\ud800", "a/b", "..", "x" * 300, " ", "a b", "﻿", " "):
        with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
            assert v9("exploration-budget", "resetExploration", sid, {"dataDir": dj}) == e.reset_exploration(sid, StateOptions(data_dir=dp)), sid
            assert snap(dj) == snap(dp), sid
            assert v9("exploration-budget", "recordExploration", sid, "abc", True, {"dataDir": dj}) == e.record_exploration(sid, "abc", True, StateOptions(data_dir=dp)), sid
            assert snap(dj) == snap(dp), sid
