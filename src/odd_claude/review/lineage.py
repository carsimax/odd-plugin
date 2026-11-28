"""Shared read-only helpers over lineage records, used by start, status and capture (port of v9 review/lineage.ts).
One home so the three callers cannot drift apart.
Public API: `read_raw_state`, `find_lineage` (options dict `{"limit", "maxScan"}`, results with v9's keys), `lenses_pending`, `has_role`.
"""
import os
from typing import Any

from ..lib.js import js_json_loads
from .state import StateRecord
from .store import list_lineages, read_state, store_root_for

MAX_RAW_STATE_BYTES = 1 << 20


def read_raw_state(path: str) -> dict | None | str:
    """Secure bounded read of a state file for the lenient pending-correction look. Returns the record; None for a content
    problem that upstream skips (absent, oversized regular file, not JSON, not an object); "unsafe" for a symlink, FIFO,
    directory, hardlink, open error or read error (the lineage is corrupt or unreadable: fail closed)."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except (OSError, ValueError):  # ValueError: a NUL in the path
        return "unsafe"
    try:
        st = os.fstat(fd)
        if (st.st_mode & 0o170000) != 0o100000 or st.st_nlink > 1:
            return "unsafe"
        if st.st_size > MAX_RAW_STATE_BYTES:
            return None
        got = bytearray()
        while len(got) < st.st_size:
            try:
                chunk = os.read(fd, st.st_size - len(got))
            except OSError:
                return "unsafe"
            if not chunk:
                break
            got += chunk
        try:
            parsed = js_json_loads(bytes(got).decode("utf-8", "replace"))
        except ValueError:
            return None
        return parsed if isinstance(parsed, dict) else None
    except OSError:
        return "unsafe"
    finally:
        os.close(fd)


_MISSING: Any = object()  # JS `undefined`: a key that is not there


def _same(a: Any, b: Any) -> bool:
    """JS `===` over JSON values (objects and arrays compare by identity)."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (int, float, str)) and isinstance(b, (int, float, str)):
        return isinstance(a, str) == isinstance(b, str) and a == b
    return a is b


def _raw_target_matches(common_dir: str, lineage: str, target_identity: str, projection: str) -> bool:
    raw = read_raw_state(os.path.join(store_root_for(common_dir), lineage, "review-state.json"))
    return isinstance(raw, dict) and _same(raw.get("target_identity"), target_identity) and _same(raw.get("projection"), projection)


def find_lineage(common_dir: str, target_identity: str, projection: str, options: dict | None = None) -> dict:
    """Existing lineage for this exact candidate: a live one wins, else a burned one (`{"live"?, "burned"?, "unreadable"?}`).
    An unreadable lineage whose raw record claims this candidate is reported as `unreadable` (fail closed)."""
    opts = options or {}
    found: dict = {}
    for lineage in list_lineages(common_dir, opts.get("limit"), opts.get("maxScan"))["lineages"]:
        try:
            rec = read_state(common_dir, lineage)
        except Exception:  # noqa: BLE001 - any unreadable lineage
            if _raw_target_matches(common_dir, lineage, target_identity, projection):
                found.setdefault("unreadable", lineage)
            continue
        if not (_same(rec["target_identity"], target_identity) and _same(rec["projection"], projection)):
            continue
        found.setdefault("burned" if rec["burned"] else "live", rec)
    return found


def lenses_pending(r: StateRecord) -> list[str]:
    """Selected lenses that have no admitted lens result yet."""
    return [lens for lens in r["selected_lenses"] if not any(_same(e.get("role", _MISSING), "lens") and _same(e.get("lens", _MISSING), lens) for e in r["admitted_role_results"])]


def has_role(r: StateRecord, role: str) -> bool:
    """Whether a result for this role has been admitted."""
    return any(_same(e.get("role", _MISSING), role) for e in r["admitted_role_results"])
