"""Shared state-file helper (port of v9 lib/state.ts). Public API (all paths are `str`, `opts` is optional everywhere):

    STATE_SCHEMA_VERSION = 1
    StateFile                                         Pydantic envelope {version, sessionId, data}
    StateOptions(data_dir=None, env=None)             explicit data dir wins over the environment mapping
    data_dir_from_env(env=None) -> str                ODD_CLAUDE_DATA > CLAUDE_PLUGIN_DATA > ${ODD_CLAUDE_HOME:-$HOME/.odd-claude}/data
    resolve_data_dir(opts=None) -> str                same, plus: a relative dir raises "data dir must be an absolute path"
    safe_segment(id) -> str                           [^A-Za-z0-9_-] -> "_", max 128 chars, "" -> "_"
    session_state_path(session_id, opts) -> str       <dataDir>/sessions/<safe id>.json
    read_session_state(session_id, opts) -> dict      {} when missing, corrupt or another schema version (never raises)
    write_session_state(session_id, data, opts)       atomic, creates dirs, 2-space JSON + "\\n"
    read_plugin_state(name, opts) -> dict             <dataDir>/<safe name>.json, same envelope and read rules
    write_plugin_state(name, data, opts)
    update_session_state(session_id, fn, opts) -> dict  read-modify-write under a cross-process lock; raises on lock
                                                      timeout ("session state lock timeout") or another schema version;
                                                      returning the same object skips the write
    atomic_write_file(path, content, mode=None)       tmp file in the same dir + rename; mode applied with chmod
    log_error(message, opts)                          appends "<ISO-8601 ms Z> <message>" to <dataDir>/logs/hooks.log; never raises
    prune_stale_session_files(keep_id, opts, now_ms)  deletes *.json in sessions/ and status/ older than 7 days; never raises
    list_session_ids(opts) -> list[str]               session ids newest first by mtime

Data keys the code does not know are preserved: `data` is an open mapping.
"""
import json
import os
import random
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, StrictInt

from .lock import LockOptions, acquire_lock, release_owned_lock

STATE_SCHEMA_VERSION = 1

StateData = dict[str, Any]


class StateFile(BaseModel):
    """The persisted envelope. `sessionId` is optional on read (v9 only checks `version` and `data`)."""

    version: StrictInt
    sessionId: str | None = None
    data: StateData


@dataclass
class StateOptions:
    #: Explicit data dir; wins over the environment.
    data_dir: str | None = None
    #: Environment to read ODD_CLAUDE_DATA / CLAUDE_PLUGIN_DATA / ODD_CLAUDE_HOME / HOME from (defaults to os.environ).
    env: Mapping[str, str | None] | None = None


def data_dir_from_env(env: Mapping[str, str | None] | None = None) -> str:
    env = os.environ if env is None else env
    # CLAUDE_PLUGIN_DATA is legacy (removed plugin distribution; bench still sets it). An empty value counts as unset.
    explicit = env.get("ODD_CLAUDE_DATA") or env.get("CLAUDE_PLUGIN_DATA")
    if explicit:
        return explicit
    odd_home = env.get("ODD_CLAUDE_HOME") or os.path.join(env.get("HOME") or os.path.expanduser("~"), ".odd-claude")
    return os.path.join(odd_home, "data")


def resolve_data_dir(opts: StateOptions | None = None) -> str:
    opts = opts or StateOptions()
    d = opts.data_dir if opts.data_dir is not None else data_dir_from_env(opts.env)
    # A relative dir would resolve against the hook's cwd and could make scratch removal hit the project tree.
    if not os.path.isabs(d):
        raise ValueError("data dir must be an absolute path")
    return d


def safe_segment(id: str) -> str:
    # JS parity: a character outside the BMP counts as two UTF-16 units, so it becomes two underscores.
    s = "".join(c if c.isascii() and (c.isalnum() or c in "_-") else "_" * (2 if ord(c) > 0xFFFF else 1) for c in id)[:128]
    return s or "_"


def session_state_path(session_id: str, opts: StateOptions | None = None) -> str:
    return os.path.join(resolve_data_dir(opts), "sessions", f"{safe_segment(session_id)}.json")


def _plugin_state_path(name: str, opts: StateOptions | None) -> str:
    return os.path.join(resolve_data_dir(opts), f"{safe_segment(name)}.json")


def _reject_constant(name: str) -> Any:
    raise ValueError(name)  # NaN/Infinity are not JSON (v9 JSON.parse rejects them)


def _load(path: str) -> Any:
    # v9 parity: invalid UTF-8 becomes U+FFFD (not an error) and NaN/Infinity are rejected.
    with open(path, encoding="utf-8", errors="replace") as f:
        return json.loads(f.read(), parse_constant=_reject_constant)


def _is_current_version(v: Any) -> bool:
    return not isinstance(v, bool) and isinstance(v, (int, float)) and v == STATE_SCHEMA_VERSION  # 1.0 === 1 in JS


def _read_envelope(path: str) -> StateData:
    """The envelope's data, or {} when missing, corrupt, of another schema version or with a non-object `data`.
    Like v9 only `version` and `data` are checked: `sessionId` may be any type."""
    try:
        env = _load(path)
    except (OSError, ValueError):
        return {}
    if isinstance(env, dict) and _is_current_version(env.get("version")) and isinstance(env.get("data"), dict):
        return env["data"]
    return {}


