"""RDD mode switch (port of v9 review/mode.ts; its header holds the rationale). Review-driven development is OFF unless the user turns
it on. Two sources: a user-wide `global` value (plugin state `<dataDir>/review-mode.json`) and a clone-local override
(`<git-common-dir>/odd-plugin/review-mode.json`) that can only DISABLE. Any off wins, a clone can never force on, and every failure to
read a source resolves to off. Reads never write.

Port differences: the status is a plain dict in v9's JSON shape (`effective`, `source`, `global`, `cloneLocal`, `problems`);
`ModeOptions` extends `StateOptions` with `git_timeout_ms`; `ReviewModeError` messages that wrap an OS error carry Python's text.
"""
import errno
import os
import re
import stat as _stat
from dataclasses import dataclass
from typing import Any

from ..lib.js import JS_WS, js_json_loads, js_stringify
from ..lib.state import StateOptions, atomic_write_file, read_plugin_state, write_plugin_state
from ._paths import js_join, mkdirp
from .snapshot import SnapshotError, resolve_repository

MODE_STATE_NAME = "review-mode"
MODE_SCHEMA = "odd-claude.review-mode/v1"
CLONE_MODE_SCHEMA = "odd-claude.review-mode-override/v1"
_MAX_OVERRIDE_BYTES = 4096


@dataclass
class ModeOptions(StateOptions):
    git_timeout_ms: float | None = None


class ReviewModeError(Exception):
    pass


def clone_mode_path(common_dir: str) -> str:
    return js_join(common_dir, "odd-plugin", "review-mode.json")


def _read_global(opts: StateOptions | None) -> str:
    mode = read_plugin_state(MODE_STATE_NAME, opts).get("mode")
    return mode if mode in ("on", "off") else "unset"


def is_global_mode_on(opts: StateOptions | None = None) -> bool:
    """Fast-path guard: is the GLOBAL switch on? Unset, off, unreadable, corrupt or a wrong-version file are all "not on"."""
    return _read_global(opts) == "on"


def _plugin_dir_kind(common_dir: str) -> str:
    """The `odd-plugin` dir of a clone: absent, a real directory, or anything else (symlink, file): never followed."""
    try:
        return "dir" if _stat.S_ISDIR(os.lstat(js_join(common_dir, "odd-plugin")).st_mode) else "bad"
    except OSError as e:
        return "absent" if e.errno == errno.ENOENT else "bad"


def _read_clone(common_dir: str, problems: list[str]) -> str:
    path = clone_mode_path(common_dir)
    kind = _plugin_dir_kind(common_dir)
    if kind == "absent":
        return "unset"
    if kind == "bad":
        problems.append(f"clone-local review mode directory is not a real directory: {js_join(common_dir, 'odd-plugin')}")
        return "unreadable"
    try:
        st = os.lstat(path)
        if not _stat.S_ISREG(st.st_mode) or st.st_size > _MAX_OVERRIDE_BYTES:
            problems.append(f"clone-local review mode is not a small regular file: {path}")
            return "unreadable"
        with open(path, encoding="utf-8", errors="replace") as f:
            raw = f.read()
    except OSError as e:
        if e.errno == errno.ENOENT:
            return "unset"
        problems.append(f"clone-local review mode cannot be read: {path}")
        return "unreadable"
    try:
        v = js_json_loads(raw)
        if isinstance(v, dict) and v.get("schema") == CLONE_MODE_SCHEMA and v.get("mode") == "off":
            return "off"
    except (ValueError, RecursionError):
        pass
    problems.append(f"clone-local review mode is malformed: {path}")
    return "unreadable"


def _git_bound(opts: ModeOptions | None) -> dict:
    return {"gitTimeoutMs": getattr(opts, "git_timeout_ms", None)}


def _resolve_common_dir(cwd: str, opts: ModeOptions | None) -> str | None:
    try:
        return resolve_repository(cwd, _git_bound(opts))["commonDir"]
    except SnapshotError:
        return None


def _resolve(*parts: str) -> str:
    """Node `path.resolve` for the cases used here (absolute `parts[0]` or a later absolute part wins; `//` collapses)."""
    return re.sub(r"^/{2,}", "/", os.path.abspath(os.path.join(*parts)))


def _read_small_file(path: str) -> str | None:
    """A small regular file read without following a symlink (O_NOFOLLOW, never blocks on a FIFO); anything else is None."""
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        st = os.fstat(fd)
        if not _stat.S_ISREG(st.st_mode) or st.st_size > _MAX_OVERRIDE_BYTES:
            return None
        return os.pread(fd, st.st_size, 0).decode("utf-8", "replace")
    except OSError:
        return None
    finally:
        if fd is not None:
            os.close(fd)


def _is_dir(path: str) -> bool:
    try:
        return _stat.S_ISDIR(os.stat(path).st_mode)
    except OSError:
        return False


def _absent(path: str) -> bool:
    try:
        os.lstat(path)
        return False
    except OSError as e:
        return e.errno == errno.ENOENT


