"""Differential test: Python lib/transcript_tail.py against the compiled v9 lib/transcript-tail.js on the same inputs and files."""
import tempfile
from pathlib import Path

from odd_claude.lib import transcript_tail as t

from .v9_oracle import needs_v9, v9, v9_many

pytestmark = needs_v9

STRINGS = [
    "", " ", "abc", "  padded  ", "\U0001f600", "a\U0001f600b", " x ", "﻿x﻿", " x ", " x ", "　x　",
    "᠎x᠎", "\u0085x\u0085", "\x1cx\x1f", "\x0b\x0cx", "\ud800", "a\ud83dz", "\ude00", "😀", "‎x‏؜‪‮⁦⁩",
    "\x1b[31mred\x1b[0m", "\x1b]0;title\x07x", "\x1b]0;title\x1b\\x", "\x1b]unterminated", "\x1b[", "\x1b[31", "\x1b[1;2;3Hx", "\x1b[?25l\x1b[ qx",
    "a\x00b\x7fc\x9fd\x80", "\x1b]a\x1b]b\x07c", "é", "café", "line1\nline2\r\n", "﻿﻿", "x" * 5000, "\U0001f600" * 300,
]
NON_STRINGS = [None, 5, 0, True, [], ["a"], {"a": 1}, 1.5]
SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 31, 64, 10_000, 1 << 30]


def py_tail(path, *n):
    try:
        r = t.read_tail(path, *n)
    except OSError:
        return {"__error__": "os"}
    return None if r is None else {"text": r.text, "truncated": r.truncated, "bytes": r.bytes, "firstLine": r.first_line}


def v9_tail(calls):
    return [{"__error__": "os"} if isinstance(r, dict) and "__error__" in r else r for r in v9_many("transcript-tail", "readTail", calls)]


def test_clean_text_on_strings_and_non_strings():
    vals = [*STRINGS, *NON_STRINGS]
    assert v9_many("transcript-tail", "cleanText", [[s] for s in vals]) == [t.clean_text(s) for s in vals]


def test_clean_text_on_every_character_alone_and_wrapped():
    chars = [chr(c) for c in [*range(0, 0x300), *range(0x2000, 0x2070), 0x3000, 0xFEFF, 0x180E, 0xFFFD]]
    vals = [c for c in chars] + [f" {c}x{c} " for c in chars]
    assert v9_many("transcript-tail", "cleanText", [[s] for s in vals]) == [t.clean_text(s) for s in vals]


def test_read_tail_on_files_and_tail_sizes():
    bodies = [
        b"", b"\n", b"abc", b"a\nb\nc\n", b"a\nb\nc", b"a\r\nb\r\nc\r\n", b"\xef\xbb\xbfa\nb\n", b"\xff\xfe\nbad\xc3(\n", b"ok\n\xe2\x82\nok\n",
        "😀\nñ\n€x\n".encode(), "日本語\n😀😀😀\nend".encode(), b"\n\n\n\n", b"x" * 100, b"\xed\xa0\x80\nlone\n\xf0\x9f\x98\n\xf4\x90\x80\x80\n",
        b"\x00\x01\x02\nz", ("l1\n" * 20).encode(), "😀".encode() * 9,
    ]
    for body in bodies:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d, "t.jsonl")
            p.write_bytes(body)
            calls = [[str(p)], *([str(p), n] for n in SIZES), [str(p), 0], [str(p), len(body)], [str(p), len(body) + 1], [str(p), max(len(body) - 1, 0)]]
            expect = [py_tail(str(p))] + [py_tail(str(p), c[1]) for c in calls[1:]]
            assert v9_tail(calls) == expect, body


def test_read_tail_non_regular_and_missing_files():
    with tempfile.TemporaryDirectory() as d:
        calls = [[d], [str(Path(d, "nope"))], ["/dev/null"], ["/dev/zero"]]
        assert v9_tail(calls) == [py_tail(c[0]) for c in calls]
        assert py_tail(d) is None and py_tail(str(Path(d, "nope")))["__error__"]