def read_session_state(session_id: str, opts: StateOptions | None = None) -> StateData:
    try:
        return _read_envelope(session_state_path(session_id, opts))
    except ValueError:
        return {}


def atomic_write_file(path: str, content: str | bytes, mode: int | None = None) -> None:
    """Atomic write: temp file in the same dir as `path`, then rename. Creates the dir."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{int(time.time() * 1000)}.tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(content if isinstance(content, bytes) else content.encode("utf-8"))
        if mode is not None:
            os.chmod(tmp, mode)  # explicit chmod so the umask cannot widen or narrow it
        os.rename(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def _dump(ident: str, data: StateData) -> str:
    body = StateFile(version=STATE_SCHEMA_VERSION, sessionId=ident, data=data).model_dump()
    return json.dumps(body, indent=2, ensure_ascii=False) + "\n"


def write_session_state(session_id: str, data: StateData, opts: StateOptions | None = None) -> None:
    atomic_write_file(session_state_path(session_id, opts), _dump(session_id, data))


def read_plugin_state(name: str, opts: StateOptions | None = None) -> StateData:
    """Plugin-wide (non-session) state at <dataDir>/<name>.json, e.g. `setup`. Same envelope and read rules."""
    try:
        return _read_envelope(_plugin_state_path(name, opts))
    except ValueError:
        return {}


def write_plugin_state(name: str, data: StateData, opts: StateOptions | None = None) -> None:
    atomic_write_file(_plugin_state_path(name, opts), _dump(name, data))


def _assert_schema_matches(path: str) -> None:
    """Raises when the file exists with another schema version: an update would silently destroy it. Missing or corrupt files pass."""
    try:
        raw = _load(path)
    except (OSError, ValueError):
        return
    version = raw.get("version", None) if isinstance(raw, dict) and "version" in raw else None
    if isinstance(raw, dict) and "version" in raw and not _is_current_version(version):
        shown = version if isinstance(version, str) else json.dumps(version)
        raise ValueError(f"session state has schema version {shown}; refusing to overwrite")


LOCK_WAIT_MS = 1000
LOCK_STALE_MS = 2000


def update_session_state(
    session_id: str, update: Callable[[StateData], StateData], opts: StateOptions | None = None
) -> StateData:
    """Read-modify-write under a short cross-process lock (`<session>.json.lock`, shared lock semantics), so parallel
    hook processes neither lose counts nor double-fire a once-per-turn notice. Spins up to ~1s; on timeout it raises and
    the caller fails open. Returning the same object skips the write."""
    path = session_state_path(session_id, opts)
    lock = f"{path}.lock"
    deadline = time.time() + LOCK_WAIT_MS / 1000
    while not acquire_lock(lock, os.getpid(), LockOptions(stale_ms=LOCK_STALE_MS, proof_of_death_only=True)):
        if time.time() >= deadline:
            raise TimeoutError("session state lock timeout")
        time.sleep((3 + random.random() * 5) / 1000)  # jitter so backing-off takeover claimants do not retry in lockstep
    try:
        _assert_schema_matches(path)
        current = read_session_state(session_id, opts)
        nxt = update(current)
        if nxt is not current:
            write_session_state(session_id, nxt, opts)
        return nxt
    finally:
        release_owned_lock(lock, os.getpid())


def log_error(message: str, opts: StateOptions | None = None) -> None:
    """Appends one line to <dataDir>/logs/hooks.log. Never raises."""
    try:
        d = os.path.join(resolve_data_dir(opts), "logs")
        os.makedirs(d, exist_ok=True)
        ts = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with open(os.path.join(d, "hooks.log"), "a", encoding="utf-8") as f:
            f.write(f"{ts} {message.replace(chr(10), ' ')}\n")
    except Exception:
        pass  # logging must never break a hook


PRUNE_AGE_MS = 7 * 86_400_000


def prune_stale_session_files(keep_id: str, opts: StateOptions | None = None, now: float | None = None) -> None:
    """Deletes `*.json` in sessions/ and status/ older than 7 days (mtime), never `keep_id`'s nor one with a `.lock` beside it."""
    now = time.time() * 1000 if now is None else now
    for sub in ("sessions", "status"):
        try:
            d = os.path.join(resolve_data_dir(opts), sub)
            for f in os.listdir(d):
                if not f.endswith(".json") or f == f"{safe_segment(keep_id)}.json":
                    continue
                try:
                    p = os.path.join(d, f)
                    if now - os.stat(p).st_mtime_ns / 1e6 > PRUNE_AGE_MS and not os.path.exists(f"{p}.lock"):
                        os.unlink(p)
                except OSError:
                    pass  # vanished or unreadable: leave it
        except (OSError, ValueError):
            pass  # missing dir


def list_session_ids(opts: StateOptions | None = None) -> list[str]:
    """Session ids (file stems) newest first by mtime; [] when the dir is missing. Read-only."""
    try:
        d = os.path.join(resolve_data_dir(opts), "sessions")
        entries = [(f[: -len(".json")], os.stat(os.path.join(d, f)).st_mtime_ns) for f in os.listdir(d) if f.endswith(".json")]
        return [i for i, _ in sorted(entries, key=lambda e: (-e[1], e[0]))]
    except (OSError, ValueError):
        return []
