"""Differential test: Python lib/context_backstop.py against the compiled v9 lib/context-backstop.js on the same inputs, transcripts and state."""
import json
import tempfile
from pathlib import Path

from odd_claude.lib import context_backstop as cb
from odd_claude.lib.state import StateOptions

from .v9_oracle import needs_v9, v9_many

pytestmark = needs_v9

ENV = cb.CONTEXT_BACKSTOP_TOKENS_ENV
RAW = [
    "", " ", "  1000  ", "1000", "1e3", "1E3", "0x10", "0X1f", "0b11", "0o17", "-0x10", "+5", "-5", "0", "-0", ".5", "5.", "1_000", "1,000", "abc", "Infinity", "-Infinity", "+Infinity",
    "NaN", "nan", "inf", "infinity", "1e999", "1e21", "1e-7", "0.1", "150000", "150000.5", "99999999999999999999", "﻿200﻿", " 300 ", " 400 ", "\u0085500", "\x1c600",
    "１２", "١٢", "12abc", "1 2", "0x", "00012", "1e", "e5", "0b2", "0o8", "1.5e3", "١٢", "\U0001f600", "9" * 400, "5\n", "\t7\t",
]


def test_context_backstop_threshold():
    envs = [{ENV: r} for r in RAW] + [{}, {"OTHER": "5"}]
    expect = [cb.context_backstop_threshold(e) for e in envs]
    assert v9_many("context-backstop", "contextBackstopThreshold", [[e] for e in envs]) == expect


def test_context_backstop_notice():
    toks = [0, 1, 999, 1000, 150000, 150000.4, 150000.5, 150000.6, 1234567.5, 1e15, 2**53, 1e20, 1e21, -1, -2.5, -0.5, 0.5, 1.5, 2.5, 999999.5]
    calls = [[a, b, f] for a in toks for b in (150000, 1, 0.5, 2.5, 1e6, 123456789) for f in (True, False)]
    assert v9_many("context-backstop", "contextBackstopNotice", calls) == [cb.context_backstop_notice(*c) for c in calls]


def usage(i=0, c=0, r=0, **extra):
    return json.dumps({"type": "assistant", "message": {"usage": {"input_tokens": i, "cache_creation_input_tokens": c, "cache_read_input_tokens": r, **extra}}})


TRANSCRIPTS = [
    "", usage(1000) + "\n", usage(200000) + "\n", usage(100000, 40000, 20000) + "\n", usage(1, 0, 149999) + "\n", usage(0, 0, 150000) + "\n", usage(0) + "\n",
    usage(200000) + "\n" + usage(10) + "\n", usage(10) + "\n" + usage(200000) + "\n", usage(10) + "\n" + usage(200000) + "\nnot json\n" + '{"usage":' + "\n", usage(200000) + "\r\n" + usage(5) + "\r\n",
    "﻿" + usage(200000) + "\n", usage(200000), usage(1.5, 0.5, 149998) + "\n", usage(150000.5) + "\n", usage(-5, 0, 200000) + "\n", usage("150000") + "\n", usage(None, True, 200000) + "\n",
    '{"message":{"usage":null}}\n', '{"message":{"usage":5}}\n', '{"message":{"usage":[1]}}\n', '{"message":5,"usage":1}\n', '{"message":"usage"}\n', '{"x":"usage"}\n', "[1,\"usage\"]\n", "null \"usage\"\n",
    '{"message":{"usage":{"input_tokens":NaN}}}\n' + usage(160000) + "\n", '{"message":{"usage":{"input_tokens":Infinity}}}\n', '{"message":{"usage":{"input_tokens":1e999}}}\n',
    '{"message":{"usage":{"input_tokens":200000,"input_tokens":5}}}\n', '{"message":{"usage":{"input_tokens":9007199254740993,"cache_read_input_tokens":1}}}\n',
    '{"message":{"usage":{"input_tokens":1e400,"cache_read_input_tokens":200000}}}\n', usage(160000, name="\U0001f600") + "\n", usage(160000) + "\n" + "x" * 600_000 + "\n",
    usage(160000) + "\n" + "x" * 40_000 + "\n", usage(160000) + "\n" + "\U0001f600" * 20_000 + "\n", usage(10) + "\n" + usage(160000) + "\n" + "y" * 33_000,
]
STATES = [None, {}, {"contextBackstop": True}, {"contextBackstop": False}, {"contextBackstop": "true", "other": [1, {"a": None}]}, {"keep": 1}]


def snap(d: str) -> dict:
    return {str(f.relative_to(d)): f.read_bytes() for f in sorted(Path(d).rglob("*")) if f.is_file()}


def check(state, env, full, path):
    with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
        if state is not None:
            for d in (dj, dp):
                Path(d, "sessions").mkdir()
                Path(d, "sessions", "s1.json").write_text(json.dumps({"version": 1, "sessionId": "s1", "data": state}, indent=2) + "\n")
        rj = v9_many("context-backstop", "checkContextBackstop", [["s1", path, full, env, {"dataDir": dj}]])[0]
        rp = cb.check_context_backstop("s1", path, full, env, StateOptions(data_dir=dp))
        assert rj == rp and snap(dj) == snap(dp), (state, env, full, path if not isinstance(path, str) else path[-12:])


def test_check_context_backstop_result_and_state_bytes():
    with tempfile.TemporaryDirectory() as tmp:
        for i, body in enumerate(TRANSCRIPTS):
            f = Path(tmp, f"t{i}.jsonl")
            f.write_text(body, encoding="utf-8", newline="")
            for k, state in enumerate(STATES):
                for env in ({}, {ENV: "1000"}) if k < 3 else ({ENV: "250000"},):
                    check(state, env, (i + k) % 2 == 0, str(f))
        for path in (tmp, str(Path(tmp, "missing.jsonl")), "", None, 5, "relative.jsonl"):
            for state in (None, {"contextBackstop": True}):
                check(state, {}, True, path)
        for env in ({ENV: "abc"}, {ENV: "0x10"}, {ENV: "1e3"}):
            check(None, env, False, str(Path(tmp, "t3.jsonl")))
