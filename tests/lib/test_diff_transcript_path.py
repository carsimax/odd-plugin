"""Differential test: Python lib/transcript_path.py against the compiled v9 lib/transcript-path.js on the same inputs and state."""
import tempfile
from pathlib import Path

from odd_claude.lib import transcript_path as tp
from odd_claude.lib.state import StateOptions

from .v9_oracle import needs_v9, v9_many

pytestmark = needs_v9


def _pad(units_astral: int, extra_a: int) -> str:
    return "/" + "a" * extra_a + "\U0001f600" * units_astral + ".jsonl"


PATHS = [
    "/a/b.jsonl", "/a/b.JSONL", "/a/b.jsonl ", "a/b.jsonl", "./a.jsonl", "", "/", "/.jsonl", ".jsonl", "/a.jsonl\n", "/a\x00b.jsonl", "/a\x1fb.jsonl", "/a\x7fb.jsonl",
    "/a\x80b.jsonl", "/\U0001f600.jsonl", "/\ud800.jsonl", "/\u00a0.jsonl", "/\ufeff.jsonl", "/\u2028.jsonl", "//a.jsonl", "/a//b.jsonl", "\\a\\b.jsonl", "C:\\a.jsonl",
    "/" + "a" * 4089 + ".jsonl", "/" + "a" * 4090 + ".jsonl", "/" + "a" * 4091 + ".jsonl", "/" + "a" * 4095 + ".jsonl",
    _pad(2000, 89), _pad(2000, 90), _pad(2000, 88), _pad(2044, 0), _pad(2100, 0), _pad(2047, 0), _pad(2048, 0), "/" + "a" * 4089 + ".jsonl"[:-1],
    None, 5, True, [], ["/a.jsonl"], {"p": "/a.jsonl"},
]


def test_valid_path():
    assert v9_many("transcript-path", "validPath", [[p] for p in PATHS]) == [tp.valid_path(p) for p in PATHS]


def snap(d: str) -> dict:
    return {str(f.relative_to(d)): f.read_bytes() for f in sorted(Path(d).rglob("*")) if f.is_file()}


INPUTS = [
    {"session_id": "s1", "transcript_path": "/a/b.jsonl"}, {"session_id": "s1"}, {"transcript_path": "/a/b.jsonl"}, {"session_id": "", "transcript_path": "/a/b.jsonl"},
    {"session_id": 5, "transcript_path": "/a/b.jsonl"}, {"session_id": ["s"], "transcript_path": "/a/b.jsonl"}, {"session_id": "s1", "transcript_path": "rel.jsonl"},
    {"session_id": "s/../x", "transcript_path": "/a/b.jsonl"}, {"session_id": "\U0001f600", "transcript_path": "/\U0001f600.jsonl"},
    {"session_id": "s1", "transcript_path": _pad(2100, 0)}, {"session_id": "s1", "transcript_path": _pad(2000, 89)}, {"session_id": "s1", "transcript_path": None},
    {"session_id": "s1", "transcript_path": "/a\nb.jsonl"}, {"session_id": "s1", "transcript_path": "/\u00e9.jsonl", "extra": 1}, {"session_id": " ", "transcript_path": "/a.jsonl"},
    {"session_id": "x" * 200, "transcript_path": "/a.jsonl"}, {},
]
# Skipped on purpose: a lone surrogate in persisted state. v9 JSON.stringify writes it as a "\ud800" escape, state.py's ensure_ascii=False dump cannot encode it (state.py is not this unit's file; reported to the parent).


def test_record_transcript_path_writes_the_same_state_bytes():
    for inp in INPUTS:
        with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
            rj = v9_many("transcript-path", "recordTranscriptPath", [[inp, {"dataDir": dj}]])
            assert tp.record_transcript_path(inp, StateOptions(data_dir=dp)) is None
            assert rj == [None] and snap(dj) == snap(dp), inp


def test_record_transcript_path_twice_and_over_existing_state():
    seeds = ['{"version":1,"sessionId":"s1","data":{"transcriptPath":"/a/b.jsonl","k":1}}', '{"version":1,"sessionId":"s1","data":{"transcriptPath":"/old.jsonl","k":[1,2]}}', "garbage", '{"version":2,"sessionId":"s1","data":{"x":1}}']
    for seed in seeds:
        with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
            for d in (dj, dp):
                Path(d, "sessions").mkdir()
                Path(d, "sessions", "s1.json").write_text(seed)
            inp = {"session_id": "s1", "transcript_path": "/a/b.jsonl"}
            v9_many("transcript-path", "recordTranscriptPath", [[inp, {"dataDir": dj}], [inp, {"dataDir": dj}]])
            tp.record_transcript_path(inp, StateOptions(data_dir=dp))
            tp.record_transcript_path(inp, StateOptions(data_dir=dp))
            assert snap(dj) == snap(dp), seed
