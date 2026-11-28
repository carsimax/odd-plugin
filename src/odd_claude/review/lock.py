"""Exclusive store lock for the review authority store `<git-common-dir>/odd-plugin/review-transactions/v2/` (port of v9
review/lock.ts; read that file's header for the full protocol rationale, which this port keeps unchanged).

The lock is a DIRECTORY `<root>/LOCK` that always contains `owner.json`: published as `LOCK.tmp-<ownerId>` then renamed to
`LOCK` (rename onto a non-empty directory fails, so exactly one contender wins). Release is by owner token (rename away, then
remove). Stale takeover needs PROOF: same machine AND kill(pid, 0) -> ESRCH, never by age for a readable record; an
unreadable/empty record (or a lock that is not a directory) is stale only when older than `stale_unreadable_ms`. Takeover
exclusivity comes from per-contender claims `LOCK.claim-<ownerId>`: only the sole live claimant moves the stale `LOCK` away.
There is NO move->check->restore path except the documented foreign-tamper put-back. Unexpected FS errors raise
`StoreLockError` (fail closed); a wait past the bounded budget raises `StoreLockContended`. Leftovers of a kill -9
(`LOCK.tmp-*`, `LOCK.stale-*`, `LOCK.release-*`, dead `LOCK.claim-*`) are swept best-effort at acquire time, bounded.
Machine identity: the owner record carries `host`, `machine` (machine_id.py) and `boot` (boot_id.py). The owner is local by id
only when BOTH sides have machine AND boot ids and both are equal; in every other case the hostname rule applies.

Python port differences: synchronous (`acquire_store_lock` sleeps with `time.sleep`; `with_store_lock` takes a plain
callable); the fault-injection seams are the module's `os.rename`/`os.mkdir`/`os.open`/`os.listdir` calls and `_rm_rf`.
Public API: `START_LOCK_TIMEOUT_MS`, `START_LOCK_POLL_MS`, `UNREADABLE_STALE_MS`, `StoreLockOwner`, `StoreLockOptions`,
`StoreLockHandle`, `StoreLockBlocker`, `StoreLockContended`, `StoreLockError`, `store_lock_path`, `acquire_store_lock`,
`with_store_lock`. On disk the owner record keeps v9's keys: pid, host, machine?, boot?, ownerId, startedAt.
"""
import errno
import math
import os
import random
import re
import secrets
import shutil
import socket
import stat
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, NoReturn, TypeVar

from ..lib.js import js_json_loads, js_number_to_string, js_stringify
from ..lib.pid import pid_state
from ._paths import js_join, mkdirp
from .boot_id import boot_id as process_boot
from .boot_id import is_boot_id
from .machine_id import is_machine_id
from .machine_id import machine_id as process_machine_id

_OWNER_FILE = "owner.json"
START_LOCK_TIMEOUT_MS = 2_000  # Go compactStartLockTimeout
START_LOCK_POLL_MS = 25  # Go compactStartLockPoll
UNREADABLE_STALE_MS = 30_000
_MAX_OWNER_BYTES = 4096
_SWEEP_LIMIT = 64

T = TypeVar("T")
_UNSET: Any = object()


@dataclass
class StoreLockOwner:
    pid: int
    host: str
    owner_id: str
    started_at: float
    #: Stable machine id (None in records written by older versions or when no id could be loaded).
    machine: str | None = None
    #: Boot + pid-namespace identity (None when unavailable or in older records).
    boot: str | None = None

    def to_json(self) -> str:
        d: dict[str, Any] = {"pid": self.pid, "host": self.host}
        if self.machine:
            d["machine"] = self.machine
        if self.boot:
            d["boot"] = self.boot
        d["ownerId"] = self.owner_id
        d["startedAt"] = self.started_at
        return js_stringify(d)


@dataclass
class StoreLockOptions:
    timeout_ms: float | None = None
    poll_ms: float | None = None
    #: An unreadable owner record older than this (mtime) is stale.
    stale_unreadable_ms: float | None = None
    #: Test seams. `host` given (without machine_id/boot_id) means hostname-only.
    host: str | None = None
    #: Machine id seam: a UUID, or None for hostname-only. Left unset: `host` given means hostname-only, else the persisted id.
    machine_id: Any = _UNSET
    #: Boot identity seam, same semantics as `machine_id`.
    boot_id: Any = _UNSET
    now: Callable[[], float] | None = None
    is_process_dead: Callable[[int], bool] | None = None


