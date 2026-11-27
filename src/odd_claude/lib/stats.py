"""R36 local session stats (port of v9 lib/stats.ts): numbers come from the transcript JSONL (`transcript_path` in hook input),
persisted per session in the state file. Local only. Every read is bounded."""
import json
import math
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .state import StateOptions, read_session_state
from .subagents import SubagentRecord, format_duration
from .transcript_path import record_transcript_path, valid_path
from .transcript_tail import STATS_MAX_LINE_BYTES, STATS_TAIL_BYTES, clean_text, read_tail

__all__ = ["STATS_MAX_LINE_BYTES", "STATS_TAIL_BYTES", "record_transcript_path"]

MAX_MODELS = 8


class ModelUsage(BaseModel):
    model: str
    turns: int
    tokens: int | float


class TranscriptStats(BaseModel):
    turns: int
    input: int | float
    output: int | float
    cacheRead: int | float
    cacheWrite: int | float
    #: First to last dated entry in the part that was read.
    spanMs: int
    #: True when the file was larger than the tail cap: totals cover only its end.
    truncated: bool
    bytesRead: int
    models: list[ModelUsage]


class Exploration(BaseModel):
    lookups: int | float
    bytes: int | float


class StatsOutput(BaseModel):
    """`odd-claude.stats/v1`, what `stats --json` prints. Unset fields are omitted, as JSON.stringify omits undefined."""

    model_config = ConfigDict(populate_by_name=True)
    schema_: Literal["odd-claude.stats/v1"] = Field("odd-claude.stats/v1", alias="schema")
    session: str
    transcript: TranscriptStats | None = None
    subagents: list[SubagentRecord]
    exploration: Exploration | None = None
    note: str | None = None


def _count(v: Any) -> int | float:
    if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0:
        return int(v) if float(v).is_integer() else v
    return 0


def read_transcript_path(session_id: str, opts: StateOptions | None = None) -> str | None:
    p = read_session_state(session_id, opts).get("transcriptPath")
    return p if valid_path(p) else None


def _parse_ms(ts: str) -> int | None:
    try:
        dt = datetime.fromisoformat(ts)
    except ValueError:
        return None
    return int(dt.replace(tzinfo=dt.tzinfo or UTC).timestamp() * 1000)


def collect_transcript_stats(path: str) -> TranscriptStats | None:
    """Token totals from the transcript tail; None when it cannot be read. Never raises."""
    try:
        tail = read_tail(path)
        if tail is None:
            return None
        # Streaming writes the same message id several times with a growing usage: the last record wins.
        by_message: dict[str, tuple[str, Any, Any, Any, Any]] = {}
        first, last, anon = math.inf, -math.inf, 0
        for line in tail.text.split("\n"):
            if line == "" or len(line) > STATS_MAX_LINE_BYTES:
                continue
            if '"usage"' not in line and '"timestamp"' not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if not isinstance(entry, dict):
                continue
            at = _parse_ms(entry["timestamp"]) if isinstance(entry.get("timestamp"), str) else None
            if at is not None:
                first, last = min(first, at), max(last, at)
            m = entry.get("message")
            u = m.get("usage") if isinstance(m, dict) else None
            if entry.get("type") != "assistant" or not isinstance(m, dict) or not isinstance(u, (dict, list)):
                continue
            g = u.get if isinstance(u, dict) else (lambda k: None)
            model = clean_text(m["model"])[:80] if isinstance(m.get("model"), str) else ""
            if model == "<synthetic>":
                continue
            mid = m.get("id")
            if not isinstance(mid, str) or mid == "":
                mid, anon = f"anon-{anon}", anon + 1
            by_message[mid] = (model or "unknown", _count(g("input_tokens")), _count(g("output_tokens")), _count(g("cache_read_input_tokens")), _count(g("cache_creation_input_tokens")))
        totals = [0, 0, 0, 0]
        models: dict[str, ModelUsage] = {}
        for model, i, o, cr, cw in by_message.values():
            for k, v in enumerate((i, o, cr, cw)):
                totals[k] += v
            mu = models.setdefault(model, ModelUsage(model=model, turns=0, tokens=0))
            mu.turns += 1
            mu.tokens += i + o + cr + cw
        top = sorted(models.values(), key=lambda mu: (-mu.tokens, -mu.turns))[:MAX_MODELS]
        return TranscriptStats(
            turns=len(by_message), input=totals[0], output=totals[1], cacheRead=totals[2], cacheWrite=totals[3],
            spanMs=int(last - first) if last > first else 0, truncated=tail.truncated, bytesRead=tail.bytes, models=top,
        )
    except Exception:
        return None


