"""Stable machine identity for the review store lock (port of v9 review/machine-id.ts).

A random UUID persisted at `${XDG_STATE_HOME:-~/.local/state}/odd-plugin/machine-id` (mode 0600, created with write-temp +
link(2): exactly one concurrent creator wins, the file is never replaced). NEVER derived from network values. Every failure
(unreadable, corrupt, oversized, symlink, no home) yields None: callers fall back to hostname-only behavior. Nothing here
raises. Public API: `MACHINE_ID_RE`, `is_machine_id`, `state_home`, `load_machine_id`, `machine_id`.
"""
import errno
import os
import pwd
import re
import stat
import time
import uuid
from typing import Mapping

from ._paths import js_join, mkdirp

MACHINE_ID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_MAX_BYTES = 128


def is_machine_id(v: object) -> bool:
    return isinstance(v, str) and MACHINE_ID_RE.fullmatch(v) is not None


def _homedir() -> str | None:
    h = os.environ.get("HOME")
    if h is None:
        try:
            h = pwd.getpwuid(os.getuid()).pw_dir
        except (KeyError, OSError):
            return None
    return h or None


def state_home(env: Mapping[str, str | None] | None = None) -> str | None:
    """The state home: absolute XDG_STATE_HOME, else ~/.local/state. None when neither is usable."""
    x = (os.environ if env is None else env).get("XDG_STATE_HOME")
    if x and os.path.isabs(x):
        return x
    h = _homedir()
    return js_join(h, ".local", "state") if h else None


# "linked": the ONLY defect is nlink > 1. The creator briefly has two names (link(2) then unlink of the temp), so this is
# transient for a racing reader; a persistent hardlink stays bad after the bounded retry.
_LINK_RETRIES = 20
_LINK_RETRY_S = 0.005


def _read_id_settled(file: str) -> tuple[str, str | None]:
    """_read_id that waits (bounded: 20 x 5 ms) while the only defect is the creator's transient second link."""
    r = _read_id(file)
    for _ in range(_LINK_RETRIES):
        if r[0] != "linked":
            break
        time.sleep(_LINK_RETRY_S)
        r = _read_id(file)
    return r


def _read_id(file: str) -> tuple[str, str | None]:
    """("ok", id) | ("absent", None) | ("bad", None) | ("linked", None)."""
    try:
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as e:
        return ("absent", None) if e.errno == errno.ENOENT else ("bad", None)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > _MAX_BYTES:
            return ("bad", None)
        if st.st_nlink > 1:
            return ("linked", None)
        buf = b""
        while True:
            chunk = os.read(fd, _MAX_BYTES + 1 - len(buf))
            if not chunk:
                break
            buf += chunk
            if len(buf) > _MAX_BYTES:
                return ("bad", None)
        text = buf.decode("utf-8", "replace")
        text = text[:-1] if text.endswith("\n") else text
        return ("ok", text) if is_machine_id(text) else ("bad", None)
    except OSError:
        return ("bad", None)
    finally:
        os.close(fd)


def load_machine_id(state_dir: str) -> str | None:
    """Reads (creating it atomically on first use) the machine id under `state_dir`. None = unavailable."""
    try:
        dir_ = js_join(state_dir, "odd-plugin")
        mkdirp(dir_, 0o700)
        if not stat.S_ISDIR(os.lstat(dir_).st_mode):
            return None  # a symlinked dir is never followed
        file = js_join(dir_, "machine-id")
        kind, id_ = _read_id_settled(file)
        if kind == "ok":
            return id_
        if kind in ("bad", "linked"):
            return None
        tmp = f"{file}.tmp-{uuid.uuid4()}"
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                os.write(fd, f"{uuid.uuid4()}\n".encode())
                os.fsync(fd)
            finally:
                os.close(fd)
            try:
                os.link(tmp, file)  # atomic, fails with EEXIST when another process won
            except OSError as e:
                if e.errno != errno.EEXIST:
                    return None
        finally:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
        kind, id_ = _read_id_settled(file)
        return id_ if kind == "ok" else None
    except Exception:
        return None


_cached: tuple[str] | None = None


def machine_id() -> str | None:
    """The machine id for this process, resolved once. Only a SUCCESS is cached: a failure (transient race, unreadable
    home) is retried by the next acquire, so a transient error never pins hostname-only for the whole process."""
    global _cached
    if _cached is not None:
        return _cached[0]
    home = state_home()
    value = load_machine_id(home) if home else None
    if value is not None:
        _cached = (value,)
    return value
