import json
import os

from odd_claude.lib.state import update_session_state
from odd_claude.lib.stats import (
    STATS_TAIL_BYTES,
    StatsView,
    collect_transcript_stats,
    read_exploration,
    read_transcript_path,
    record_transcript_path,
    render_stats,
    stats_json,
)
from odd_claude.lib.subagents import record_subagent_start, record_subagent_stop


def asst(id, model, u, ts, **extra):
    return json.dumps({"type": "assistant", "timestamp": ts, "message": {"id": id, "model": model, "usage": u}, **extra})


FIXTURE = "\n".join(
    [
        json.dumps({"type": "user", "timestamp": "2026-11-18T10:00:00.000Z", "message": {"content": "hi"}}),
        # streamed duplicates of one message id: only the last usage counts
        asst("m1", "claude-sonnet-5-5", {"input_tokens": 10, "output_tokens": 1, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 5}, "2026-11-18T10:00:01.000Z"),
        asst("m1", "claude-sonnet-5-5", {"input_tokens": 10, "output_tokens": 40, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 5}, "2026-11-18T10:00:02.000Z"),
        asst("m2", "claude-haiku-5-5", {"input_tokens": 3, "output_tokens": 7, "cache_read_input_tokens": 50}, "2026-11-18T10:01:00.000Z"),
        asst("m3", "<synthetic>", {"input_tokens": 0, "output_tokens": 0}, "2026-11-18T10:01:30.000Z"),
        "not json at all",
        '{"usage": broken',
        "",
    ]
)


