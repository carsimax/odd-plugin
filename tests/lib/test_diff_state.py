"""Differential: state files written/read through v9 `dist/lib/state.js` and through Python are byte-identical."""
import json
import tempfile
from pathlib import Path

from odd_claude.lib.js import js_stringify
from odd_claude.lib.state import StateOptions, read_plugin_state, read_session_state, write_plugin_state, write_session_state

from .v9_oracle import needs_v9, v9

pytestmark = needs_v9

DATA = [
    {}, {"a": 1}, {"p": "/\ud800.jsonl"}, {"\ud800": "\udfff"}, {"k": "\U0001f600\ud83d"}, {"x": 1e-7}, {"x": 1e-6}, {"x": 1e15}, {"x": 1e21}, {"x": 1e20}, {"x": 2.0},
    {"x": 1.5}, {"x": -0.0}, {"x": 123e-20}, {"x": 2**53}, {"x": 2**53 + 1}, {"x": 12345678901234567890}, {"x": 0.1 + 0.2}, {"x": 5e-324},
    {"b": 1, "10": 2, "2": 3, "a": 4, "01": 5, "4294967295": 6, "4294967294": 7}, {"o": {"z": 1, "1": [{"9": 0, "8": 1}]}}, {"s": "\x01\x1f\x7f \"\\\n"},
    {"l": [1.0, None, True, "", [], {}]},
]
SIDS = ["s1", "\ud800", "a\ud800b", "\U0001f600", ""]


def _files(d: str) -> dict[str, bytes]:
    return {str(f.relative_to(d)): f.read_bytes() for f in sorted(Path(d).rglob("*")) if f.is_file()}


def test_writes_are_byte_identical():
    for data in DATA:
        for sid in SIDS:
            with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
                v9("state", "writeSessionState", sid, data, {"dataDir": dj})
                write_session_state(sid, data, StateOptions(data_dir=dp))
                v9("state", "writePluginState", sid, data, {"dataDir": dj})
                write_plugin_state(sid, data, StateOptions(data_dir=dp))
                assert _files(dj) == _files(dp), (data, sid)


RAW = [
    '{"version":1,"sessionId":"s","data":{"n":9007199254740993}}', '{"version":1,"data":{"n":[-9007199254740993, 9007199254740991, 1.0, 1e400]}}',
    '{"version":1,"data":{"b":1,"2":2,"1":3}}', '{"version":1.0,"data":{"x":-0}}', '{"version":1,"data":{"k":"\\ud800"}}',
]


def test_reads_match():
    for raw in RAW:
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "sessions").mkdir()
            (Path(d) / "sessions" / "s.json").write_text(raw)
            (Path(d) / "p.json").write_text(raw)
            o = StateOptions(data_dir=d)
            for fn, py, name in (("readSessionState", read_session_state, "s"), ("readPluginState", read_plugin_state, "p")):
                assert json.loads(js_stringify(py(name, o))) == v9("state", fn, name, {"dataDir": d}), (raw, fn)