@dataclass
class StoreLockReleaseResult:
    status: Literal["released", "not-owner", "absent"]


@dataclass
class StoreLockHandle:
    path: str
    owner_id: str
    owner: StoreLockOwner
    _release: Callable[[], StoreLockReleaseResult] = field(repr=False, default=lambda: StoreLockReleaseResult("absent"))

    def release(self) -> StoreLockReleaseResult:
        """Releases only when this handle's token still owns the lock; otherwise a no-op with a typed result."""
        return self._release()


@dataclass
class StoreLockBlocker:
    #: `lock`: LOCK itself is held. `reclaim`: LOCK is stale but another live contender is taking it over.
    kind: Literal["lock", "reclaim"]
    owner: StoreLockOwner | None = None


class StoreLockContended(Exception):
    """Another holder keeps the store lock past the bounded wait. Not a CAS failure and not an FS error."""

    code = "STORE_LOCK_CONTENDED"

    def __init__(self, path: str, waited_ms: float, blocker: StoreLockBlocker | None = None):
        o = blocker.owner if blocker else None
        who = ""
        if o:
            extra = f" (machine {o.machine[:8]}{f', boot {o.boot[:8]}' if o.boot else ''})" if o.machine else ""
            who = f" by pid {js_number_to_string(o.pid)} on {o.host}{extra}"
        what = "a stale review store lock is being reclaimed" if blocker and blocker.kind == "reclaim" else "review store lock is held"
        super().__init__(f"{what}{who} (waited {math.floor(waited_ms + 0.5)} ms): {path}")
        self.path = path
        self.waited_ms = waited_ms
        self.blocker = blocker
        #: The record of whoever actually blocks us (lock holder or live reclaimer), when readable.
        self.owner = o


class StoreLockError(Exception):
    """Unexpected filesystem failure: ownership is unknown, never assumed."""

    code = "STORE_LOCK_ERROR"


def store_lock_path(store_root: str) -> str:
    return js_join(store_root, "LOCK")


@dataclass
class _Config:
    host: str
    machine: str | None
    boot: str | None
    now: Callable[[], float]
    is_dead: Callable[[int], bool]
    stale_unreadable_ms: float


@dataclass
class _Observed:
    kind: Literal["absent", "record", "unreadable"]
    record: StoreLockOwner | None = None
    identity: str = ""
    ino: str = ""
    mtime_ms: float = 0


_ABSENT = _Observed("absent")


def _rethrow(e: Exception, what: str) -> NoReturn:
    """Raises a StoreLock* as is, anything else wrapped in a StoreLockError (cause kept)."""
    if isinstance(e, (StoreLockError, StoreLockContended)):
        raise e
    raise StoreLockError(f"{what}: {e}") from e


def _process_dead(pid: int) -> bool:
    return pid_state(pid) == "dead"  # EPERM = alive; invalid or any other error = no proof


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_record(cfg: _Config) -> StoreLockOwner:
    return StoreLockOwner(pid=os.getpid(), host=cfg.host, machine=cfg.machine or None, boot=cfg.boot or None, owner_id=secrets.token_hex(16), started_at=cfg.now())


def _parse_owner(raw: str) -> StoreLockOwner | None:
    try:
        v = js_json_loads(raw)
    except ValueError:
        return None
    if not isinstance(v, dict):
        return None
    pid, host, owner_id, started = v.get("pid"), v.get("host"), v.get("ownerId"), v.get("startedAt")
    is_num = lambda x: isinstance(x, (int, float)) and not isinstance(x, bool)  # noqa: E731
    if not (is_num(pid) and float(pid).is_integer() and pid > 0 and isinstance(host, str) and host != ""
            and isinstance(owner_id, str) and owner_id != "" and is_num(started)):  # fmt: skip
        return None
    # An invalid `machine` is ignored: the record then follows the hostname rule.
    m, b = v.get("machine"), v.get("boot")
    return StoreLockOwner(pid=int(pid), host=host, owner_id=owner_id, started_at=started, machine=m if is_machine_id(m) else None, boot=b if is_boot_id(b) else None)


def _lstat_or_none(path: str) -> os.stat_result | None:
    try:
        return os.lstat(path)
    except OSError as e:
        if e.errno == errno.ENOENT:
            return None
        raise


