"""Per-session scratch dir (port of v9 lib/scratch.ts): <data>/scratch/<session>, created at SessionStart, removed at
SessionEnd. Keeps the "own dir per session, remove only what we own" rule and refuses anything that is not a plain
directory at exactly that path. Public API: `scratch_root`, `scratch_dir`, `create_session_scratch` (0700, idempotent,
raises on a symlinked or non-directory root/dir), `remove_session_scratch` ("removed" | "absent" | "refused", never follows
links), `sweep_stale_tombstones`, `list_scratch`.
"""
import os
import re
import shutil
import time
from dataclasses import dataclass
from typing import Literal

from .state import StateOptions, log_error, resolve_data_dir, safe_segment

RemoveResult = Literal["removed", "absent", "refused"]
TOMBSTONE_RE = re.compile(r"^\.rm-[0-9]+-([0-9]+)-")
TOMBSTONE_MAX_AGE_MS = 60 * 60 * 1000
SWEEP_MAX_ENTRIES = 200


def scratch_root(opts: StateOptions | None = None) -> str:
    return os.path.join(resolve_data_dir(opts), "scratch")


def scratch_dir(session_id: str, opts: StateOptions | None = None) -> str:
    return os.path.join(scratch_root(opts), safe_segment(session_id))


def _lstat(p: str) -> os.stat_result | None:
    try:
        return os.lstat(p)
    except FileNotFoundError:
        return None


def _plain_dir(st: os.stat_result) -> bool:
    import stat

    return stat.S_ISDIR(st.st_mode)  # lstat: a symlink is never S_ISDIR


def create_session_scratch(session_id: str, opts: StateOptions | None = None) -> str:
    """Creates the scratch (0700, idempotent). Raises when the root or the dir is a symlink or not a directory."""
    root, d = scratch_root(opts), scratch_dir(session_id, opts)
    os.makedirs(os.path.dirname(root), exist_ok=True)
    for p in (root, d):
        st = _lstat(p)
        if st is None:
            os.mkdir(p, 0o700)
        elif not _plain_dir(st):
            raise ValueError(f"unsafe scratch path: {p}")
    return d


def remove_session_scratch(session_id: str, opts: StateOptions | None = None) -> RemoveResult:
    """Removes only <data>/scratch/<session>; refuses a symlinked root/dir or a path that resolves elsewhere. Never follows links."""
    root, d = scratch_root(opts), scratch_dir(session_id, opts)
    st = _lstat(root)
    if st is None:
        return "absent"
    if not _plain_dir(st):
        return "refused"
    st = _lstat(d)
    if st is None:
        return "absent"
    if not _plain_dir(st):
        return "refused"
    real_root = os.path.realpath(root, strict=True)
    name = os.path.basename(d)
    if os.path.realpath(d, strict=True) != os.path.join(real_root, name):
        return "refused"
    # Rename the entry to a unique tombstone inside the verified real root (rename never follows the entry itself),
    # then re-verify before deleting. Residual same-user race: the root can be swapped between the realpath and the rename.
    tomb = os.path.join(real_root, f".rm-{os.getpid()}-{int(time.time() * 1000)}-{name}")
    try:
        os.rename(os.path.join(real_root, name), tomb)
        t = os.lstat(tomb)
        if not _plain_dir(t) or os.path.realpath(tomb, strict=True) != os.path.join(os.path.realpath(root, strict=True), os.path.basename(tomb)):
            log_error(f"scratch removal aborted, tombstone not verified: {tomb}", opts)
            return "refused"
    except Exception as err:
        log_error(f"scratch removal aborted: {err}", opts)
        return "refused"
    try:
        shutil.rmtree(tomb)  # unlinks symlinks inside the tree instead of following them
    except FileNotFoundError:
        pass
    return "removed"


def sweep_stale_tombstones(opts: StateOptions | None = None, now: float | None = None, max_age_ms: float = TOMBSTONE_MAX_AGE_MS) -> int:
    """Deletes tombstones (`.rm-<pid>-<ts>-<id>`) left by a crashed removal. Only real directories (lstat, never symlinks)
    directly inside the verified real scratch root, whose name carries a timestamp older than `max_age_ms`, whose realpath
    is exactly <realroot>/<name>. Bounded to 200 tombstone-matching entries per run; ENOENT is ignored silently. Returns
    how many were removed; never raises."""
    now = time.time() * 1000 if now is None else now
    removed = 0
    try:
        root = scratch_root(opts)
        st = _lstat(root)
        if st is None or not _plain_dir(st):
            return 0
        real_root = os.path.realpath(root, strict=True)
        candidates = [n for n in os.listdir(real_root) if (m := TOMBSTONE_RE.match(n)) and now - int(m.group(1)) >= max_age_ms]
        for name in candidates[:SWEEP_MAX_ENTRIES]:
            p = os.path.join(real_root, name)
            try:
                if not _plain_dir(os.lstat(p)) or os.path.realpath(p, strict=True) != p:
                    continue
                shutil.rmtree(p)
                removed += 1
            except FileNotFoundError:
                continue  # a concurrent sweep may have removed it already: not worth a log line
            except Exception as err:
                log_error(f"scratch sweep skipped {name}: {err}", opts)
    except Exception as err:
        log_error(f"scratch sweep failed: {err}", opts)
    return removed


@dataclass
class ScratchListing:
    exists: bool
    entries: list[str]
    bytes: int


def _size_of(d: str) -> int:
    total = 0
    with os.scandir(d) as it:
        for e in it:
            if e.is_dir(follow_symlinks=False):
                total += _size_of(e.path)
            elif e.is_file(follow_symlinks=False):
                total += e.stat(follow_symlinks=False).st_size
    return total


def list_scratch(d: str) -> ScratchListing:
    """Read-only listing of the top-level entries (directories get a trailing `/`) and the total size of regular files."""
    try:
        st = os.lstat(d)
        if not _plain_dir(st):
            return ScratchListing(False, [], 0)
        with os.scandir(d) as it:
            entries = sorted(f"{e.name}/" if e.is_dir(follow_symlinks=False) else e.name for e in it)
        return ScratchListing(True, entries, _size_of(d))
    except OSError:
        return ScratchListing(False, [], 0)
