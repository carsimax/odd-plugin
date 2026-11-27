"""In-flight lock for detached background jobs and session-state updates (port of v9 lib/lock.ts).

A lock is a file `<dataDir>/locks/<kind>-<sha1(project)[:16]>.lock` holding `{"pid", "startedAt"}` (ms). It is created
atomically WITH content (unique temp file, then `os.link`: EEXIST means contended). An unreadable/empty lock is stale only
when its mtime is older than `stale_ms`. A held lock is stale when its pid is dead, or (unless `proof_of_death_only`)
older than `stale_ms`. Takeover is claim-based (see `_take_over`). Public API: `LockOptions`, `lock_path`, `acquire_lock`,
`release_owned_lock`, `set_lock_pid`, `release_lock`. None of them raises.
"""
import contextlib
import hashlib
import json
import os
import time
import uuid
from dataclasses import dataclass
from typing import Callable

from .pid import is_pid_alive

_MISSING = object()
MAX_STALE_SWEEP = 32


@dataclass
class LockOptions:
    stale_ms: float
    now: Callable[[], float] | None = None
    is_alive: Callable[[object], bool] | None = None
    #: When true a lock whose pid is alive is never stale by age (only a dead pid, or an unreadable old file, is).
    proof_of_death_only: bool = False


def _now_ms() -> int:
    return int(time.time() * 1000)


def _rand() -> str:
    return uuid.uuid4().hex[:10]


def _rm(path: str) -> None:
    with contextlib.suppress(FileNotFoundError):
        os.unlink(path)


def _mtime_ms(path: str) -> float:
    return os.stat(path).st_mtime_ns / 1e6


def lock_path(data_dir: str, kind: str, project: str) -> str:
    key = hashlib.sha1(os.path.abspath(project).encode()).hexdigest()[:16]
    return os.path.join(data_dir, "locks", f"{kind}-{key}.lock")