def _rm_rf(path: str) -> None:
    """`rmSync(path, {recursive: true, force: true})`: removes a file, a symlink (not followed) or a tree; missing is fine."""
    st = _lstat_or_none(path)
    if st is None:
        return
    if stat.S_ISDIR(st.st_mode):
        shutil.rmtree(path)
    else:
        os.unlink(path)


def _readdir(path: str) -> list[str]:
    return sorted(os.listdir(path))  # libuv's scandir (readdirSync) is bytewise sorted


def _publish(path: str, record: StoreLockOwner) -> bool:
    """Atomically creates directory `path` WITH its owner record. False = already held (contended)."""
    tmp = f"{path}.tmp-{record.owner_id}"
    try:
        os.mkdir(tmp, 0o700)
        fd = os.open(js_join(tmp, _OWNER_FILE), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, record.to_json().encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
        # rename(2) would silently replace an EMPTY directory (foreign/corrupt): never treat that as acquired.
        # Real contenders always leave a non-empty LOCK, which the rename itself rejects atomically.
        if _lstat_or_none(path) is not None:
            return False
        try:
            os.rename(tmp, path)
            return True
        except OSError as e:
            if e.errno in (errno.EEXIST, errno.ENOTEMPTY):
                return False
            raise
    finally:
        _rm_rf(tmp)


def _read_owner_file(file: str) -> tuple[str | None, float] | None:
    """Reads owner.json without ever blocking or following a link: O_NOFOLLOW|O_NONBLOCK, then fstat must say regular file,
    and at most _MAX_OWNER_BYTES are read. Anything else (FIFO, device, symlink, oversized) is unreadable (text None).
    None = no such file."""
    try:
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as e:
        if e.errno == errno.ENOENT:
            return None
        if e.errno in (errno.ELOOP, errno.EMLINK, errno.ENXIO):
            return (None, 0.0)
        raise
    try:
        st = os.fstat(fd)
        mtime = st.st_mtime_ns / 1e6
        if not stat.S_ISREG(st.st_mode) or st.st_size > _MAX_OWNER_BYTES:
            return (None, mtime)
        buf = b""
        while True:
            chunk = os.read(fd, _MAX_OWNER_BYTES + 1 - len(buf))
            if not chunk:
                break
            buf += chunk
            if len(buf) > _MAX_OWNER_BYTES:
                return (None, mtime)
        return (buf.decode("utf-8", "replace"), mtime)
    finally:
        os.close(fd)


def _observe(path: str) -> _Observed:
    st = _lstat_or_none(path)  # a symlink is never followed: it is "unreadable"
    if st is None:
        return _ABSENT
    ino = f"ino:{st.st_dev}:{st.st_ino}"
    st_mtime = st.st_mtime_ns / 1e6
    if not stat.S_ISDIR(st.st_mode):
        return _Observed("unreadable", mtime_ms=st_mtime, identity=ino, ino=ino)
    read = _read_owner_file(js_join(path, _OWNER_FILE))
    mtime = max(st_mtime, read[1]) if read else st_mtime
    if not read or read[0] is None:
        return _Observed("unreadable", mtime_ms=mtime, identity=ino, ino=ino)
    record = _parse_owner(read[0])
    if not record:
        return _Observed("unreadable", mtime_ms=mtime, identity=ino, ino=ino)
    return _Observed("record", record=record, identity=record.owner_id, ino=ino, mtime_ms=mtime)


def _is_local(record: StoreLockOwner, cfg: _Config) -> bool:
    """Local by id needs machine AND boot identity on both sides, all equal; anything else is the hostname rule."""
    if record.machine is not None and cfg.machine is not None and record.machine == cfg.machine \
            and record.boot is not None and cfg.boot is not None and record.boot == cfg.boot:  # fmt: skip
        return True
    return record.host == cfg.host


def _is_stale(o: _Observed, cfg: _Config) -> bool:
    """Stale only with proof: dead owner on this machine, or an unreadable record that is old."""
    if o.kind == "record":
        assert o.record is not None
        return _is_local(o.record, cfg) and cfg.is_dead(o.record.pid)
    if o.kind == "unreadable":
        return cfg.now() - o.mtime_ms > cfg.stale_unreadable_ms
    return False


def _move_away(store_root: str, path: str, expected: _Observed, mine_name: str, cfg: _Config) -> tuple[bool, StoreLockOwner | None]:
    """Moves the stale instance `expected` away and removes it. Only called by the sole live claimant. No restore."""
    if expected.kind == "absent":
        return (True, None)
    # Re-list the claims immediately before the move: if claim exclusivity was ever broken (a listing that omitted a
    # live claim), another claimant may already have taken over, so the entry at LOCK could be a LIVE lock. Back off.
    others = _live_claims(store_root, mine_name, cfg)
    if others == "unknown":
        return (False, None)
    if others:
        return (False, others[0])
    reserved = f"{path}.stale-{secrets.token_hex(8)}"
    try:
        os.rename(path, reserved)
    except OSError as e:
        if e.errno == errno.ENOENT:
            return (True, None)
        raise
    moved = _observe(reserved)
    # A concurrent sweep may have removed the stale instance we just moved: it is gone either way, retry the acquire.
    if moved.kind == "absent":
        return (True, None)
    # Same directory inode = the very instance judged stale (rename preserves it). sweep() removes owner.json BEFORE the
    # directory, so a record that turned unreadable in place is that same dead owner being swept, not a foreign entry.
    same = moved.ino == expected.ino and (moved.identity == expected.identity or (expected.kind == "record" and moved.kind == "unreadable"))
    if same:
        _rm_rf(reserved)
        return (True, None)
    # Genuine mismatch (only under foreign tampering): never strand a possibly live record. Put it back with a
    # check-then-rename (rename(2) cannot refuse an EMPTY directory target; same window as publish) when LOCK is free.
    if _lstat_or_none(path) is None:
        try:
            os.rename(reserved, path)
            return (False, None)  # restored: the caller backs off and re-judges what is at LOCK now
        except OSError as e:
            if e.errno not in (errno.EEXIST, errno.ENOTEMPTY):
                raise
    raise StoreLockError(f"review store lock changed during an exclusive takeover and LOCK is taken (kept at {reserved})")


def _release_dir(path: str, owner_id: str) -> StoreLockReleaseResult:
    o = _observe(path)
    if o.kind == "absent":
        return StoreLockReleaseResult("absent")
    if o.kind != "record" or o.record is None or o.record.owner_id != owner_id:
        return StoreLockReleaseResult("not-owner")
    reserved = f"{path}.release-{owner_id}"
    try:
        os.rename(path, reserved)
    except OSError as e:
        if e.errno == errno.ENOENT:
            return StoreLockReleaseResult("absent")
        raise
    moved = _observe(reserved)
    if moved.kind != "record" or moved.record is None or moved.record.owner_id != owner_id:
        raise StoreLockError(f"review store lock changed during release (kept at {reserved})")
    try:
        _rm_rf(reserved)  # the rename already released the lock; this is cleanup
    except Exception:
        pass  # inert leftover
    return StoreLockReleaseResult("released")


_CLAIM_RE = re.compile(r"LOCK\.claim-[0-9a-f]{32}")


def _is_claim(name: str) -> bool:
    return _CLAIM_RE.fullmatch(name) is not None


def _live_claims(store_root: str, mine: str, cfg: _Config) -> list[StoreLockOwner] | Literal["unknown"]:
    """Live claims other than `mine`. Dead claims (unique names, dead owner: no ABA) are removed on the way."""
    live: list[StoreLockOwner] = []
    unknown = False
    for name in _readdir(store_root):
        if not _is_claim(name) or name == mine:
            continue
        path = js_join(store_root, name)
        o = _observe(path)
        if o.kind == "absent":
            continue
        if _is_stale(o, cfg):
            gone = f"{path}.stale-{secrets.token_hex(8)}"
            try:
                os.rename(path, gone)
            except OSError as e:
                if e.errno == errno.ENOENT:
                    continue
                raise
            try:
                _rm_rf(gone)
            except Exception:
                pass  # swept later
            continue
        if o.kind == "record" and o.record is not None:
            live.append(o.record)
        else:
            unknown = True
    return live if live else ("unknown" if unknown else [])


def _reclaim(store_root: str, lock: str, seen: _Observed, cfg: _Config) -> tuple[bool, StoreLockOwner | None]:
    """Takeover of a stale lock by the sole live claimant. (True, _): retry the publish."""
    me = _new_record(cfg)
    mine_name = f"LOCK.claim-{me.owner_id}"
    mine = js_join(store_root, mine_name)
    if not _publish(mine, me):
        raise StoreLockError(f"review store lock claim already exists: {mine}")
    try:
        others = _live_claims(store_root, mine_name, cfg)  # we published first: two contenders can't both be alone
        if others == "unknown":
            return (False, None)
        if others:
            return (False, others[0])
        now = _observe(lock)
        if now.kind == "absent":
            return (True, None)
        if seen.kind == "absent" or now.identity != seen.identity or not _is_stale(now, cfg):
            return (False, None)
        return _move_away(store_root, lock, now, mine_name, cfg)
    finally:
        _release_dir(mine, me.owner_id)


def _sweep(store_root: str, cfg: _Config) -> None:
    """Bounded best-effort removal of crash leftovers whose owner is provably dead (or unreadable and old). Never LOCK."""
    try:
        names = [n for n in _readdir(store_root) if n.startswith("LOCK.")][:_SWEEP_LIMIT]
        for name in names:
            try:
                path = js_join(store_root, name)
                o = _observe(path)
                if o.kind == "absent" or not stat.S_ISDIR(os.lstat(path).st_mode):
                    continue
                if _is_stale(o, cfg):
                    _rm_rf(path)
            except Exception:
                pass  # best effort
    except Exception:
        pass  # best effort


def _resolve_machine(options: StoreLockOptions) -> str | None:
    if options.machine_id is not _UNSET:
        return options.machine_id if is_machine_id(options.machine_id) else None
    if options.host is not None:
        return None  # a faked hostname is a faked machine: never the real id
    return process_machine_id()


def _resolve_boot(options: StoreLockOptions) -> str | None:
    if options.boot_id is not _UNSET:
        return options.boot_id if is_boot_id(options.boot_id) else None
    if options.host is not None:
        return None
    return process_boot()


def acquire_store_lock(store_root: str, options: StoreLockOptions | None = None) -> StoreLockHandle:
    """Acquires the exclusive store lock, waiting up to `timeout_ms`. Raises StoreLockContended or StoreLockError."""
    options = options or StoreLockOptions()
    cfg = _Config(
        host=options.host if options.host is not None else socket.gethostname(),
        machine=_resolve_machine(options),
        boot=_resolve_boot(options),
        now=options.now or _now_ms,
        is_dead=options.is_process_dead or _process_dead,
        stale_unreadable_ms=options.stale_unreadable_ms if options.stale_unreadable_ms is not None else UNREADABLE_STALE_MS,
    )
    timeout_ms = options.timeout_ms if options.timeout_ms is not None else START_LOCK_TIMEOUT_MS
    poll_ms = options.poll_ms if options.poll_ms is not None else START_LOCK_POLL_MS
    lock = store_lock_path(store_root)
    record = _new_record(cfg)
    t0 = time.monotonic() * 1000
    try:
        mkdirp(store_root, 0o700)
    except Exception as e:
        _rethrow(e, f"cannot create review store root {store_root}")
    _sweep(store_root, cfg)
    while True:
        blocker: StoreLockBlocker | None = None
        try:
            if _publish(lock, record):

                def release() -> StoreLockReleaseResult:
                    try:
                        return _release_dir(lock, record.owner_id)
                    except Exception as e:
                        _rethrow(e, "review store lock release failed")

                return StoreLockHandle(path=lock, owner_id=record.owner_id, owner=record, _release=release)
            seen = _observe(lock)
            if seen.kind == "absent":
                continue  # released between publish and observe
            if seen.kind == "record":
                blocker = StoreLockBlocker("lock", seen.record)
            if _is_stale(seen, cfg):
                removed, other = _reclaim(store_root, lock, seen, cfg)
                if removed:
                    continue
                # The dead holder is not what blocks us: a live (or unreadable) claim or a changed identity does.
                blocker = StoreLockBlocker("reclaim", other)
        except Exception as e:
            _rethrow(e, "review store lock acquire failed")
        waited = time.monotonic() * 1000 - t0
        if waited >= timeout_ms:
            raise StoreLockContended(lock, waited, blocker)
        time.sleep(max(1.0, min(poll_ms * (0.5 + random.random()), timeout_ms - waited)) / 1000)


def with_store_lock(store_root: str, fn: Callable[[], T], options: StoreLockOptions | None = None) -> T:
    """Runs `fn` under the store lock. Fails closed if the lock was lost while `fn` ran."""
    handle = acquire_store_lock(store_root, options)
    ok = False
    try:
        value = fn()
        ok = True
        return value
    finally:
        r = handle.release()
        if ok and r.status != "released":
            raise StoreLockError(f"review store lock ownership was lost while held ({r.status})")