def read_exploration(session_id: str, opts: StateOptions | None = None) -> Exploration | None:
    e = read_session_state(session_id, opts).get("exploration")
    if not isinstance(e, (dict, list)):
        return None
    g = e.get if isinstance(e, dict) else (lambda k: None)
    return Exploration(lookups=_count(g("lookups")), bytes=_count(g("bytes")))


def _plural(n: float, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _fixed(x: float, digits: int) -> str:
    """JS Number.prototype.toFixed: exact decimal expansion, halves round up."""
    return str(Decimal(x).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))


def _tokens(n: float) -> str:
    import re

    if n < 1000:
        return str(n)
    if n < 1_000_000:
        return re.sub(r"\.0$", "", _fixed(n / 1000, 1)) + "k"
    return re.sub(r"\.?0+$", "", _fixed(n / 1_000_000, 2)) + "M"


@dataclass
class StatsView:
    transcript: TranscriptStats | None
    subagents: list[dict]
    exploration: Exploration | None
    #: Why there is no transcript section, when there is none.
    note: str | None = None


def render_stats(v: StatsView) -> str:
    out = ["odd-claude stats (this session, local data only)"]
    t = v.transcript
    if t is None:
        out.append(v.note or "No transcript to read for this session yet.")
    else:
        out.append(f"turns      {t.turns}{f' · {format_duration(t.spanMs)}' if t.spanMs > 0 else ''}")
        out.append(f"tokens     in {_tokens(t.input)} · out {_tokens(t.output)}")
        prompt = t.input + t.cacheRead + t.cacheWrite
        if prompt > 0:
            out.append(f"cache      {math.floor(t.cacheRead / prompt * 100 + 0.5)}% hit · {_tokens(t.cacheRead)} read · {_tokens(t.cacheWrite)} written")
        for m in t.models:
            out.append(f"  {m.model}  {_plural(m.turns, 'turn')} · {_tokens(m.tokens)} tokens")
        if t.truncated:
            out.append(f"(partial: only the last {_fixed(t.bytesRead / (1024 * 1024), 1)} MiB of the transcript was read)")
    done = [r for r in v.subagents if r.get("startedAt") is not None and r.get("endedAt") is not None]
    running = sum(1 for r in v.subagents if r.get("endedAt") is None)
    total = sum(max(0, r["endedAt"] - r["startedAt"]) for r in done)
    out.append(f"subagents  {_plural(len(v.subagents), 'subagent')} ({running} running){f' · {format_duration(total)} finished work' if done else ''}")
    if v.exploration is not None:
        out.append(f"explore    this turn: {_plural(v.exploration.lookups, 'lookup')} · {v.exploration.bytes} bytes")
    return "\n".join(out)


def stats_json(session: str, v: StatsView) -> str:
    """The `--json` text of the stats CLI: 2-space JSON, unset fields omitted."""
    o = StatsOutput(session=session, transcript=v.transcript, subagents=[SubagentRecord.model_validate(r) for r in v.subagents], exploration=v.exploration, note=v.note)
    return json.dumps(o.model_dump(by_alias=True, exclude_none=True), indent=2, ensure_ascii=False)
