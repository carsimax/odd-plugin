"""Subagent log (port of v9 lib/subagents.ts): SubagentStart/SubagentStop events recorded in the session state under `subagents`."""
import math
import time
from collections.abc import Callable
from typing import Any

from pydantic import BaseModel, ConfigDict

from .state import StateOptions, log_error, read_session_state, update_session_state

MAX_SUBAGENTS = 50


class SubagentRecord(BaseModel):
    """One entry of the `subagents` state list (as printed by `stats --json`); epoch ms, `startedAt` absent when only a stop was seen."""

    model_config = ConfigDict(extra="allow")
    id: str
    type: str
    startedAt: Any = None
    endedAt: Any = None


def _valid(input: object) -> bool:
    return isinstance(input, dict) and isinstance(input.get("session_id"), str) and input["session_id"] != "" and isinstance(input.get("agent_id"), str) and input["agent_id"] != ""


def _type_of(input: dict) -> str:
    t = input.get("agent_type")
    return t if isinstance(t, str) and t != "" else "unknown"


def _is_record(v: object) -> bool:
    return isinstance(v, dict) and isinstance(v.get("id"), str) and isinstance(v.get("type"), str)


def _records(raw: object) -> list[dict]:
    return [r for r in raw if _is_record(r)] if isinstance(raw, list) else []


def read_subagents(session_id: str, opts: StateOptions | None = None) -> list[dict]:
    return _records(read_session_state(session_id, opts).get("subagents"))


def _update(input: object, opts: StateOptions | None, label: str, change: Callable[[list[dict]], list[dict]]) -> None:
    if not _valid(input):
        return
    try:
        update_session_state(input["session_id"], lambda s: {**s, "subagents": change(_records(s.get("subagents")))[-MAX_SUBAGENTS:]}, opts)
    except Exception as err:
        log_error(f"{label}: {err}", opts)


def _now() -> int:
    return int(time.time() * 1000)


def record_subagent_start(input: object, opts: StateOptions | None = None, now: float | None = None) -> None:
    """Never raises; a failure is logged and the hook stays silent."""
    now = _now() if now is None else now

    def change(lst: list[dict]) -> list[dict]:
        prev = next((r for r in lst if r["id"] == input["agent_id"]), {})
        return [*(r for r in lst if r["id"] != input["agent_id"]), {**prev, "id": input["agent_id"], "type": _type_of(input), "startedAt": now}]

    _update(input, opts, "SubagentStart", change)


def record_subagent_stop(input: object, opts: StateOptions | None = None, now: float | None = None) -> None:
    now = _now() if now is None else now

    def change(lst: list[dict]) -> list[dict]:
        id = input["agent_id"]
        if any(r["id"] == id for r in lst):
            return [{**r, "endedAt": now} if r["id"] == id else r for r in lst]
        return [*lst, {"id": id, "type": _type_of(input), "endedAt": now}]

    _update(input, opts, "SubagentStop", change)


def format_duration(ms: float) -> str:
    s = math.floor(max(0, ms) / 1000)
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    if h > 0:
        return f"{h}h{m:02d}m{sec:02d}s"
    if m > 0:
        return f"{m}m{sec:02d}s"
    return f"{sec}s"
