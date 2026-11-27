"""Background subagents policy (port of v9 lib/background-subagents.ts). Plugin-wide state `background-subagents` ({policy}).
Resolution: stored state > env ODD_CLAUDE_BACKGROUND_SUBAGENTS ("on"|"off") > default "off". A present-but-malformed
state file fails closed to "off" and stays attributed to the state."""
import os
from dataclasses import dataclass
from typing import Any, Literal

from .js import js_stringify
from .state import StateOptions, read_plugin_state, resolve_data_dir, write_plugin_state

BACKGROUND_POLICIES = ("on", "off")
BACKGROUND_ENV = "ODD_CLAUDE_BACKGROUND_SUBAGENTS"


@dataclass
class BackgroundResolution:
    policy: Literal["on", "off"]
    source: Literal["state", "environment", "default"]
    malformed: bool


def _is_policy(v: Any) -> bool:
    return v == "on" or v == "off"


def resolve_background_subagents(opts: StateOptions | None = None) -> BackgroundResolution:
    opts = opts or StateOptions()
    env = opts.env if opts.env is not None else os.environ
    try:
        # exists() distinguishes "no state file" from "state file with unusable content".
        if os.path.exists(os.path.join(resolve_data_dir(opts), "background-subagents.json")):
            policy = read_plugin_state("background-subagents", opts).get("policy")
            if _is_policy(policy):
                return BackgroundResolution(policy, "state", False)
            return BackgroundResolution("off", "state", True)
    except Exception:
        pass  # no data dir: fall through to env/default
    from_env = env.get(BACKGROUND_ENV)
    if _is_policy(from_env):
        return BackgroundResolution(from_env, "environment", False)
    return BackgroundResolution("off", "default", False)


def read_background_subagents(opts: StateOptions | None = None) -> str:
    return resolve_background_subagents(opts).policy


def write_background_subagents(policy: str, opts: StateOptions | None = None) -> str:
    """Validates then stores; raises on an invalid policy without touching the stored value."""
    if not _is_policy(policy):
        raise ValueError(f"invalid policy {js_stringify(policy)}; available policies: {', '.join(BACKGROUND_POLICIES)}")
    write_plugin_state("background-subagents", {"policy": policy}, opts)
    return policy


def background_subagents_line(policy: str) -> str:
    """One line for the SessionStart context so the orchestrator knows how to launch Agent."""
    if policy == "on":
        return "Background subagents: on — launch independent, non-blocking Agent work with run_in_background: true and keep working; collect results when notified."
    return "Background subagents: off — run Agent calls in the foreground (do not set run_in_background) unless the user asks for background work."
