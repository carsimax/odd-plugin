"""Differential test: Python lib/background_subagents.py against the compiled v9 lib/background-subagents.js."""
import tempfile
from pathlib import Path

from odd_claude.lib import background_subagents as b
from odd_claude.lib.state import StateOptions

from .v9_oracle import needs_v9, v9

pytestmark = needs_v9

SEEDS = [
    None, "", "{", "null", "[]", '{"version":1,"data":{"policy":"on"}}', '{"version":1,"data":{"policy":"off"}}',
    '{"version":1,"data":{"policy":"ON"}}', '{"version":1,"data":{"policy":"on "}}', '{"version":1,"data":{"policy":1}}',
    '{"version":1,"data":{}}', '{"version":2,"data":{"policy":"on"}}', '{"version":1,"data":[]}', '{"version":1,"data":{"policy":["on"]}}',
]
ENVS = [None, "on", "off", "", "ON", " on", "on\n", "\U0001f600", "﻿", "1", "true", " off"]
POLICIES = [
    "on", "off", "", "ON", " on", "on ", "\U0001f600", " ", "﻿", " ", "\ud800", "x\ud83d", '"', "\\", "\x01\x7f",
    "x" * 5000, None, 1, True, ["on"], {"a": "on"},
]


def snap(d: str) -> dict:
    return {str(f.relative_to(d)): f.read_bytes() for f in sorted(Path(d).rglob("*")) if f.is_file()}


def seeded(d: str, raw: str | None) -> None:
    if raw is not None:
        Path(d, "background-subagents.json").write_text(raw, encoding="utf-8")


def res(r):
    return {"policy": r.policy, "source": r.source, "malformed": r.malformed}


def env_for(d: str, e: str | None) -> dict:
    env = {"ODD_CLAUDE_DATA": d}
    if e is not None:
        env["ODD_CLAUDE_BACKGROUND_SUBAGENTS"] = e
    return env


def test_resolve_and_read_over_state_and_env():
    for raw in SEEDS:
        for e in ENVS:
            with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
                seeded(dj, raw)
                seeded(dp, raw)
                oj = {"dataDir": dj, "env": {} if e is None else {"ODD_CLAUDE_BACKGROUND_SUBAGENTS": e}}
                op = StateOptions(data_dir=dp, env={} if e is None else {"ODD_CLAUDE_BACKGROUND_SUBAGENTS": e})
                assert v9("background-subagents", "resolveBackgroundSubagents", oj) == res(b.resolve_background_subagents(op)), (raw, e)
                assert v9("background-subagents", "readBackgroundSubagents", oj) == b.read_background_subagents(op), (raw, e)


def test_resolve_through_env_data_dir_and_relative_dir():
    for raw in SEEDS[:6]:
        with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
            seeded(dj, raw)
            seeded(dp, raw)
            ej, ep = env_for(dj, "on"), env_for(dp, "on")
            assert v9("background-subagents", "resolveBackgroundSubagents", {"env": ej}) == res(b.resolve_background_subagents(StateOptions(env=ep)))
    # relative data dir: resolveDataDir throws, both fall through to env/default
    for e in ENVS:
        oj = {"dataDir": "rel/x", "env": {} if e is None else {"ODD_CLAUDE_BACKGROUND_SUBAGENTS": e}}
        op = StateOptions(data_dir="rel/x", env=oj["env"])
        assert v9("background-subagents", "resolveBackgroundSubagents", oj) == res(b.resolve_background_subagents(op)), e


def test_write_results_errors_and_files():
    for raw in (None, SEEDS[5], "{"):
        for pol in POLICIES:
            with tempfile.TemporaryDirectory() as dj, tempfile.TemporaryDirectory() as dp:
                seeded(dj, raw)
                seeded(dp, raw)
                rj = v9("background-subagents", "writeBackgroundSubagents", pol, {"dataDir": dj})
                try:
                    rp = b.write_background_subagents(pol, StateOptions(data_dir=dp))
                except Exception as ex:  # noqa: BLE001
                    rp = {"__error__": str(ex)}
                assert rj == rp, pol
                assert snap(dj) == snap(dp), pol


def test_background_subagents_line():
    for pol in ["on", "off", "", "ON", "x", "\U0001f600", "\ud800", None, 1]:
        assert v9("background-subagents", "backgroundSubagentsLine", pol) == b.background_subagents_line(pol), pol