def _common_dir_of_git_file(file: str) -> str | None:
    """The common dir a `.git` FILE leads to, the way git reads it: `gitdir: <path>` (relative to the file's directory), then
    `<gitdir>/commondir` (relative to the gitdir) when present, else the gitdir itself (a submodule)."""
    text = _read_small_file(file)
    m = None if text is None else re.match(r"gitdir: ([^\r\n]+)", text)
    if m is None:
        return None
    gitdir = _resolve(os.path.dirname(file), m.group(1).rstrip(JS_WS))
    if not _is_dir(gitdir):
        return None
    marker = js_join(gitdir, "commondir")
    if _absent(marker):
        return gitdir
    raw = _read_small_file(marker)
    target = None if raw is None else raw.strip(JS_WS)
    if target is None or target == "":
        return None
    d = target if os.path.isabs(target) else _resolve(gitdir, target)
    return d if _is_dir(d) else None


def _locate_common_dir(cwd: str, opts: ModeOptions | None) -> tuple[str, str | None]:
    """Where the clone-local override lives, for READING the mode: ("found", dir), ("none", None) or ("unlocatable", None). When git
    cannot resolve (failure, timeout) or does not trust the repository, the nearest `.git` is read directly (see v9 `locateCommonDir`)."""
    try:
        return "found", resolve_repository(cwd, _git_bound(opts))["commonDir"]
    except SnapshotError as err:
        if err.code in ("bare_repository", "invalid_target"):
            return "none", None
    try:
        d = os.path.realpath(_resolve(cwd), strict=True)
    except OSError:
        return "none", None
    while True:
        dot_git = js_join(d, ".git")
        st = None
        try:
            st = os.lstat(dot_git)
        except OSError as e:
            if e.errno != errno.ENOENT:
                return "unlocatable", None
        if st is not None:
            if _stat.S_ISDIR(st.st_mode):
                return "found", dot_git
            if _stat.S_ISLNK(st.st_mode):
                try:
                    real = os.path.realpath(dot_git, strict=True)
                except OSError:
                    return "unlocatable", None
                return ("found", real) if _is_dir(real) else ("unlocatable", None)
            common = _common_dir_of_git_file(dot_git) if _stat.S_ISREG(st.st_mode) else None
            return ("found", common) if common is not None else ("unlocatable", None)
        up = os.path.dirname(d)
        if up == d:
            return "none", None
        d = up


def _resolve_status(glob: str, clone: str, problems: list[str]) -> dict:
    base: dict[str, Any] = {"global": glob, "cloneLocal": clone, "problems": problems}
    if clone in ("off", "unreadable"):
        return {**base, "effective": "off", "source": "clone-local"}
    if glob == "on":
        return {**base, "effective": "on", "source": "global"}
    if glob == "off":
        return {**base, "effective": "off", "source": "global"}
    return {**base, "effective": "off", "source": "default"}


def read_review_mode(cwd: str | None, opts: ModeOptions | None = None) -> dict:
    """Effective mode. Read-only; never raises for a missing repository or data dir (both resolve to off)."""
    problems: list[str] = []
    glob = _read_global(opts)
    clone = "n/a"
    if cwd is not None:
        kind, common = _locate_common_dir(cwd, opts)
        if kind == "found":
            clone = _read_clone(common, problems)
        elif kind == "unlocatable":
            problems.append("git failed resolving the repository and its clone-local review mode could not be located; the global switch decides")
    return _resolve_status(glob, clone, problems)


def set_review_mode(operation: str, scope: str, cwd: str | None, opts: ModeOptions | None = None) -> dict:
    """enable|disable for one scope. global: writes on|off in plugin state (needs a data dir). clone: `disable` writes the off-only
    override, `enable` clears it (the global switch then decides). Returns the resulting status."""
    if scope == "global":
        try:
            write_plugin_state(MODE_STATE_NAME, {"mode": "on" if operation == "enable" else "off"}, opts)
        except Exception as err:  # noqa: BLE001
            raise ReviewModeError(f"cannot write the global review mode: {err}") from None
        return read_review_mode(cwd, opts)
    if cwd is None:
        raise ReviewModeError("clone scope needs a repository (--cwd)")
    common = _resolve_common_dir(cwd, opts)
    if common is None:
        raise ReviewModeError(f"clone scope needs a git repository: {cwd} is not inside one")
    path = clone_mode_path(common)
    d = js_join(common, "odd-plugin")
    try:
        if operation == "disable":
            if _plugin_dir_kind(common) == "absent":
                mkdirp(d, 0o700)
            if _plugin_dir_kind(common) != "dir":
                raise OSError(f"not a real directory: {d}")
            atomic_write_file(path, js_stringify({"schema": CLONE_MODE_SCHEMA, "mode": "off"}) + "\n", 0o600)
        else:
            kind = _plugin_dir_kind(common)
            if kind == "bad":
                raise OSError(f"not a real directory: {d}")
            if kind == "dir":
                try:
                    st = os.lstat(path)
                except OSError as e:
                    if e.errno != errno.ENOENT:
                        raise
                    st = None
                if st is not None:
                    if not _stat.S_ISREG(st.st_mode):
                        raise OSError(f"not a regular file: {path}")
                    os.unlink(path)
    except OSError as err:
        raise ReviewModeError(f"cannot write the clone-local review mode: {err}") from None
    return read_review_mode(cwd, opts)
