"""Differential test: Python lib/context.py against the compiled v9 lib/context.js."""
import tempfile
from pathlib import Path

from odd_claude.lib import context as c
from odd_claude.lib.state import StateOptions

from .v9_oracle import needs_v9, v9, v9_many

pytestmark = needs_v9

SEEDS = [
    None, "", "{", "null", "[]", '{"version":1,"data":{"mode":"organic"}}', '{"version":1,"data":{"mode":"full"}}',
    '{"version":1,"data":{"mode":"Full"}}', '{"version":1,"data":{"mode":["full"]}}', '{"version":1,"data":{"mode":1}}', '{"version":2,"data":{"mode":"organic"}}',
    '{"version":1,"data":{"mode":"organic "}}', '{"version":1,"data":[]}', '{"version":1,"data":{}}',
]
MODES = [
    "organic", "full", "", "Full", " full", "full ", "\U0001f600", " ", "﻿", " ", "\ud800", "x\ud83d", '"', "\\", "\x01\x7f",
    "x" * 5000, None, 1, True, ["full"], {"a": 1},
]
WS = [" ", "\t", "\n", "\r", "\v", "\f", " ", " ", " ", " ", " ", " ", " ", " ", "　", "﻿",
      "\x1c", "\x1d", "\x1e", "\x1f", "\x85", "᠎", "​", "⁠", "\u0085"]
PROMPTS = [
    "hello", "", " ", "   hola   mundo  ", "/slash", " /slash", "!bang", "  !bang", "a/b", "x\ty\nz", "\U0001f600 hi", "\U0001f600" * 100, "\U0001f600" * 51,
    "a" * 99, "a" * 100, "a" * 101, "a" * 5000, "é" * 101, "\ud800", "a\ud800b", "a" * 99 + "\U0001f600", "a" * 98 + "\U0001f600", "a" * 100 + "\U0001f600",
    "a" * 99 + "\U0001f600" + "bc", "﻿", "﻿hi", "hi﻿", "﻿/x", " /x", "​", "​hi", "\u0085hi\u0085", "\x1chi\x1d",
    *[f"{w}hi{w}there{w}" for w in WS], *[f"{w}" for w in WS], *[f"{w}/cmd" for w in WS], *[f"{w}!cmd" for w in WS],
    "a" + " " * 200 + "b", "x " * 80, '"quoted"', "line1\r\nline2", "  ", "é" * 60, "😀", "a" * 99 + "\ud83d",
    None, 1, True, ["a"], {"a": "b"},
]


def snap(d: str) -> dict:
    return {str(f.relative_to(d)): f.read_bytes() for f in sorted(Path(d).rglob("*")) if f.is_file()}


def test_read_delegation_mode_over_seeded_state():
    for raw in SEEDS:
        with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
            for d in (dj, dp):
                if raw is not None:
                    Path(d, "delegation.json").write_text(raw, encoding="utf-8")
            assert v9("context", "readDelegationMode", {"dataDir": dj}) == c.read_delegation_mode(StateOptions(data_dir=dp)), raw
    assert v9("context", "readDelegationMode", {"dataDir": "rel"}) == c.read_delegation_mode(StateOptions(data_dir="rel"))


def test_write_delegation_mode_results_errors_and_files():
    for raw in (None, SEEDS[5], "{"):
        for mode in MODES:
            with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
                for d in (dj, dp):
                    if raw is not None:
                        Path(d, "delegation.json").write_text(raw, encoding="utf-8")
                rj = v9("context", "writeDelegationMode", mode, {"dataDir": dj})
                try:
                    rp = c.write_delegation_mode(mode, StateOptions(data_dir=dp))
                except Exception as ex:  # noqa: BLE001
                    rp = {"__error__": str(ex)}
                assert rj == rp, mode
                assert snap(dj) == snap(dp), mode


def test_build_session_context():
    cases = []
    for mode in ("full", "organic", "", "x"):
        for bg in (None, "on", "off", "", "x"):
            for extra in (None, [], ["a"], ["a", "", "b"], ["", ""], ["\U0001f600", "\ud800", " "]):
                cases.append((mode, bg, extra))
    js_in = []
    for mode, bg, extra in cases:
        i = {"delegationMode": mode}
        if bg is not None:
            i["backgroundSubagents"] = bg
        if extra is not None:
            i["extraLines"] = extra
        js_in.append([i])
    got = v9_many("context", "buildSessionContext", js_in)
    for (mode, bg, extra), g in zip(cases, got):
        py = c.build_session_context(c.SessionContextInput(mode, bg, extra if extra is not None else []))
        assert g == py, (mode, bg, extra)


def test_build_prompt_anchor_ordinary_and_unicode():
    got = v9_many("context", "buildPromptAnchor", [[p] for p in PROMPTS])
    for p, g in zip(PROMPTS, got):
        assert g == c.build_prompt_anchor(p), repr(p)
