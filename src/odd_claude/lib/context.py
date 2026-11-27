"""Builds the `additionalContext` of the SessionStart / UserPromptSubmit hooks (port of v9 lib/context.ts).
Only per-session dynamic lines are built here; the static protocol lives in the managed CLAUDE.md blocks."""
import json
import re
from dataclasses import dataclass, field
from typing import Any

from .background_subagents import background_subagents_line
from .state import StateOptions, read_plugin_state, write_plugin_state

DELEGATION_MODES = ("organic", "full")
#: Coordinator mode ON by default: `full` delegation unless the user switched it off.
DEFAULT_DELEGATION = "full"


@dataclass
class SessionContextInput:
    delegation_mode: str
    #: Background subagents policy; defaults to off.
    background_subagents: str | None = None
    #: Extra single-line facts (e.g. the skill registry path).
    extra_lines: list[str] = field(default_factory=list)


def read_delegation_mode(opts: StateOptions | None = None) -> str:
    """Plugin-wide state `delegation` ({mode}); missing, corrupt or unknown reads as the default (full)."""
    try:
        mode = read_plugin_state("delegation", opts).get("mode")
    except Exception:
        return DEFAULT_DELEGATION
    return mode if isinstance(mode, str) and mode in DELEGATION_MODES else DEFAULT_DELEGATION


def write_delegation_mode(mode: str, opts: StateOptions | None = None) -> str:
    """Validates then stores; raises on an invalid mode without touching the stored value."""
    if mode not in DELEGATION_MODES:
        raise ValueError(f"invalid delegation mode {json.dumps(mode, ensure_ascii=False)}; available modes: {', '.join(DELEGATION_MODES)}")
    write_plugin_state("delegation", {"mode": mode}, opts)
    return mode


_FULL_TEXT = (
    "Coordinator mode: ON (full delegation). It is a rule you follow; no hook blocks edits. You do not implement: every authorized "
    "mutation of repository content (source, tests, docs, fixtures, configuration, a requested deletion) goes to a bounded `odd-worker` "
    "writer through the Agent tool, whatever its size; with no usable writer, use a general-purpose Agent with the same bounded "
    "instructions and report the fallback, never edit yourself. Reads, git state checks and Bash for state stay yours. Full rules: "
    "the always-loaded rule `odd-delegation` (Coordinator mode ON)."
)
_ORGANIC_TEXT = "Coordinator mode: OFF (organic delegation). Work inline and delegate only when a mechanism trigger fires."


def build_session_context(i: SessionContextInput) -> str:
    parts = [
        "# odd-claude session context",
        _FULL_TEXT if i.delegation_mode == "full" else _ORGANIC_TEXT,
        background_subagents_line(i.background_subagents or "off"),
        *i.extra_lines,
    ]
    return "\n\n".join(p for p in parts if p != "")


EXCERPT_CHARS = 100


def build_prompt_anchor(prompt: Any) -> str | None:
    """Per-turn anchor quoting the start of the human's own prompt; None for prompts that are not human prose."""
    if not isinstance(prompt, str):
        return None
    collapsed = re.sub(r"[\s﻿]+", " ", prompt).strip(" ﻿")
    if collapsed == "" or collapsed.startswith(("/", "!")):
        return None
    # JS parity: length and slice count UTF-16 units.
    units = collapsed.encode("utf-16-le", "surrogatepass")
    if len(units) // 2 <= EXCERPT_CHARS:
        excerpt = collapsed
    else:
        excerpt = units[: EXCERPT_CHARS * 2].decode("utf-16-le", "replace") + "…"
    return f'Reply-language anchor: the human\'s latest message begins "{excerpt}". Reply in the language of that message.'