def test_collect_sums_tokens_dedups_by_message_id_skips_garbage_and_synthetic(tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text(FIXTURE)
    s = collect_transcript_stats(str(p))
    assert (s.turns, s.input, s.output, s.cacheRead, s.cacheWrite, s.spanMs, s.truncated) == (2, 13, 47, 150, 5, 90_000, False)
    assert [(m.model, m.turns) for m in s.models] == [("claude-sonnet-5-5", 1), ("claude-haiku-5-5", 1)]


def test_collect_missing_directory_and_empty_files_never_raise(tmp_path):
    assert collect_transcript_stats(str(tmp_path / "nope.jsonl")) is None
    assert collect_transcript_stats(str(tmp_path)) is None
    (tmp_path / "e.jsonl").write_text("")
    assert collect_transcript_stats(str(tmp_path / "e.jsonl")).turns == 0
    (tmp_path / "g.jsonl").write_bytes(bytes([0xFF, 0xFE, 0x00, 0x7B, 0x0A, 0x80]))
    assert collect_transcript_stats(str(tmp_path / "g.jsonl")).turns == 0


def test_collect_reads_at_most_the_tail_of_a_huge_transcript_and_says_so(tmp_path):
    p = tmp_path / "huge.jsonl"
    filler = asst("old", "claude-sonnet-5-5", {"input_tokens": 1, "output_tokens": 1}, "2026-11-18T09:00:00.000Z") + "\n"
    lines = [filler.replace('"old"', f'"o{i}"') for i in range(-(-STATS_TAIL_BYTES * 2 // len(filler)))]
    lines.append(asst("last", "claude-sonnet-5-5", {"input_tokens": 5, "output_tokens": 6}, "2026-11-18T10:00:00.000Z"))
    p.write_text("".join(lines))
    s = collect_transcript_stats(str(p))
    assert s.truncated is True
    assert 1 < s.turns < len(lines)
    assert s.bytesRead <= STATS_TAIL_BYTES
    assert "(partial: only the last 8.0 MiB of the transcript was read)" in render_stats(StatsView(s, [], None))


def test_a_single_oversized_line_is_skipped_not_parsed(tmp_path):
    p = tmp_path / "big.jsonl"
    big = json.dumps({"type": "assistant", "message": {"id": "x", "usage": {"input_tokens": 9}, "pad": "x" * 3 * 1024 * 1024}})
    p.write_text(f"{big}\n{asst('m', 'claude-haiku-5-5', {'input_tokens': 2, 'output_tokens': 3}, '2026-11-18T10:00:00.000Z')}\n")
    s = collect_transcript_stats(str(p))
    assert (s.turns, s.input) == (1, 2)


def test_transcript_path_is_persisted_and_read_back_bad_paths_are_ignored(opts):
    record_transcript_path({"session_id": "s1", "transcript_path": "/a/b/one.jsonl"}, opts)
    assert read_transcript_path("s1", opts) == "/a/b/one.jsonl"
    record_transcript_path({"session_id": "s1", "transcript_path": "/a/b/two.jsonl"}, opts)
    assert read_transcript_path("s1", opts) == "/a/b/two.jsonl"
    for bad in ["relative.jsonl", "/a/b/c.txt", "/a/\x07b.jsonl", 5, None, "/a/" + "x" * 5000 + ".jsonl"]:
        record_transcript_path({"session_id": "s1", "transcript_path": bad}, opts)
        assert read_transcript_path("s1", opts) == "/a/b/two.jsonl"
    update_session_state("s3", lambda s: {**s, "transcriptPath": "relative"}, opts)
    assert read_transcript_path("s3", opts) is None
    assert read_transcript_path("none", opts) is None


def test_render_stats_transcript_subagents_and_exploration(tmp_path, opts):
    p = tmp_path / "t.jsonl"
    p.write_text(FIXTURE)
    record_subagent_start({"session_id": "s1", "agent_id": "a1", "agent_type": "odd-claude:odd-explore"}, opts, 1_000)
    record_subagent_stop({"session_id": "s1", "agent_id": "a1", "agent_type": "odd-claude:odd-explore"}, opts, 66_000)
    update_session_state("s1", lambda s: {**s, "exploration": {"lookups": 4, "bytes": 41_000, "notified": True}}, opts)
    from odd_claude.lib.subagents import read_subagents

    v = StatsView(collect_transcript_stats(str(p)), read_subagents("s1", opts), read_exploration("s1", opts))
    assert render_stats(v) == "\n".join(
        [
            "odd-claude stats (this session, local data only)",
            "turns      2 · 1m30s",
            "tokens     in 13 · out 47",
            "cache      89% hit · 150 read · 5 written",
            "  claude-sonnet-5-5  1 turn · 155 tokens",
            "  claude-haiku-5-5  1 turn · 60 tokens",
            "subagents  1 subagent (0 running) · 1m05s finished work",
            "explore    this turn: 4 lookups · 41000 bytes",
        ]
    )


def test_render_stats_without_transcript_and_number_formats():
    assert render_stats(StatsView(None, [], None)).splitlines()[1:] == ["No transcript to read for this session yet.", "subagents  0 subagents (0 running)"]
    assert render_stats(StatsView(None, [{"id": "a", "type": "t"}], None, "note!")).splitlines()[1] == "note!"
    from odd_claude.lib.stats import ModelUsage, TranscriptStats

    t = TranscriptStats(turns=1, input=1250, output=2_500_000, cacheRead=0, cacheWrite=0, spanMs=0, truncated=False, bytesRead=1, models=[ModelUsage(model="m", turns=2, tokens=1000)])
    out = render_stats(StatsView(t, [], None))
    assert "tokens     in 1.3k · out 2.5M" in out  # JS toFixed rounds 1.25 up
    assert "  m  2 turns · 1k tokens" in out
    assert "cache      0% hit" in out


def test_read_exploration_and_stats_json_shapes(opts):
    assert read_exploration("s", opts) is None
    update_session_state("s", lambda s: {**s, "exploration": {"lookups": 3, "bytes": "x"}}, opts)
    assert read_exploration("s", opts).model_dump() == {"lookups": 3, "bytes": 0}
    out = json.loads(stats_json("s", StatsView(None, [], None, "n")))
    assert out == {"schema": "odd-claude.stats/v1", "session": "s", "subagents": [], "note": "n"}
    assert stats_json("s", StatsView(None, [], None)).startswith('{\n  "schema": "odd-claude.stats/v1",\n  "session": "s"')


def test_collect_strips_whole_osc_csi_sequences_from_model_names(tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text(
        "\n".join(
            [
                asst("a", "claude-x\x1b]0;PWN\x07", {"input_tokens": 1, "output_tokens": 1}, "2026-11-18T10:00:00.000Z"),
                asst("b", "claude-y\x1b[31mR", {"input_tokens": 1, "output_tokens": 1}, "2026-11-18T10:00:01.000Z"),
            ]
        )
    )
    assert sorted(m.model for m in collect_transcript_stats(str(p)).models) == ["claude-x", "claude-yR"]


def test_collect_edge_records_anonymous_ids_unknown_model_and_bad_timestamps(tmp_path):
    p = tmp_path / "t.jsonl"
    rows = [
        {"type": "assistant", "timestamp": "garbage", "message": {"usage": {"input_tokens": 2.0, "output_tokens": -4, "cache_read_input_tokens": True}}},
        {"type": "assistant", "message": {"usage": {"input_tokens": 3}}},
        {"type": "assistant", "message": {"id": "", "model": 5, "usage": []}},
        {"type": "user", "message": {"usage": {"input_tokens": 9}}},
        [1],
        None,
    ]
    p.write_text("\n".join(json.dumps(r) for r in rows))
    s = collect_transcript_stats(str(p))
    assert (s.turns, s.input, s.output, s.cacheRead, s.spanMs) == (3, 5, 0, 0, 0)
    assert [(m.model, m.turns) for m in s.models] == [("unknown", 3)]
    assert s.models[0].tokens == 5 and isinstance(s.input, int)
