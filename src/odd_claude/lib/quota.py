"""Advisory quota recovery (port of v9 lib/quota.ts). Classifies the API error that ended a turn and, for recoverable
categories, arms one advisory line for the next prompt. Same-provider only; nothing here blocks or forces anything."""
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass

from pydantic import BaseModel

from .state import StateOptions, update_session_state

#: How long a failed model should be avoided: spent quota or credentials last longer than a transient hiccup.
COOLDOWN_MS = {"exhausted": 30 * 60_000, "transient": 2 * 60_000}

_EXHAUSTED = {"quota", "auth"}
_RECOVERABLE = {"quota", "auth", "rate_limit", "provider_unavailable", "timeout", "network"}

# Claude Code's own StopFailure `error` values (hook matcher values) mapped to categories.
_KNOWN_TYPES = {
    "rate_limit": "rate_limit",
    "overloaded": "provider_unavailable",
    "server_error": "provider_unavailable",
    "billing_error": "quota",
    "authentication_failed": "auth",
    "oauth_org_not_allowed": "auth",
    "account_on_hold": "auth",
    "verification_required": "auth",
    "cloud_credential_error": "auth",
    "invalid_request": "invalid_request",
    "model_not_found": "invalid_request",
    "max_output_tokens": "other",
}

SCAN_MAX = 4096
# JS regex parity: ASCII-only case folding (a non-ASCII char never matches an ASCII letter, e.g. KELVIN SIGN vs k), ASCII `\d`/`\b`,
# `.` excluding all four line terminators, `$` only at the very end, and JS `\s` spelled out (Python's differs).
_I = re.IGNORECASE | re.ASCII
_WS = "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
_DOT = "[^\\n\\r\\u2028\\u2029]"


def _rx(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern.replace(".", _DOT), _I)


# First match wins: specific causes before the generic statuses they share (quota and context errors often arrive as 429 or 400).
_KEYWORDS = [
    ("context_length", _rx(r"context.?length|context.?window|maximum context|prompt is too long|too many tokens")),
    ("quota", _rx(r"quota|billing|out of budget|usage.?limit|credit balance")),
    ("auth", _rx(r"unauthori[sz]ed|forbidden|authenticat|api.?key|permission.?denied")),
    ("rate_limit", _rx(r"rate.?limit|too many requests")),
    ("timeout", _rx(r"time.?out|timed out|deadline exceeded")),
    ("network", _rx(r"network|connection|websocket|ECONN(?:RESET|REFUSED|ABORTED)|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|other side closed")),
    ("provider_unavailable", _rx(r"overloaded|unavailable|server.?error|internal.?error|server_busy|capacity|high demand")),
    ("invalid_request", _rx(r"invalid.?request|bad request")),
]
# Only a status in a status position: leading ("429: ..."), parenthesized ("Provider (403): ...") or labeled ("status 503", "HTTP 502").
_HTTP_STATUS = re.compile(
    rf"(?:^[{_WS}]*|\(|\b(?:status(?:[{_WS}]+code)?|http)[{_WS}]*:?[{_WS}]*)([45][0-9][0-9])(?=[{_WS}):,{{]|\Z)", _I
)


def _status_category(status: int) -> str:
    if status in (401, 403):
        return "auth"
    if status == 429:
        return "rate_limit"
    if status in (408, 504):
        return "timeout"
    if status >= 500:
        return "provider_unavailable"
    return "invalid_request"


def classify_stop_failure(error: str | None = None, details: str | None = None) -> str:
    if error is not None and error in _KNOWN_TYPES:
        return _KNOWN_TYPES[error]
    # JS `slice` counts UTF-16 units; a cut astral character leaves a lone surrogate that matches nothing.
    text = (details or "").encode("utf-16-le", "surrogatepass")[: 2 * SCAN_MAX].decode("utf-16-le", "surrogatepass")
    if text == "":
        return "other"
    for category, rx in _KEYWORDS:
        if rx.search(text):
            return category
    m = _HTTP_STATUS.search(text)
    return _status_category(int(m.group(1))) if m else "other"


@dataclass
class QuotaAdvice:
    category: str
    cooldown_ms: int
    #: Epoch ms until which the failed model should be avoided.
    until: int
    text: str


def quota_advice(category: str, now: int) -> QuotaAdvice | None:
    """Advice for recoverable categories only; a request or context problem would fail the same way on another model."""
    if category not in _RECOVERABLE:
        return None
    cooldown = COOLDOWN_MS["exhausted"] if category in _EXHAUSTED else COOLDOWN_MS["transient"]
    text = " ".join(
        [
            f"odd-claude quota recovery (advisory): the previous turn ended with a {category} failure; avoid that model for about {cooldown // 60_000} min.",
            "Do not retry automatically. Tell the user they can switch with `/model`, or restart with `claude --fallback-model <model>`",
            "(Anthropic models only: there is no cross-provider fallback). Retry the failed work only when the user asks.",
            "Guidance: the always-loaded `odd-verification` rule (Verifier quota recovery).",
        ]
    )
    return QuotaAdvice(category, cooldown, now + cooldown, text)


class StoredFailure(BaseModel):
    """Session state key `quotaFailure`."""

    category: str
    until: int
    advised: bool
    text: str


def _now_ms() -> int:
    return int(time.time() * 1000)


def record_quota_failure(
    session_id: str, input: Mapping[str, str | None], opts: StateOptions | None = None, now: int | None = None
) -> tuple[str, int] | None:
    """Records a recoverable failure in the session state and returns (category, until); None (nothing stored) otherwise."""
    category = classify_stop_failure(input.get("error"), input.get("details"))
    advice = quota_advice(category, _now_ms() if now is None else now)
    if advice is None:
        return None
    stored = StoredFailure(category=category, until=advice.until, advised=False, text=advice.text).model_dump()
    update_session_state(session_id, lambda s: {**s, "quotaFailure": stored}, opts)
    return category, advice.until


def _num(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def take_quota_advice(session_id: str, opts: StateOptions | None = None, now: int | None = None) -> str | None:
    """The pending advisory text, once, and only while the cooldown is running. Never raises."""
    now = _now_ms() if now is None else now
    text: str | None = None

    def update(s):
        nonlocal text
        f = s.get("quotaFailure")
        if not isinstance(f, dict) or f.get("advised") is not False or not _num(f.get("until")) or not isinstance(f.get("text"), str) or now >= f["until"]:
            return s
        text = f["text"]
        return {**s, "quotaFailure": {**f, "advised": True}}

    try:
        update_session_state(session_id, update, opts)
    except Exception:
        return None
    return text
