import os

from odd_claude.lib.transcript_tail import STATS_MAX_LINE_BYTES, STATS_TAIL_BYTES, clean_text, read_tail


def test_constants():
    assert STATS_TAIL_BYTES == 8 * 1024 * 1024
    assert STATS_MAX_LINE_BYTES == 2 * 1024 * 1024


def test_clean_text_strips_escapes_controls_and_bidi():
    assert clean_text("claude-x\x1b]0;PWN\x07") == "claude-x"
    assert clean_text("claude-y\x1b[31mR") == "claude-yR"
    assert clean_text("a\x00b\x7fc‮d⁦e") == "abcde"
    assert clean_text("  ﻿ hi \n") == "hi"
    assert clean_text(5) == ""
    assert clean_text(None) == ""


def test_read_tail_small_file_is_whole(tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text("a\nb\n")
    t = read_tail(str(p))
    assert (t.text, t.truncated, t.bytes, t.first_line) == ("a\nb\n", False, 4, 1)


def test_read_tail_drops_the_partial_first_line_and_counts_absolute_lines(tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text("".join(f"line{i:03d}\n" for i in range(1, 101)))  # 8 bytes each
    t = read_tail(str(p), 20)  # starts mid-line 98
    assert t.truncated and t.bytes == 20
    assert t.text == "line099\nline100\n"
    assert t.first_line == 99


def test_read_tail_without_newline_in_tail_keeps_text_and_counts_one(tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text("x\n" + "y" * 50)
    t = read_tail(str(p), 10)
    assert t.truncated and t.text == "y" * 10 and t.first_line == 2


def test_read_tail_non_files(tmp_path):
    assert read_tail(str(tmp_path)) is None
    f = tmp_path / "f.jsonl"
    os.mkfifo(f)
    assert read_tail(str(f)) is None
    import pytest

    with pytest.raises(OSError):
        read_tail(str(tmp_path / "missing"))
