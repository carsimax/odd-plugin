"""Differential test: Python lib/stats.py against the compiled v9 lib/stats.js on the same inputs, transcripts and state."""
import json
import re
import tempfile
from pathlib import Path

from odd_claude.lib import stats as st
from odd_claude.lib.state import StateOptions

from .v9_oracle import needs_v9, v9, v9_many

pytestmark = needs_v9

# Skipped on purpose: Date.parse's legacy (non-ISO) formats, which V8 accepts and Python has no equivalent for; null as a subagent
# timestamp; numbers that do not cross JSON (NaN, Infinity).


def js(obj):
    return json.loads(json.dumps(obj, default=lambda o: o.model_dump(by_alias=True, exclude_none=True)))


def line(ts=None, mid=None, model="claude-opus-4", i=0, o=0, cr=0, cw=0, type_="assistant", **extra):
    msg = {"usage": {"input_tokens": i, "output_tokens": o, "cache_read_input_tokens": cr, "cache_creation_input_tokens": cw}}
    if model is not None:
        msg["model"] = model
    if mid is not None:
        msg["id"] = mid
    e = {"type": type_, "message": msg, **extra}
    if ts is not None:
        e["timestamp"] = ts
    return json.dumps(e)


T0 = "2025-01-01T00:00:00.000Z"
TRANSCRIPTS = [
    "", "\n", line(T0, "m1", i=10, o=5) + "\n", line(T0, "m1", i=10, o=5) + "\n" + line("2025-01-01T00:00:05.250Z", "m1", i=20, o=9, cr=100, cw=7) + "\n",
    line(T0, "m1", i=1) + "\r\n" + line("2025-01-01T01:02:03Z", "m2", i=2, model="b") + "\r\n", "﻿" + line(T0, "m1", i=1) + "\n", line(T0, None, i=1) + "\n" + line(T0, "", i=2) + "\n",
    line(T0, "m1", model="<synthetic>", i=5) + "\n", line(T0, "m1", model=None, i=5) + "\n", line(T0, "m1", model="") + "\n", line(T0, "m1", model="  \x1b[31mx\x1b[0m  ") + "\n",
    line(T0, "m1", model="a" * 80, i=1) + "\n" + line(T0, "m2", model="a" * 81, i=1) + "\n" + line(T0, "m3", model="a" * 85 + "b", i=1) + "\n",
    line(T0, "m1", model="a" * 79 + "\U0001f600", i=1) + "\n" + line(T0, "m2", model="a" * 78 + "\U0001f600z", i=2) + "\n" + line(T0, "m3", model="a" * 80 + "\U0001f600", i=3) + "\n",
    line(T0, "m1", model="\U0001f600" * 41, i=1) + "\n" + line(T0, "m2", model="\U0001f600" * 40, i=1) + "\n" + line(T0, "m3", model="\ud800" * 3, i=1) + "\n" + line(T0, "m4", model="\U0001f600x", i=1) * 1 + "\n",
    "\n".join(line(T0, f"m{k}", model=f"model-{k}", i=k) for k in range(12)) + "\n", "\n".join(line(T0, f"m{k}", model=f"model-{k % 3}", i=100 - k, o=k) for k in range(12)) + "\n",
    "\n".join(line(T0, f"m{k}", model=f"m{k}", i=5) for k in range(10)) + "\n", "\n".join(line(T0, f"m{k}", model=f"m{k % 4}", i=5, o=0) for k in range(10)) + "\n",
    line(T0, "m1", i=1.5, o=0.25, cr=-5, cw=True) + "\n", line(T0, "m1", i="9", o=None) + "\n", line(T0, "m1", i=2**53 + 1, o=2**53 + 1, cr=3) + "\n", line(T0, "m1", i=9007199254740991, o=9007199254740991) + "\n",
    line(T0, "m1", i=0.1, o=0.2, cr=0.3) + "\n" + line(T0, "m2", i=0.1, o=0.2) + "\n", line(T0, "m1", i=1e300, o=1e300) + "\n", '{"type":"assistant","message":{"usage":{"input_tokens":1e999,"output_tokens":3}}}\n',
    '{"type":"assistant","message":{"usage":{"input_tokens":NaN}}}\n' + line(T0, "m1", i=4) + "\n", '{"type":"assistant","message":{"usage":[1,2]}}\n', '{"type":"assistant","message":{"usage":[]}}\n',
    '{"type":"assistant","message":{"usage":null}}\n', '{"type":"assistant","message":null,"usage":1}\n', '{"type":"user","message":{"usage":{"input_tokens":5}}}\n', '[1,"usage"]\n', "null\n", '"usage"\n',
    '{"timestamp":"2025-01-01T00:00:00Z"}\n{"timestamp":"2025-01-01T00:10:00Z"}\n', '{"timestamp":"2025-01-01T00:10:00Z"}\n{"timestamp":"2025-01-01T00:00:00Z"}\n', '{"timestamp":"2025-01-01T00:10:00Z"}\n',
    '{"timestamp":5}\n{"timestamp":"junk"}\n{"timestamp":""}\n{"timestamp":null}\n', "not json \"usage\"\n{\"usage\":\n" + line(T0, "m1", i=3) + "\n", line(T0, "m1", i=3) + "\ntruncated \"usage\" {",
    line(T0, "m1", i=3) + "\n" + "z" * (2 * 1024 * 1024 + 5) + '"usage"\n', line(T0, "m1", i=3, pad="x" * 2_000_000) + "\n", line(T0, "m1", i=3, pad="x" * (2_097_152 - 330)) + "\n",
    line(T0, "m1", i=3, pad="\U0001f600" * 1_048_000) + "\n", line(T0, "m1", i=3, pad="\U0001f600" * 1_050_000) + "\n", line(T0, "m1", i=3, pad="é" * 1_050_000) + "\n",
    "x" * 9_000_000 + "\n" + line(T0, "m1", i=3) + "\n", ("filler line\n" * 800_000) + line(T0, "m1", i=3) + "\n" + line("2025-01-01T00:00:09Z", "m2", i=4) + "\n",
]
ISO = [
    "2025-01-01T00:00:00Z", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.5Z", "2025-01-01T00:00:00.123456Z", "2025-01-01T00:00:00.1239Z", "2025-01-01T00:00:00+02:00", "2025-01-01T00:00:00-0530",
    "2025-01-01T00:00:00+0200", "2025-01-01", "2025-01", "2025", "2025-01-01T00:00", "2025-01-01T00:00:00", "2025-01-01T24:00:00Z", "2025-01-01T24:00:01Z", "2025-02-30T00:00:00Z", "2025-13-01T00:00:00Z",
    "2025-00-10T00:00:00Z", "2025-01-32T00:00:00Z", "2025-01-01T25:00:00Z", "2025-01-01T00:60:00Z", "2025-01-01T00:00:60Z", "+002025-01-01T00:00:00Z", "-000001-01-01T00:00:00Z", "-000000-01-01T00:00:00Z",
    "0000-01-01T00:00:00Z", "9999-12-31T23:59:59.999Z", "275760-09-13T00:00:00.000Z", "+275760-09-13T00:00:00.000Z", "+275760-09-13T00:00:00.001Z", "1970-01-01T00:00:00Z", "1969-12-31T23:59:59.999Z",
    "2025-01-01t00:00:00z", "2025-01-01 00:00:00Z", "2025-01-01T00:00:00 Z", " 2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z ", "2025-01-01T0:00:00Z", "2025-1-1T00:00:00Z", "2024-02-29T12:00:00Z",
    "2023-02-29T12:00:00Z", "2025-01-01T00:00:00,5Z", "２０２５-01-01T00:00:00Z", "2025-01-01T00:00:00.Z", "2025-01-01T00:00Z", "2025-01-01T00Z", "2025-01-01T00:00:00+24:00", "2025-01-01T00:00:00+00:60",
]


