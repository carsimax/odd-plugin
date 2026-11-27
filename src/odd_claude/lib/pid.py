"""The one bare pid probe (`kill(pid, 0)`). It says nothing about host, boot or start time.

EPERM means the process exists but is not ours, so it counts as alive.
"""
import os
from typing import Literal

PidState = Literal["alive", "dead", "unknown", "invalid"]


def pid_state(pid: object) -> PidState:
    """invalid: not a positive integer (never signalled: 0 and negatives would target process groups).
    dead: ESRCH. unknown: any other error."""
    if isinstance(pid, float) and pid.is_integer():
        pid = int(pid)
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return "invalid"
    try:
        os.kill(pid, 0)
        return "alive"
    except PermissionError:
        return "alive"
    except ProcessLookupError:
        return "dead"
    except (OSError, OverflowError):
        return "unknown"


def is_pid_alive(pid: object) -> bool:
    return pid_state(pid) == "alive"
