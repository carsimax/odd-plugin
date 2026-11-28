"""RDD delivery notice (port of v9 review/gate.ts): a Bash command that delivers work (`git push`, `gh pr create|merge`) with RDD on and an
unreviewed candidate yields ONE advisory notice. It never blocks: the command always runs, and any failure (mode unreadable, not a
repository, git error, exception) yields no notice. Read-only: it never starts a review, never answers consent and never writes authority.
Detection is a word match (as upstream): it only decides whether to read the status once. A command that also changes the candidate
(commit, merge, rebase, ...) yields nothing, because the range delivered does not exist yet.
Public API: `UNREVIEWED_DELIVERY_NOTICE`, `delivery_notice(input, opts=None)` (`input` is `{"cwd", "command"}`, `opts` a StateOptions).
"""
from ..lib.state import StateOptions
from .due import GIT_MS, find_due_candidate
from .mode import ModeOptions, is_global_mode_on, read_review_mode
from .risk import _js_re
from .snapshot import resolve_repository
from .status import _U, _to_string

_DELIVERY_VERB = _js_re(r"\bgit\b[^;&|\n]*?\spush(?=\s|$)|\bgh\b[^;&|\n]*?\spr\s+(?:create|merge)(?=\s|$)")
_CANDIDATE_CHANGE = _js_re(r"\bgit\b[^;&|\n]*?\s(?:commit|merge|rebase|reset|checkout|switch|cherry-pick|revert|am|pull|update-ref)(?=\s|$)")

UNREVIEWED_DELIVERY_NOTICE = "RDD: this repository has an unreviewed candidate; review it before delivery."


def delivery_notice(input: dict, opts: StateOptions | None = None) -> str | None:
    """The notice for one Bash command, or None. Never raises, never writes."""
    try:
        command = _to_string(input.get("command", _U))
        if not _DELIVERY_VERB.search(command) or _CANDIDATE_CHANGE.search(command):
            return None
        # A clone override can only disable, so a global switch that is not on means off everywhere: no git.
        if not is_global_mode_on(opts):
            return None
        mode_opts = ModeOptions(data_dir=getattr(opts, "data_dir", None), env=getattr(opts, "env", None), git_timeout_ms=GIT_MS)
        if read_review_mode(input.get("cwd"), mode_opts)["effective"] != "on":
            return None
        root = resolve_repository(input.get("cwd"), {"gitTimeoutMs": GIT_MS})["root"]
        return None if find_due_candidate(root) is None else UNREVIEWED_DELIVERY_NOTICE
    except Exception:  # noqa: BLE001
        return None  # a notice never blocks or fails the command