def test_valid_and_unreadable_dates_through_collect_transcript_stats():
    with tempfile.TemporaryDirectory() as tmp:
        for k, ts in enumerate(ISO):
            f = Path(tmp, f"d{k}.jsonl")
            f.write_text(line(T0, "m1", i=1) + "\n" + line(ts, "m2", i=2) + "\n", encoding="utf-8")
            assert v9("stats", "collectTranscriptStats", str(f)) == js(st.collect_transcript_stats(str(f))), ts


def test_collect_transcript_stats_on_transcripts():
    with tempfile.TemporaryDirectory() as tmp:
        for k, body in enumerate(TRANSCRIPTS):
            f = Path(tmp, f"t{k}.jsonl")
            f.write_text(body, encoding="utf-8", newline="")
            assert v9("stats", "collectTranscriptStats", str(f)) == js(st.collect_transcript_stats(str(f))), k
        missing = [str(Path(tmp, "nope")), tmp, "/dev/null", ""]
        assert v9_many("stats", "collectTranscriptStats", [[m] for m in missing]) == [js(st.collect_transcript_stats(m)) for m in missing]


def snap(d: str) -> dict:
    return {str(f.relative_to(d)): f.read_bytes() for f in sorted(Path(d).rglob("*")) if f.is_file()}


