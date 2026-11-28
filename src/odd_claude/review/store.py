"""Review authority store: `<git-common-dir>/odd-plugin/review-transactions/v2/<lineage>/review-state.json` (+ `review-receipt.json`,
written once at burn). Port of v9 review/store.ts; read that file's header for the full rationale, which this port keeps.

  * every mutation (create, update, receipt) runs under the exclusive store lock (`<root>/LOCK`, lock.py).
  * `update_state` is compare-and-swap on the state revision (never mtime): read current, refuse unless
    `current["revision"] == expected_revision`, apply the pure transition from state.py, re-validate, write atomically.
  * `write_atomic`: unique temp in the same directory (`.atomic-<pid>-<16 hex>`, O_EXCL|O_NOFOLLOW, 0600) -> write -> fsync ->
    rename -> fsync directory; a failure before the rename removes the temp, a kill -9 leaves an inert `.atomic-*` file that
    is never read as state and is swept by the next mutation.
  * reads are secure (O_NOFOLLOW|O_NONBLOCK, regular-file check on the open fd, no hardlinks, size cap, JSON, then
    `validate_state_record`); corrupt input raises `StoreCorruptError` and is NEVER repaired. Lineage ids are `review-<16 hex>`.
  * unexpected OS failures surface as `StoreIoError`; root and lineage directories are 0700, files 0600; the three namespace
    directories and the lineage directory must be real directories (a symlink is refused).

Python port differences: synchronous (`create_state`, `update_state` and `write_receipt` return directly; the transition is a
plain callable returning a state.py outcome dict); options are the dataclasses `StoreOptions(lock, sweep)` and
`SweepOptions(now, min_age_ms, max)`; `list_lineages(common_dir, limit=None, max_scan=None)` returns
`{"lineages": [...], "truncated": bool}`; error attributes are snake_case (`expected_revision`, `current_revision`). The text
that wraps an OS error or a JSON parse failure inside `StoreIoError` / `StoreCorruptError` messages is Python's, not Node's
(the codes, kinds, errno names, paths and every other message are v9's). On-disk bytes are `canonical_json(record) + "\\n"`.
Public API: `MAX_STATE_BYTES`, `MAX_LINEAGES`, `ABANDONED_MIN_AGE_MS`, `ABANDONED_SWEEP_MAX`, the `Store*Error` classes,
`SweepOptions`, `StoreOptions`, `store_root_for`, `write_atomic`, `read_state`, `create_state`, `update_state`, `write_receipt`,
`read_receipt`, `list_lineages`, `state_revision`.
"""
import errno as _errno
import os
import re
import secrets
import stat
from dataclasses import dataclass
from typing import Any, Callable

from ..lib.js import js_json_loads, js_stringify
from ._paths import js_join
from .canonical import _js_string, canonical_json
from .lock import StoreLockOptions, with_store_lock
from .state import state_revision, validate_state_record

MAX_STATE_BYTES = 1 << 20
MAX_LINEAGES = 10_000
#: An abandoned lineage directory (crash mid-START) is only swept once it, and everything in it, is older than this.
ABANDONED_MIN_AGE_MS = 3_600_000
#: Most abandoned directories one sweep removes, and most lineage directories it examines.
ABANDONED_SWEEP_MAX = 16
_ABANDONED_SWEEP_EXAMINE_MAX = 512
_STATE_FILE = "review-state.json"
_RECEIPT_FILE = "review-receipt.json"
_LINEAGE_RE = re.compile(r"review-[0-9a-f]{16}")
_TEMP_RE = re.compile(r"\.atomic-[0-9]+-[0-9a-f]{16}")
_UNDEF: Any = object()


def _json(v: Any) -> str:
    return "undefined" if v is _UNDEF else js_stringify(v)


class StoreInvalidLineageError(Exception):
    code = "STORE_INVALID_LINEAGE"

    def __init__(self, lineage: Any):
        super().__init__(f"invalid review lineage id (want review-<16 hex>): {_json(lineage)}")
        self.lineage = None if lineage is _UNDEF else lineage


