"""R14 exploration budget (port of v9 lib/exploration-budget.ts). A hook is a fresh process per call, so the counters live in
session state (key `exploration`) and UserPromptSubmit resets them per turn. Advisory only: it returns a notice."""
from decimal import ROUND_HALF_UP, Decimal, localcontext
from typing import Any

from pydantic import BaseModel

from .state import StateOptions, update_session_state

#: Thresholds: the notice fires once lookups > 3 or text bytes > 40,000.
EXPLORATION_MAX_LOOKUPS = 3
EXPLORATION_MAX_BYTES = 40_000

_BUILTIN = {"Read", "Grep", "Glob", "WebFetch", "WebSearch"}


class ExplorationCounters(BaseModel):
    """Session state key `exploration`."""

    lookups: int | float = 0
    bytes: int | float = 0
    notified: bool = False


def is_exploration_tool(name: str) -> bool:
    return name in _BUILTIN or name.startswith("mcp__codegraph__")


def response_text_bytes(value: Any, depth: int = 0) -> int:
    """UTF-8 bytes of every string inside a tool response (text parts only)."""
    if isinstance(value, str):
        return len(value.encode("utf-8", "surrogatepass"))
    if depth > 8:
        return 0
    if isinstance(value, dict):
        # The `type` discriminator ("text", "file") is protocol, not content.
        return sum(response_text_bytes(v, depth + 1) for k, v in value.items() if k != "type")
    if isinstance(value, list):
        return sum(response_text_bytes(v, depth + 1) for v in value)
    return 0


def _js_num(v: int | float) -> int | float:
    """A JS number: an int beyond 2**53 is a double, and an integral double below 1e21 prints as its shortest digits, not as `N.0`."""
    if isinstance(v, int) and abs(v) > 2**53:
        v = float(v)
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e21:
        return int(Decimal(repr(v)))
    return v


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _counters(state: dict[str, Any]) -> ExplorationCounters:
    e = state.get("exploration")
    e = e if isinstance(e, dict) else {}
    return ExplorationCounters(
        lookups=_js_num(e["lookups"]) if _num(e.get("lookups")) else 0,
        bytes=_js_num(e["bytes"]) if _num(e.get("bytes")) else 0,
        notified=e.get("notified") is True,
    )


def _locale(n: int | float) -> str:
    """JS `Number.prototype.toLocaleString("en-US")`: shortest-repr digits, at most 3 fraction digits (half up), grouped, "-0" kept."""
    with localcontext() as ctx:
        ctx.prec = 400
        d = Decimal(repr(float(n))).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)
        out = format(abs(d), ",f")
    if "." in out:
        out = out.rstrip("0").rstrip(".")
    return f"-{out}" if n < 0 else out


def exploration_notice(lookups: int, bytes: int) -> str:
    return (
        f"Exploration budget: {_locale(lookups)} tracked lookups and {_locale(bytes)} UTF-8 text bytes (an approximate evidence budget). "
        "Ongoing discovery needs several parallel odd-explore subagents, one per distinct front (single narrow front: one), "
        "even if read-only or initially small. Reading that prepares a writer belongs in that writer's prompt. This is advisory "
        "runtime context for the original task, not a new user request; it blocks nothing and grants no mutation authority."
    )


def record_exploration(session_id: str, tool_response: Any, notify: bool, opts: StateOptions | None = None) -> str | None:
    """Counts one exploration result; returns the notice once per turn when a threshold is crossed."""
    notice: str | None = None

    def update(s):
        nonlocal notice
        c = _counters(s)
        c.lookups = _js_num(c.lookups + 1)
        c.bytes = _js_num(c.bytes + response_text_bytes(tool_response))
        if notify and not c.notified and (c.lookups > EXPLORATION_MAX_LOOKUPS or c.bytes > EXPLORATION_MAX_BYTES):
            c.notified = True
            notice = exploration_notice(c.lookups, c.bytes)
        return {**s, "exploration": c.model_dump()}

    update_session_state(session_id, update, opts)
    return notice


def reset_exploration(session_id: str, opts: StateOptions | None = None) -> None:
    """Per-turn reset (UserPromptSubmit)."""
    update_session_state(session_id, lambda s: {**s, "exploration": ExplorationCounters().model_dump()}, opts)
