from odd_claude.lib.state import read_session_state, update_session_state
from odd_claude.lib.transcript_path import record_transcript_path, valid_path


def test_valid_path_rules():
    assert valid_path("/a/b/one.jsonl")
    for bad in ["relative.jsonl", "/a/b/c.txt", "/a/\x07b.jsonl", "/a/b\x7f.jsonl", 5, None, "/a/" + "x" * 5000 + ".jsonl"]:
        assert not valid_path(bad)


def test_record_persists_and_keeps_other_state(opts):
    update_session_state("s1", lambda s: {**s, "keep": 1}, opts)
    record_transcript_path({"session_id": "s1", "transcript_path": "/a/b/one.jsonl"}, opts)
    assert read_session_state("s1", opts) == {"keep": 1, "transcriptPath": "/a/b/one.jsonl"}


def test_record_ignores_bad_input_and_never_raises(opts):
    record_transcript_path({"session_id": "s1", "transcript_path": "/a/b/one.jsonl"}, opts)
    for inp in [
        {"session_id": "s1", "transcript_path": "relative.jsonl"},
        {"session_id": "", "transcript_path": "/a/two.jsonl"},
        {"session_id": 3, "transcript_path": "/a/two.jsonl"},
        {"transcript_path": "/a/two.jsonl"},
    ]:
        record_transcript_path(inp, opts)
    assert read_session_state("s1", opts)["transcriptPath"] == "/a/b/one.jsonl"
    assert read_session_state("", opts) == {}


def test_record_swallows_state_errors(tmp_path):
    from odd_claude.lib.state import StateOptions

    record_transcript_path({"session_id": "s", "transcript_path": "/a/b.jsonl"}, StateOptions(data_dir="relative"))