class StoreNotFoundError(Exception):
    code = "STORE_NOT_FOUND"

    def __init__(self, path: str):
        super().__init__(f"review store entry not found: {path}")
        self.path = path


class StoreAlreadyExistsError(Exception):
    code = "STORE_ALREADY_EXISTS"

    def __init__(self, path: str):
        super().__init__(f"review store entry already exists: {path}")
        self.path = path


class StoreCorruptError(Exception):
    """The file on disk is unreadable, unsafe or invalid. Never repaired. `kind` is one of unreadable, not-regular, oversized,
    invalid-json, invalid-record, revision-mismatch, lineage-mismatch."""

    code = "STORE_CORRUPT"

    def __init__(self, kind: str, path: str, detail: str, errors: list[str] | None = None):
        super().__init__(f"review store entry is corrupt ({kind}): {path}: {detail}")
        self.kind = kind
        self.path = path
        self.errors = errors or []


class StoreConcurrentUpdateError(Exception):
    """CAS failure: the stored revision is not the one the caller read."""

    code = "STORE_CONCURRENT_UPDATE"

    def __init__(self, expected_revision: Any, current_revision: Any):
        super().__init__(f"concurrent update: expected revision {_js_string(expected_revision)}, current {_js_string(current_revision)}")
        self.expected_revision = expected_revision
        self.current_revision = current_revision


class StoreTransitionRefusedError(Exception):
    code = "STORE_TRANSITION_REFUSED"

    def __init__(self, refusal: dict):
        super().__init__(f"transition refused ({refusal['code']}): {refusal['message']}")
        self.refusal = refusal


class StoreInvalidRecordError(Exception):
    """The caller supplied a record (or a transition result) that is not a valid state record / receipt. Nothing written."""

    code = "STORE_INVALID_RECORD"

    def __init__(self, errors: list[str]):
        super().__init__(f"invalid review record: {'; '.join(errors)}")
        self.errors = errors


class StoreIoError(Exception):
    """Unexpected filesystem failure (ENOENT on the common dir, EACCES, ENOSPC...). Fail closed; nothing is assumed written."""

    code = "STORE_IO"

    def __init__(self, path: str, errno: str | None, detail: str, cause: BaseException | None = None):
        super().__init__(f"review store I/O failure{f' ({errno})' if errno else ''}: {path}: {detail}")
        self.path = path
        self.errno = errno
        if cause is not None:
            self.__cause__ = cause


@dataclass
class SweepOptions:
    #: Clock (ms since epoch) used for the age check. Test seam.
    now: Callable[[], float] | None = None
    #: Minimum age of the directory and of every entry in it before it may be removed.
    min_age_ms: float | None = None
    #: Most abandoned directories removed by one call.
    max: int | None = None


@dataclass
class StoreOptions:
    lock: StoreLockOptions | None = None
    #: Abandoned-lineage sweep of `create_state` (see `_sweep_abandoned_lineages`).
    sweep: SweepOptions | None = None


def store_root_for(common_dir: str) -> str:
    return js_join(common_dir, "odd-plugin", "review-transactions", "v2")


def _assert_lineage(lineage: Any) -> None:
    if not isinstance(lineage, str) or not _LINEAGE_RE.fullmatch(lineage):
        raise StoreInvalidLineageError(lineage)


def _err_name(e: BaseException) -> str | None:
    n = getattr(e, "errno", None)
    return _errno.errorcode.get(n) if isinstance(n, int) else None


def _os_msg(e: OSError) -> str:
    desc = (e.strerror or str(e)).strip()
    return f"{_err_name(e) or 'EIO'}: {desc[:1].lower() + desc[1:]}" + (f", '{e.filename}'" if e.filename else "")