STATES = [
    None, {}, {"transcriptPath": "/a/b.jsonl"}, {"transcriptPath": "rel.jsonl"}, {"transcriptPath": 5}, {"transcriptPath": "/a\x01b.jsonl"}, {"transcriptPath": "/\U0001f600" * 2100 + ".jsonl"},
    {"exploration": {"lookups": 3, "bytes": 1200}}, {"exploration": {"lookups": 3}}, {"exploration": {"lookups": "3", "bytes": -1}}, {"exploration": {"lookups": 1.5, "bytes": 2**53 + 1}},
    {"exploration": [1]}, {"exploration": []}, {"exploration": "x"}, {"exploration": 5}, {"exploration": None}, {"exploration": {}}, {"exploration": {"lookups": 1e300, "bytes": 0.5}}, "garbage",
    '{"version":2,"sessionId":"s1","data":{"transcriptPath":"/a/b.jsonl"}}',
]


def seed(d, data):
    if data is not None:
        Path(d, "sessions").mkdir()
        Path(d, "sessions", "s1.json").write_text(data if isinstance(data, str) else json.dumps({"version": 1, "sessionId": "s1", "data": data}, indent=2) + "\n")


def test_read_transcript_path_and_read_exploration_over_seeded_state():
    for data in STATES:
        with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
            seed(dj, data)
            seed(dp, data)
            for sid in ("s1", "s2"):
                o = StateOptions(data_dir=dp)
                assert v9("stats", "readTranscriptPath", sid, {"dataDir": dj}) == st.read_transcript_path(sid, o), data
                assert v9("stats", "readExploration", sid, {"dataDir": dj}) == js(st.read_exploration(sid, o)), data


def test_record_transcript_path_is_re_exported_and_writes_the_same_bytes():
    for inp in [{"session_id": "s1", "transcript_path": "/a/b.jsonl"}, {"session_id": "s1", "transcript_path": "/a/b.txt"}, {"session_id": "", "transcript_path": "/a/b.jsonl"}]:
        with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
            v9("stats", "recordTranscriptPath", inp, {"dataDir": dj})
            st.record_transcript_path(inp, StateOptions(data_dir=dp))
            assert snap(dj) == snap(dp), inp


def tstats(**kw):
    base = {"turns": 3, "input": 100, "output": 50, "cacheRead": 900, "cacheWrite": 0, "spanMs": 0, "truncated": False, "bytesRead": 1000, "models": []}
    return {**base, **kw}


