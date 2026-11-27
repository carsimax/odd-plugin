"""Recording the transcript path of a session (port of v9 lib/transcript-path.ts)."""
import os
import re

from .state import StateOptions, update_session_state

MAX_PATH = 4096
_CONTROL = re.compile("[\x00-\x1f\x7f]")


def valid_path(p: object) -> bool:
    return isinstance(p, str) and len(p) <= MAX_PATH and os.path.isabs(p) and p.endswith(".jsonl") and not _CONTROL.search(p)


def record_transcript_path(input: dict, opts: StateOptions | None = None) -> None:
    """Persists the latest transcript path of the session (SessionStart / UserPromptSubmit). Never raises, never outputs."""
    sid = input.get("session_id")
    path = input.get("transcript_path")
    if not isinstance(sid, str) or sid == "" or not valid_path(path):
        return
    try:
        update_session_state(sid, lambda s: s if s.get("transcriptPath") == path else {**s, "transcriptPath": path}, opts)
    except Exception:
        pass  # advisory only
