"""R34 context backstop (port of v9 lib/context-backstop.ts): the last assistant `usage` line of the transcript
(input + cache_creation + cache_read tokens) against an absolute cap. No usage line: no reading, no notice."""
import math
import os
import re
from collections.abc import Mapping

from .state import StateOptions, read_session_state, update_session_state
from .transcript_tail import JS_WS, js_json_loads, read_tail

CONTEXT_BACKSTOP_TOKENS = 150_000
CONTEXT_BACKSTOP_TOKENS_ENV = "ODD_CLAUDE_CONTEXT_BACKSTOP_TOKENS"
TAIL_BYTES = 512 * 1024
#: Once the notice fired only a measured drop (re-arm) matters, so each PostToolUse reads this short tail instead of TAIL_BYTES.
FIRED_TAIL_BYTES = 32 * 1024


_JS_DECIMAL = re.compile(r"[+-]?(?:[0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?|Infinity)")
_JS_RADIX = re.compile(r"0(?:[xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)")


def _js_number(raw: str) -> float:
    """JS `Number(raw)` for a trimmed string; NaN when it is not a numeric literal."""
    if _JS_RADIX.fullmatch(raw):
        return float(int(raw, 0))
    return float(raw) if _JS_DECIMAL.fullmatch(raw) else math.nan


def context_backstop_threshold(env: Mapping[str, str | None] | None = None) -> float:
    env = os.environ if env is None else env
    raw = re.sub(f"^[{JS_WS}]+|[{JS_WS}]+$", "", env.get(CONTEXT_BACKSTOP_TOKENS_ENV) or "")
    v = _js_number(raw) if raw else 0.0
    if not (math.isfinite(v) and v > 0):
        return CONTEXT_BACKSTOP_TOKENS
    return int(v) if v.is_integer() else v


def _last_usage_tokens(path: str, max_bytes: int = TAIL_BYTES) -> int | None:
    """Prompt tokens of the last assistant turn in the transcript tail; None when none is found."""
    tail = read_tail(path, max_bytes)
    if tail is None:
        return None
    for line in reversed(tail.text.split("\n")):
        if '"usage"' not in line:
            continue
        try:
            msg = js_json_loads(line).get("message")
            u = msg.get("usage") if isinstance(msg, dict) else None
        except (ValueError, AttributeError):
            continue
        if not isinstance(u, dict):
            continue

        def num(k: str) -> float:
            v = u.get(k)
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                return 0
            try:
                return float(v)  # a JS number is a double: integers beyond 2**53 round
            except OverflowError:
                return math.inf if v > 0 else -math.inf

        total = num("input_tokens") + num("cache_creation_input_tokens") + num("cache_read_input_tokens")
        if total > 0:
            return total
    return None


def _count(v: float) -> str:
    if not math.isfinite(v):
        return "NaN" if math.isnan(v) else "∞" if v > 0 else "-∞"
    r = math.floor(v + 0.5)  # JS Math.round: halves go up
    return "-0" if r == 0 and math.copysign(1, v) < 0 else f"{r:,}"  # Math.round(-0.3) is -0


def context_backstop_notice(tokens: float, threshold: float, full_delegation: bool) -> str:
    tail = (
        "delegate the next bounded unit with a short handoff, and keep only state checks in this context."
        if full_delegation
        else "delegate the next bounded unit that needs several steps (its reads, edits, and checks) with a short handoff, while single small edits and state checks stay inline."
    )
    return f"Context backstop: the parent context measures {_count(tokens)} tokens, at or past the {_count(threshold)}-token backstop (advisory, nothing is blocked): {tail}"


def _rearm(session_id: str, opts: StateOptions | None) -> None:
    update_session_state(session_id, lambda s: {**s, "contextBackstop": False} if s.get("contextBackstop") is True else s, opts)


def check_context_backstop(session_id: str, transcript_path: object, full_delegation: bool, env: Mapping[str, str | None], opts: StateOptions | None) -> str | None:
    """One notice per crossing per session (state key `contextBackstop`). A reading below the threshold re-arms it (compaction)."""
    if not isinstance(transcript_path, str) or transcript_path == "":
        return None
    threshold = context_backstop_threshold(env)
    tokens: float | None
    if read_session_state(session_id, opts).get("contextBackstop") is True:
        # Already fired: nothing can notify until a measured drop re-arms it, so read a short tail and skip the size estimate.
        try:
            tokens = _last_usage_tokens(transcript_path, FIRED_TAIL_BYTES) if os.path.isfile(transcript_path) else None
        except OSError:
            tokens = None
        if tokens is not None and tokens < threshold:
            _rearm(session_id, opts)
        return None
    try:
        tokens = _last_usage_tokens(transcript_path)
    except OSError:
        tokens = None
    if tokens is None:
        return None
    if tokens < threshold:
        _rearm(session_id, opts)
        return None
    fire = False

    def mark(s: dict) -> dict:
        nonlocal fire
        if s.get("contextBackstop") is True:
            return s
        fire = True
        return {**s, "contextBackstop": True}

    update_session_state(session_id, mark, opts)
    return context_backstop_notice(tokens, threshold, full_delegation) if fire else None
