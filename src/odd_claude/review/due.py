"""The "unreviewed candidate" decision shared by the Stop settle reminder and the delivery notice (port of v9 review/due.ts): the same
candidate the review entry rule would START, and only when the risk assessment says a review is due. Read-only; it may raise
(SnapshotError), callers decide what a failure means.
Public API: `GIT_MS`, `committed_range_base(cwd)`, `find_due_candidate(root)` -> `{"target", "status"}` or None.
"""
import re

from ..lib.js import js_number, js_trim
from .risk import assess_candidate
from .snapshot import run_git
from .status import _to_string, review_status

#: Per git command bound inside the hooks (hooks.json gives each hook 30 s).
GIT_MS = 5000

_JS_WS = re.compile("[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+")


def _offers_start(s: dict) -> bool:
    t = s["next_transition"]
    return t["kind"] == "execute" and t.get("execute", {}).get("operation") == "review.start"


def committed_range_base(cwd: str) -> str | None:
    """The committed range a clean worktree would review: the branch upstream, else the remote default branch; one merge base, non-empty."""

    cwd = cwd if isinstance(cwd, str) else _to_string(cwd)  # node's spawn stringifies a non-string `-C` argument

    def git(*args: str) -> str | None:
        try:
            return js_trim(run_git(cwd, list(args), GIT_MS).stdout.decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001
            return None

    head = git("rev-parse", "--verify", "HEAD^{commit}")
    if not head:
        return None

    def from_ref(ref: str | None) -> str | None:
        if not ref:
            return None
        bases = [x for x in _JS_WS.split(git("merge-base", "--all", head, ref) or "") if x != ""]
        if len(bases) != 1 or bases[0] == head:
            return None
        return bases[0] if js_number(git("rev-list", "--count", f"{bases[0]}..{head}") or "undefined") > 0 else None

    return from_ref(git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")) or from_ref(git("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"))


def _find_candidate(root: str) -> dict | None:
    opts = {"gitTimeoutMs": GIT_MS}
    workspace = review_status(root, opts)
    if _offers_start(workspace):
        return {"target": {"kind": "current-changes"}, "status": workspace}
    # Only an EMPTY workspace falls back to the committed range; a candidate that is declined, consumed or under review stays silent.
    if workspace["next_transition"]["reason_code"] != "not_due":
        return None
    base_ref = committed_range_base(root)
    if base_ref is None:
        return None
    target = {"kind": "base-diff", "baseRef": base_ref, "committedOnly": True}
    committed = review_status(root, {**opts, "target": target})
    return {"target": target, "status": committed} if _offers_start(committed) else None


def find_due_candidate(root: str) -> dict | None:
    """The unreviewed candidate of a repository whose review is due (high risk), or None."""
    found = _find_candidate(root)
    if found is None:
        return None
    assessed = assess_candidate(root, found["target"], {"gitTimeoutMs": GIT_MS})
    if assessed["status"] != "assessed" or assessed["targetIdentity"] != found["status"]["target_identity"]:
        return None
    return found if assessed["reviewDue"] else None