def _is_num(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _reject_constant(name: str) -> object:
    raise ValueError(name)  # NaN/Infinity are not JSON: v9 JSON.parse treats such a lock as unreadable


def _parse_lock(raw: str) -> tuple[float, float] | None:
    """(pid, startedAt) or None when missing/corrupt (the caller treats an existing file as stale by mtime)."""
    try:
        v = json.loads(raw, parse_constant=_reject_constant)
        if isinstance(v, dict) and _is_num(v.get("pid")) and _is_num(v.get("startedAt")):
            return v["pid"], v["startedAt"]
    except ValueError:
        pass
    return None


def _read_lock(path: str) -> tuple[float, float] | None:
    try:
        return _parse_lock(_read(path))
    except (OSError, ValueError):
        return None


def _read(path: str) -> str:
    # errors="replace": a non-UTF-8 lock is unreadable content (stale by mtime), not an error (v9 parity)
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def _write(path: str, content: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def _take_over(path: str, stale_raw: str, alive: Callable[[object], bool], stale_ms: float) -> bool:
    """Removes the stale lock `stale_raw` WITHOUT any move->check->restore step (a restore leaves a window with no lock
    file in which a third process can create one). Exclusivity comes from claims: every contender that judged the lock
    stale publishes its own uniquely named claim `<lock>.claim-<id>` and only proceeds when it is the ONLY live claimant.
    Claims of dead pids, and unreadable claims older than `stale_ms`, are swept. The sole claimant re-reads the lock: only
    when it is still exactly `stale_raw` is it moved away; the moved content is verified, and a fresh lock found there is
    linked back (never deleted). Returns True when the caller may retry the create; False to back off."""
    d = os.path.dirname(path)
    prefix = f"{os.path.basename(path)}.claim-"
    mine = f"{path}.claim-{os.getpid()}-{_rand()}"
    try:
        _write(mine, json.dumps({"pid": os.getpid()}, separators=(",", ":")))
        for name in os.listdir(d):
            other = os.path.join(d, name)
            if not name.startswith(prefix) or other == mine:
                continue
            claimant: object = _MISSING
            try:
                v = json.loads(_read(other), parse_constant=_reject_constant)
                if not isinstance(v, dict):
                    raise ValueError("not an object")
                claimant = v.get("pid", _MISSING)
            except (OSError, ValueError):
                # empty/partial claim: its owner may be mid-write (fresh) or was killed between create and write (old)
                try:
                    if time.time() * 1000 - _mtime_ms(other) > stale_ms:
                        _rm(other)  # unique name, unreadable and older than stale_ms: abandoned
                        continue
                except OSError:
                    continue  # vanished
            if claimant is not _MISSING and not alive(claimant):
                _rm(other)  # unique name + dead owner: nobody can be using it
                continue
            return False  # another live claimant is taking this lock over
        try:
            current = _read(path)
        except OSError:
            return True  # already gone: the next create attempt decides
        if current != stale_raw:
            return False  # replaced by a fresh lock: not ours to remove
        stale = f"{path}.{os.getpid()}.{_rand()}.stale"
        try:
            os.rename(path, stale)
        except OSError:
            return True
        moved: str | None = None
        with contextlib.suppress(OSError, ValueError):
            moved = _read(stale)
        if moved == stale_raw:
            _rm(stale)
            return True
        # The holder released and somebody created a fresh lock after our re-read: never delete or acquire over it.
        # Give it back without clobbering (link fails with EEXIST if the path is occupied again; then it stays aside).
        with contextlib.suppress(OSError):
            os.link(stale, path)
            _rm(stale)
        return False
    except Exception:
        return False
    finally:
        _rm(mine)


def _sweep_stale_leftovers(path: str, alive: Callable[[object], bool], stale_ms: float) -> None:
    """Best-effort, bounded sweep of `<lock>.*.stale` leftovers (a fresh lock moved aside that could not be linked back).
    Removed only when its record's pid is dead, or it is unreadable/empty and older than `stale_ms`."""
    try:
        d, prefix, seen = os.path.dirname(path), f"{os.path.basename(path)}.", 0
        for name in os.listdir(d):
            if not name.startswith(prefix) or not name.endswith(".stale"):
                continue
            seen += 1
            if seen > MAX_STALE_SWEEP:
                return
            f = os.path.join(d, name)
            try:
                held = _parse_lock(_read(f))
                if held:
                    if not alive(held[0]):
                        _rm(f)
                elif time.time() * 1000 - _mtime_ms(f) > stale_ms:
                    _rm(f)
            except (OSError, ValueError):
                pass  # vanished or unreadable: leave it
    except Exception:
        pass


def _create_exclusive(path: str, content: str) -> bool:
    """Creates `path` atomically with its content: write a unique temp file, then link it (EEXIST = held)."""
    tmp = f"{path}.{os.getpid()}.{_rand()}.tmp"
    try:
        _write(tmp, content)
        os.link(tmp, path)
        return True
    except FileExistsError:
        return False
    finally:
        _rm(tmp)


def acquire_lock(path: str, pid: int, opts: LockOptions) -> bool:
    """True when this caller now owns the lock; False when a live, fresh lock is held. Never raises."""
    now = opts.now or _now_ms
    alive = opts.is_alive or is_pid_alive
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        for attempt in range(2):
            try:
                if _create_exclusive(path, json.dumps({"pid": pid, "startedAt": now()}, separators=(",", ":"))):
                    return True
            except Exception:
                return False
            if attempt == 0:
                _sweep_stale_leftovers(path, alive, opts.stale_ms)
            try:
                raw = _read(path)
            except OSError:
                continue  # vanished between link and read: retry the create
            except ValueError:
                raw = ""
            held = _parse_lock(raw)
            if held:
                # Proof of death only: a live pid is never taken over by age alone.
                if alive(held[0]) and (opts.proof_of_death_only or now() - held[1] <= opts.stale_ms):
                    return False
            else:
                # Unreadable or empty: stale only by file mtime (real clock), never immediately.
                try:
                    mtime = _mtime_ms(path)
                except OSError:
                    continue
                if time.time() * 1000 - mtime <= opts.stale_ms:
                    return False
            if not _take_over(path, raw, alive, opts.stale_ms):
                return False
    except Exception:
        pass  # fail safe: no lock means no spawn
    return False


def release_owned_lock(path: str, pid: int) -> None:
    """Removes the lock only when `pid` owns it; never leaves a marker. For callers with no handoff. Never raises."""
    try:
        held = _read_lock(path)
        if held is not None and held[0] == pid:
            _rm(path)
    except Exception:
        pass


def _done_marker(path: str, pid: int) -> str:
    return f"{path}.done-{pid}"


def set_lock_pid(path: str, pid: int, now: Callable[[], float] | None = None) -> None:
    """Hands the lock over to the real worker pid (the launcher took it with its own pid first). When the worker already
    finished (it left a done marker because it could not release a lock it did not own yet), the lock is removed instead."""
    try:
        marker = _done_marker(path, pid)

        def finished() -> bool:
            try:
                _read(marker)
                _rm(marker)
                _rm(path)
                return True
            except OSError:
                return False

        if finished():
            return
        tmp = f"{path}.{os.getpid()}.{_rand()}.tmp"
        _write(tmp, json.dumps({"pid": pid, "startedAt": (now or _now_ms)()}, separators=(",", ":")))
        os.replace(tmp, path)  # atomic replace: readers never see a partial lock
        finished()  # the worker may have finished while we wrote
    except Exception:
        pass


def release_lock(path: str, pid: int) -> None:
    """Removes the lock when `pid` owns it. When the lock still holds the launcher's pid (handoff not done yet), leaves a
    done marker so `set_lock_pid` removes the lock instead of handing it to a finished process. Never raises."""
    try:
        held = _read_lock(path)
        if held is None:
            return
        if held[0] == pid:
            _rm(path)
            return
        _write(_done_marker(path, pid), "")
        again = _read_lock(path)
        if again is not None and again[0] == pid:
            _rm(path)
            _rm(_done_marker(path, pid))
    except Exception:
        pass
