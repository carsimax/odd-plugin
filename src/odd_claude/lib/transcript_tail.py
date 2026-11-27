"""Bounded transcript reading shared by stats and retro (port of v9 lib/transcript-tail.ts): only the tail is read, lines are capped, text is cleaned."""
import os
import re
import stat
from dataclasses import dataclass

#: Only the tail of a transcript is read: a long session never costs more than this.
STATS_TAIL_BYTES = 8 * 1024 * 1024
#: A single line above this is skipped unparsed (a huge tool result, not a usage record).
STATS_MAX_LINE_BYTES = 2 * 1024 * 1024

_OSC = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?")
_CSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]?")
_CONTROL = re.compile("[\u0000-\u001f\u007f-\u009f‎‏؜  ‪-‮⁦-⁩]")
_TRIM = re.compile(r"^[\s﻿]+|[\s﻿]+$")  # JS trim(): Unicode whitespace plus the BOM


def clean_text(s: object) -> str:
    """Strips escape sequences, control and bidi characters: transcript text is never trusted."""
    if not isinstance(s, str):
        return ""
    return _TRIM.sub("", _CONTROL.sub("", _CSI.sub("", _OSC.sub("", s))))


@dataclass
class Tail:
    text: str
    truncated: bool
    bytes: int
    #: 1-based absolute line number (in the whole file) of the first line of `text`.
    first_line: int


def _count_newlines(f, end: int) -> int:
    """Newlines in bytes [0, end) of the open file, streamed in bounded chunks (never buffers the prefix)."""
    f.seek(0)
    n = pos = 0
    while pos < end:
        chunk = f.read(min(1024 * 1024, end - pos))
        if not chunk:
            break
        n += chunk.count(b"\n")
        pos += len(chunk)
    return n


def read_tail(path: str, tail_bytes: int = STATS_TAIL_BYTES) -> Tail | None:
    """None for a non-regular file (a FIFO or device would hang); raises OSError when the file cannot be read."""
    if not stat.S_ISREG(os.stat(path).st_mode):
        return None
    with open(path, "rb") as f:
        size = os.fstat(f.fileno()).st_size
        n = min(size, tail_bytes)
        f.seek(size - n)
        buf = f.read(n)
        text = buf.decode("utf-8", errors="replace")
        if size <= n:
            return Tail(text, False, len(buf), 1)
        # A tail read can start mid-line: drop the partial first line.
        nl = text.find("\n")
        first_line = _count_newlines(f, size - n) + (2 if nl >= 0 else 1)
        return Tail(text[nl + 1 :], True, len(buf), first_line)