def _typed(e: BaseException) -> BaseException:
    """Maps a bare OS error to StoreIoError; store/lock errors and non-fs errors (caller code) pass through."""
    name = _err_name(e)
    if isinstance(getattr(e, "code", None), str) and e.code.startswith("STORE_") or not isinstance(e, OSError) or name is None:  # type: ignore[attr-defined]
        return e
    return StoreIoError(str(e.filename or ""), name, _os_msg(e), e)


def _guard(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except Exception as e:  # noqa: BLE001
        t = _typed(e)
        if t is e:
            raise
        raise t from e


def _lstat_or_none(path: str) -> os.stat_result | None:
    try:
        return os.lstat(path)
    except OSError as e:
        if e.errno == _errno.ENOENT:
            return None
        raise


def _real_dir_exists(path: str) -> bool:
    """Requires `path` to be a real directory (not a symlink). False when absent."""
    st = _lstat_or_none(path)
    if st is None:
        return False
    if not stat.S_ISDIR(st.st_mode):
        raise StoreCorruptError("not-regular", path, "expected a real directory")
    return True


def _sync_dir(d: str) -> None:
    fd = os.open(d, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _check_root(common_dir: str, create: bool) -> bool:
    """The three namespace directories, each a real directory. With `create` they are made 0700."""
    path = common_dir
    for part in ("odd-plugin", "review-transactions", "v2"):
        path = js_join(path, part)
        if _real_dir_exists(path):
            continue
        if not create:
            return False
        try:
            os.mkdir(path, 0o700)
            _sync_dir(os.path.dirname(path))
        except OSError as e:
            if e.errno != _errno.EEXIST:
                raise
        _real_dir_exists(path)
    return True


def _lineage_dir_or_throw(common_dir: str, lineage: str) -> str:
    if not _check_root(common_dir, False):
        raise StoreNotFoundError(store_root_for(common_dir))
    d = js_join(store_root_for(common_dir), lineage)
    if not _real_dir_exists(d):
        raise StoreNotFoundError(d)
    return d


def _read_secure(path: str) -> bytes | None:
    """Secure read of a store file: None when absent."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as e:
        if e.errno == _errno.ENOENT:
            return None
        if e.errno in (_errno.ELOOP, _errno.EMLINK):
            raise StoreCorruptError("not-regular", path, "refusing to follow a symlink") from e
        raise StoreCorruptError("unreadable", path, _os_msg(e)) from e
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise StoreCorruptError("not-regular", path, "not a regular file")
        if st.st_nlink > 1:
            raise StoreCorruptError("not-regular", path, f"hardlinked (nlink {st.st_nlink})")
        if st.st_size > MAX_STATE_BYTES:
            raise StoreCorruptError("oversized", path, f"{st.st_size} bytes exceeds {MAX_STATE_BYTES}")
        chunks: list[bytes] = []
        total = 0
        while True:
            try:
                buf = os.read(fd, min(65_536, MAX_STATE_BYTES + 1 - total))
            except OSError as e:
                raise StoreCorruptError("unreadable", path, _os_msg(e)) from e
            if not buf:
                break
            total += len(buf)
            if total > MAX_STATE_BYTES:
                raise StoreCorruptError("oversized", path, f"exceeds {MAX_STATE_BYTES} bytes")
            chunks.append(buf)
        return b"".join(chunks)
    finally:
        os.close(fd)


def _parse_json(raw: bytes, path: str) -> Any:
    try:
        return js_json_loads(raw.decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001
        raise StoreCorruptError("invalid-json", path, str(e)) from e


def _decode_state(raw: bytes, path: str, lineage: str) -> dict:
    v = validate_state_record(_parse_json(raw, path))
    if not v["ok"]:
        errs = v["errors"]
        only_revision = len(errs) > 0 and all(m.startswith("revision ") for m in errs)
        raise StoreCorruptError("revision-mismatch" if only_revision else "invalid-record", path, "; ".join(errs), errs)
    if v["record"]["lineage_id"] != lineage:
        raise StoreCorruptError("lineage-mismatch", path, f"record belongs to {v['record']['lineage_id']}")
    return v["record"]


def write_atomic(path: str, payload: bytes | str) -> None:
    """temp (same dir, unique, 0600) -> write -> fsync -> rename -> fsync dir. Removes the temp on any failure before the rename."""
    d = js_join(path, "..")
    temp = js_join(d, f".atomic-{os.getpid()}-{secrets.token_hex(8)}")
    data = payload.encode("utf-8") if isinstance(payload, str) else payload
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    renamed = False
    try:
        try:
            os.fchmod(fd, 0o600)
            view = memoryview(data)
            off = 0
            while off < len(data):
                off += os.write(fd, view[off:])
            os.fsync(fd)
        finally:
            os.close(fd)
        os.rename(temp, path)
        renamed = True
    finally:
        if not renamed:
            try:
                os.unlink(temp)
            except FileNotFoundError:
                pass
    _sync_dir(d)


def _sweep_temps(d: str) -> None:
    """Held under the store lock: every `.atomic-*` temp in the lineage dir belongs to a dead writer. Best effort."""
    try:
        for name in os.listdir(d):
            if not _TEMP_RE.fullmatch(name):
                continue
            p = js_join(d, name)
            if stat.S_ISREG(os.lstat(p).st_mode):
                try:
                    os.unlink(p)
                except FileNotFoundError:
                    pass
    except Exception:  # noqa: BLE001 - best effort
        pass


def _sweep_abandoned_lineages(root: str, options: SweepOptions | None) -> None:
    """Removes the directories a crash in the middle of START leaves behind (v9 sweepAbandonedLineages: read its comment for the
    full rationale). Runs ONLY from `create_state`, under the store root lock. A lineage directory goes only when ALL hold: the
    name is a lineage id; it is a real directory (lstat, never a symlink); it holds nothing but `.atomic-*` temps; every temp is
    a regular file with a single link; the directory and every temp are older than `min_age_ms`. Files go with unlink, then
    rmdir (never recursive). At most `max` directories are removed and 512 old non-live directories examined per call; a
    directory holding a `review-state.json` entry of any type is skipped without counting; at most MAX_LINEAGES entries are
    scanned. A failure on one directory is swallowed; a sweep never fails START."""
    options = options or SweepOptions()
    now = (options.now or (lambda: __import__("time").time() * 1000))()
    min_age = ABANDONED_MIN_AGE_MS if options.min_age_ms is None else options.min_age_ms
    max_removed = ABANDONED_SWEEP_MAX if options.max is None else options.max

    def old(st: os.stat_result) -> bool:
        return now - st.st_mtime_ns / 1e6 > min_age

    removed = 0
    examined = 0
    it = None
    try:
        it = os.scandir(root)
        scanned = 0
        while removed < max_removed and examined < _ABANDONED_SWEEP_EXAMINE_MAX and scanned < MAX_LINEAGES:
            ent = next(it, None)
            if ent is None:
                break
            scanned += 1
            if not _LINEAGE_RE.fullmatch(ent.name):
                continue
            try:
                path = js_join(root, ent.name)
                st = os.lstat(path)
                if not stat.S_ISDIR(st.st_mode) or not old(st):
                    continue
                if _lstat_or_none(js_join(path, _STATE_FILE)):
                    continue  # live lineage: never removable, costs no examine budget
                examined += 1
                names = os.listdir(path)
                if not all(_TEMP_RE.fullmatch(n) for n in names):
                    continue
                temps = [js_join(path, n) for n in names]
                ok = True
                for f in temps:
                    ts = os.lstat(f)
                    if not (stat.S_ISREG(ts.st_mode) and ts.st_nlink == 1 and old(ts)):
                        ok = False
                        break
                if not ok:
                    continue
                for f in temps:
                    os.unlink(f)
                os.rmdir(path)
                removed += 1
            except Exception:  # noqa: BLE001 - skipped: raced, unreadable, not empty... never fatal
                pass
    except Exception:  # noqa: BLE001 - best effort
        pass
    finally:
        try:
            if it is not None:
                it.close()
        except Exception:  # noqa: BLE001
            pass


def _read_state_impl(common_dir: str, lineage: str) -> dict:
    _assert_lineage(lineage)
    d = _lineage_dir_or_throw(common_dir, lineage)
    path = js_join(d, _STATE_FILE)
    raw = _read_secure(path)
    if raw is None:
        raise StoreNotFoundError(path)
    return _decode_state(raw, path, lineage)


def _create_state_impl(common_dir: str, record: Any, options: StoreOptions) -> dict:
    lineage = record.get("lineage_id", _UNDEF) if isinstance(record, dict) else _UNDEF
    _assert_lineage(lineage)
    v = validate_state_record(record)
    if not v["ok"]:
        raise StoreInvalidRecordError(v["errors"])
    _check_root(common_dir, True)
    root = store_root_for(common_dir)

    def run() -> dict:
        _sweep_abandoned_lineages(root, options.sweep)
        d = js_join(root, lineage)
        st = _lstat_or_none(d)
        if st and not stat.S_ISDIR(st.st_mode):
            raise StoreAlreadyExistsError(d)
        f = js_join(d, _STATE_FILE)
        if st:
            if _lstat_or_none(f):
                raise StoreAlreadyExistsError(f)
        else:
            os.mkdir(d, 0o700)
            _sync_dir(root)
        _sweep_temps(d)
        write_atomic(f, canonical_json(v["record"]) + "\n")
        return v["record"]

    return with_store_lock(root, run, options.lock)


def _update_state_impl(common_dir: str, lineage: str, expected_revision: Any, transition: Callable[[dict], dict], options: StoreOptions) -> dict:
    _assert_lineage(lineage)
    _lineage_dir_or_throw(common_dir, lineage)

    def run() -> dict:
        d = _lineage_dir_or_throw(common_dir, lineage)
        f = js_join(d, _STATE_FILE)
        raw = _read_secure(f)
        if raw is None:
            raise StoreNotFoundError(f)
        current = _decode_state(raw, f, lineage)
        if not (isinstance(expected_revision, str) and current["revision"] == expected_revision):
            raise StoreConcurrentUpdateError(expected_revision, current["revision"])
        outcome = transition(current)
        if not outcome["ok"]:
            raise StoreTransitionRefusedError(outcome["refusal"])
        v = validate_state_record(outcome["record"])
        if not v["ok"]:
            raise StoreInvalidRecordError(v["errors"])
        if v["record"]["lineage_id"] != lineage:
            raise StoreInvalidRecordError([f"transition changed lineage_id to {v['record']['lineage_id']}"])
        _sweep_temps(d)
        write_atomic(f, canonical_json(v["record"]) + "\n")
        return {**outcome, "record": v["record"]}

    return with_store_lock(store_root_for(common_dir), run, options.lock)


def _write_receipt_impl(common_dir: str, lineage: str, receipt: Any, options: StoreOptions) -> None:
    """Create-only atomic receipt write (`review-receipt.json`)."""
    _assert_lineage(lineage)
    if not isinstance(receipt, dict):
        raise StoreInvalidRecordError(["receipt must be a JSON object"])
    payload = canonical_json(receipt) + "\n"
    if len(payload.encode("utf-8")) > MAX_STATE_BYTES:
        raise StoreInvalidRecordError([f"receipt exceeds {MAX_STATE_BYTES} bytes"])
    _lineage_dir_or_throw(common_dir, lineage)

    def run() -> None:
        d = _lineage_dir_or_throw(common_dir, lineage)
        read_state(common_dir, lineage)  # a receipt only ever belongs to a valid state
        f = js_join(d, _RECEIPT_FILE)
        if _lstat_or_none(f):
            raise StoreAlreadyExistsError(f)
        _sweep_temps(d)
        write_atomic(f, payload)

    with_store_lock(store_root_for(common_dir), run, options.lock)


def _read_receipt_impl(common_dir: str, lineage: str) -> dict:
    _assert_lineage(lineage)
    d = _lineage_dir_or_throw(common_dir, lineage)
    path = js_join(d, _RECEIPT_FILE)
    raw = _read_secure(path)
    if raw is None:
        raise StoreNotFoundError(path)
    parsed = _parse_json(raw, path)
    if not isinstance(parsed, dict):
        raise StoreCorruptError("invalid-record", path, "receipt must be a JSON object")
    return parsed


def _list_lineages_impl(common_dir: str, limit: int | None, max_scan: int | None) -> dict:
    """Sorted lineage ids. Scans at most `max_scan` (default MAX_LINEAGES) directory entries; ignores LOCK, temps, files,
    symlinks and junk names. Only real lineage directories count against `limit`. `truncated` is True when the scan cap was
    hit with entries left unread, or more lineages exist than `limit`."""
    if not _check_root(common_dir, False):
        return {"lineages": [], "truncated": False}
    root = store_root_for(common_dir)
    cap = MAX_LINEAGES if max_scan is None else max_scan
    found: list[str] = []
    truncated = False
    it = os.scandir(root)
    try:
        scanned = 0
        while True:
            if scanned >= cap:
                truncated = next(it, None) is not None
                break
            ent = next(it, None)
            if ent is None:
                break
            scanned += 1
            if not _LINEAGE_RE.fullmatch(ent.name):
                continue
            st = _lstat_or_none(js_join(root, ent.name))
            if st is not None and stat.S_ISDIR(st.st_mode):
                found.append(ent.name)
    finally:
        it.close()
    found.sort()
    lim = len(found) if limit is None else max(0, limit)
    if len(found) > lim:
        truncated = True
    return {"lineages": found[: int(min(lim, len(found)))], "truncated": truncated}  # JS `slice` truncates a fractional end toward zero


def read_state(common_dir: str, lineage: str) -> dict:
    return _guard(lambda: _read_state_impl(common_dir, lineage))


def create_state(common_dir: str, record: dict, options: StoreOptions | None = None) -> dict:
    return _guard(lambda: _create_state_impl(common_dir, record, options or StoreOptions()))


def update_state(common_dir: str, lineage: str, expected_revision: str, transition: Callable[[dict], dict], options: StoreOptions | None = None) -> dict:
    """Returns the transition's outcome (`{"ok": True, "record": <validated record>, ...}`); raises on a refusal."""
    return _guard(lambda: _update_state_impl(common_dir, lineage, expected_revision, transition, options or StoreOptions()))


def write_receipt(common_dir: str, lineage: str, receipt: dict, options: StoreOptions | None = None) -> None:
    _guard(lambda: _write_receipt_impl(common_dir, lineage, receipt, options or StoreOptions()))


def read_receipt(common_dir: str, lineage: str) -> dict:
    return _guard(lambda: _read_receipt_impl(common_dir, lineage))


def list_lineages(common_dir: str, limit: int | None = None, max_scan: int | None = None) -> dict:
    return _guard(lambda: _list_lineages_impl(common_dir, limit, max_scan))


__all__ = [
    "MAX_STATE_BYTES", "MAX_LINEAGES", "ABANDONED_MIN_AGE_MS", "ABANDONED_SWEEP_MAX", "StoreInvalidLineageError", "StoreNotFoundError",
    "StoreAlreadyExistsError", "StoreCorruptError", "StoreConcurrentUpdateError", "StoreTransitionRefusedError", "StoreInvalidRecordError",
    "StoreIoError", "SweepOptions", "StoreOptions", "store_root_for", "write_atomic", "read_state", "create_state", "update_state",
    "write_receipt", "read_receipt", "list_lineages", "state_revision",
]