NUMS = [0, 1, 2, 7, 999, 1000, 1001, 1049, 1050, 1051, 1949, 1950, 9949, 9950, 99_949, 99_950, 999_499, 999_500, 999_949, 999_950, 999_999, 1_000_000, 1_004_999, 1_005_000, 1_005_001, 1_234_567, 1_995_000, 12_345_678, 1.5, 0.25, 999.9, 1500.5, 2**31, 10**9, 10**12, 10**15]
BYTES = [0, 1, 524_287, 524_288, 1_048_575, 1_048_576, 1_572_864, 5_033_164, 5_452_595, 8 * 1024 * 1024, 8_388_607, 123_456_789, 1_000_000]


def view(t, subs, expl, note=None):
    v = {"subagents": subs}  # an absent section is `undefined` in JS: omitted, not null
    if t is not None:
        v["transcript"] = t
    if expl is not None:
        v["exploration"] = expl
    if note is not None:
        v["note"] = note
    return v


def py_render(v):
    t = st.TranscriptStats.model_validate(v["transcript"]) if "transcript" in v else None
    e = st.Exploration.model_validate(v["exploration"]) if "exploration" in v else None
    return st.render_stats(st.StatsView(t, v["subagents"], e, v.get("note")))


def test_render_stats():
    views = [view(None, [], None), view(None, [], None, "custom note \U0001f600"), view(None, [], None, ""), view(None, [{"id": "a", "type": "t"}], {"lookups": 1, "bytes": 5}, "n")]
    for n in NUMS:
        views.append(view(tstats(input=n, output=n, cacheRead=n, cacheWrite=n, turns=int(n) if n == int(n) else 1, models=[{"model": "m\U0001f600", "turns": 1, "tokens": n}, {"model": "x", "turns": 2, "tokens": 0}]), [], None))
    for b in BYTES:
        views.append(view(tstats(truncated=True, bytesRead=b), [], None))
        views.append(view(tstats(truncated=False, bytesRead=b), [], None))
    for cr, i, cw in [(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 1, 1), (1, 2, 0), (1, 3, 0), (5, 3, 0), (1, 199, 0), (199, 1, 0), (1, 7, 0), (3, 5, 0), (1, 5, 6), (2, 1, 0), (0, 0, 1), (7, 1, 0), (1, 1, 5), (333, 667, 0), (5, 5, 0)]:
        views.append(view(tstats(input=i, cacheRead=cr, cacheWrite=cw), [], None))
    for span in [0, 1, 999, 1000, 59_999, 60_000, 3_599_999, 3_600_000, 90_061_000, -5]:
        views.append(view(tstats(spanMs=span), [], None))
    subs = [
        [], [{"id": "a", "type": "t"}], [{"id": "a", "type": "t", "startedAt": 1000}], [{"id": "a", "type": "t", "endedAt": 1000}], [{"id": "a", "type": "t", "startedAt": 1000, "endedAt": 4500}],
        [{"id": "a", "type": "t", "startedAt": 5000, "endedAt": 1000}], [{"id": "a", "type": "t", "startedAt": 0, "endedAt": 0}], [{"id": "a", "type": "t", "startedAt": 0, "endedAt": 3_725_000}, {"id": "b", "type": "t"}, {"id": "c", "type": "t", "startedAt": 1}],
        [{"id": "a", "type": "t", "startedAt": 1.5, "endedAt": 2000.7}], [{"id": str(i), "type": "t", "startedAt": 0, "endedAt": i * 1000} for i in range(30)],
    ]
    for s in subs:
        for e in (None, {"lookups": 0, "bytes": 0}, {"lookups": 1, "bytes": 1}, {"lookups": 2, "bytes": 123456}, {"lookups": 1.5, "bytes": 0.5}):
            views.append(view(None, s, e))
            views.append(view(tstats(), s, e))
    calls = [[v] for v in views]
    assert v9_many("stats", "renderStats", calls) == [py_render(v) for v in views]
