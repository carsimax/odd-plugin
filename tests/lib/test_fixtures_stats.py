"""S2: the stats and retro output schemas of the Phase 1 fixtures, byte-identical from the Python computations."""
import shutil

from odd_claude.lib.retro import collect_retro, retro_json
from odd_claude.lib.state import StateOptions, update_session_state
from odd_claude.lib.stats import StatsView, collect_transcript_stats, read_exploration, read_transcript_path, record_transcript_path, stats_json
from odd_claude.lib.subagents import read_subagents

from .conftest import FIXTURES, fixture_text

SID = "sess-contract-0001"  # the session id capture.mjs uses; it is part of the fixture value


def _transcript(tmp_path):
    # capture.mjs runs the CLIs on a copy of this file at an absolute path ending in .jsonl
    p = tmp_path / "transcript.jsonl"
    shutil.copyfile(FIXTURES / "output-schemas" / "transcript.jsonl", p)
    return str(p)


def test_retro_json_is_byte_identical_to_the_fixture(tmp_path):
    d = collect_retro(_transcript(tmp_path))
    assert retro_json(d) + "\n" == fixture_text("output-schemas/retro.json")


def test_stats_json_is_byte_identical_to_the_fixture(tmp_path):
    opts = StateOptions(data_dir=str(tmp_path / "data"))
    path = _transcript(tmp_path)
    record_transcript_path({"session_id": SID, "transcript_path": path}, opts)  # what UserPromptSubmit does
    update_session_state(SID, lambda s: {**s, "exploration": {"lookups": 0, "bytes": 0}}, opts)  # and its turn reset
    p = read_transcript_path(SID, opts)
    view = StatsView(collect_transcript_stats(p), read_subagents(SID, opts), read_exploration(SID, opts))
    assert stats_json(SID, view) + "\n" == fixture_text("output-schemas/stats.json")
