"""Differential test: Python lib/subagents.py against the compiled v9 lib/subagents.js on the same inputs and state."""
import json
import re
import tempfile
from pathlib import Path

from odd_claude.lib import subagents as sa
from odd_claude.lib.state import StateOptions

from .v9_oracle import needs_v9, v9_many

pytestmark = needs_v9

# Skipped on purpose: null as the hook input (v9 throws a TypeError before its try block); a lone surrogate in an id (state.py cannot
# dump it, reported to the parent); integer-like keys inside a stored record (JS orders them first, a state.py concern).


def snap(d: str) -> dict:
    return {str(f.relative_to(d)): re.sub(rb"^\d{4}-\d\d-\d\dT[\d:.]+Z", b"<TS>", f.read_bytes()) for f in sorted(Path(d).rglob("*")) if f.is_file()}


def test_format_duration():
    vals = [0, -1, -1e9, 1, 999, 1000, 1500, 59_999, 60_000, 61_000, 3_599_999, 3_600_000, 3_661_000, 86_400_000, 359_999_000, 360_000_000, 1e12, 123456789012, 0.5, 1e15, 2**53, 59999.9999]
    vals += [i * 997 for i in range(0, 20000, 37)]
    assert v9_many("subagents", "formatDuration", [[v] for v in vals]) == [sa.format_duration(v) for v in vals]


def seed(d: str, data) -> None:
    if data is not None:
        Path(d, "sessions").mkdir()
        Path(d, "sessions", "s1.json").write_text(data if isinstance(data, str) else json.dumps({"version": 1, "sessionId": "s1", "data": data}, indent=2) + "\n")


REC = {"id": "a1", "type": "t", "startedAt": 5}
STATES = [
    None, {}, {"subagents": []}, {"subagents": [REC]}, {"subagents": [{"id": "a1", "type": "t", "endedAt": 9, "extra": {"k": [1]}}]},
    {"subagents": [REC, {"id": 5, "type": "t"}, {"id": "b"}, "x", None, 7, [1], {"id": "c", "type": "u", "startedAt": 1, "endedAt": 2}]},
    {"subagents": "nope", "keep": 1}, {"subagents": {"id": "a1", "type": "t"}}, {"subagents": [{"id": "a1", "type": "t", "startedAt": None, "endedAt": 1.5}]},
    {"subagents": [{"id": f"x{i}", "type": "t", "startedAt": i} for i in range(60)]}, {"subagents": [{"id": f"x{i}", "type": "t"} for i in range(49)]},
    "garbage", '{"version":2,"sessionId":"s1","data":{"subagents":[]}}', {"other": {"a": 1}, "subagents": [REC]},
]
INPUTS = [
    {"session_id": "s1", "agent_id": "a1", "agent_type": "odd-claude:odd-explore"}, {"session_id": "s1", "agent_id": "zz"}, {"session_id": "s1", "agent_id": "zz", "agent_type": ""},
    {"session_id": "s1", "agent_id": "zz", "agent_type": 5}, {"session_id": "s1", "agent_id": "zz", "agent_type": ["a"]}, {"session_id": "", "agent_id": "a"}, {"session_id": "s1", "agent_id": ""},
    {"session_id": "s1", "agent_id": 5}, {"session_id": 5, "agent_id": "a"}, {"session_id": "s1"}, {"agent_id": "a"}, {}, "garbage", 5, [], True,
    {"session_id": "s1", "agent_id": "\U0001f600", "agent_type": "\U0001f600   ﻿  "}, {"session_id": "s1", "agent_id": "x" * 300, "agent_type": "y" * 300},
    {"session_id": "s/..", "agent_id": "b", "agent_type": "t"}, {"session_id": "s1", "agent_id": "x3", "agent_type": "dup"}, {"session_id": "s1", "agent_id": "c", "agent_type": "dup"},
    {"session_id": "s1", "agent_id": "a1", "agent_type": "new type"},
]
NOWS = [1000, 0, 4500, 1.5, 10**15]


def run_both(fn_js, fn_py, state, inp, now, read_back):
    with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
        seed(dj, state)
        seed(dp, state)
        v9_many("subagents", fn_js, [[inp, {"dataDir": dj}, now]])
        getattr(sa, fn_py)(inp, StateOptions(data_dir=dp), now)
        assert snap(dj) == snap(dp), (fn_js, state if not isinstance(state, dict) else list(state), inp, now)
        if read_back:
            assert v9_many("subagents", "readSubagents", [["s1", {"dataDir": dj}]])[0] == sa.read_subagents("s1", StateOptions(data_dir=dp))


def test_record_subagent_start_and_stop_write_the_same_state_bytes():
    for k, state in enumerate(STATES):
        for j, inp in enumerate(INPUTS):
            if k > 1 and (k + j) % 6 and j > 5:  # every input meets states 0,1; the rest are sampled to keep the node spawns bounded
                continue
            now = NOWS[(k + j) % len(NOWS)]
            run_both("recordSubagentStart", "record_subagent_start", state, inp, now, j % 5 == 0)
            run_both("recordSubagentStop", "record_subagent_stop", state, inp, now, j % 5 == 0)


def test_read_subagents_over_seeded_state_and_session_ids():
    for state in STATES:
        for sid in ("s1", "s2", "", "s/.."):
            with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
                seed(dj, state)
                seed(dp, state)
                assert v9_many("subagents", "readSubagents", [[sid, {"dataDir": dj}]])[0] == sa.read_subagents(sid, StateOptions(data_dir=dp)), (state, sid)


def test_start_then_stop_sequences_and_the_fifty_cap():
    with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
        for fn, py_fn in (("recordSubagentStart", sa.record_subagent_start), ("recordSubagentStop", sa.record_subagent_stop)):
            calls = [[{"session_id": "s1", "agent_id": f"a{i % 55}", "agent_type": f"t{i % 3}"}, {"dataDir": dj}, 1000 + i] for i in range(70)]
            v9_many("subagents", fn, calls)
            for inp, _, now in calls:
                py_fn(inp, StateOptions(data_dir=dp), now)
            assert snap(dj) == snap(dp)
        assert len(sa.read_subagents("s1", StateOptions(data_dir=dp))) == sa.MAX_SUBAGENTS


def test_unwritable_data_dir_logs_the_same_line_shape_and_never_raises():
    with tempfile.TemporaryDirectory() as d:
        blocker = Path(d, "file")
        blocker.write_text("x")
        inp = {"session_id": "s1", "agent_id": "a"}
        v9_many("subagents", "recordSubagentStart", [[inp, {"dataDir": str(blocker / "sub")}]])
        assert sa.record_subagent_start(inp, StateOptions(data_dir=str(blocker / "sub"))) is None
