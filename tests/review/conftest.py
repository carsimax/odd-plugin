"""Shared helpers for the review-engine tests (owned by the review T1 unit; later review test files import them with
`from review.conftest import ...`). The v9 oracle lives in `lib.v9_oracle` (`v9`, `v9_many`, `needs_v9`; `module` may be
`"review/<file>"` for dist/review/<file>.js).

Fixtures:
  store_root   `<tmp>/odd-plugin/review-transactions/v2` (not created), as the lock/store tests lay it out.
  tmp_dir      a fresh temp directory (a `Path`), removed by pytest.
Helpers:
  seed_lock(root, owner=None, raw=None)  writes `<root>/LOCK/owner.json` (a store lock directory) and returns its path.
  seed_dir(path, owner_id, pid=None, host=None)  writes `<path>/owner.json` as a lock-like directory (claims, leftovers).
  age(path, ms)  sets mtime of `path` (and its owner.json when present) `ms` into the past.
  tree_hash(path)  sha256 over names, modes and contents of a tree (to assert "left untouched").
  read_json(path), clone(v), list_files(dir, suffix), VENDOR_ROOT / INTEGRATION_ROOT / MIRROR_ROOT / REPO_ROOT.
  py_oracle_err(fn, *args)  runs `fn`; returns its result, or `{"__error__": str(e)}` when it raises (the oracle's error shape).
  dead_pid()  re-exported from the lib tests (a reaped child's pid).
"""
import hashlib
import json
import os
import stat
import time
from pathlib import Path

import pytest
from lib.conftest import ROOT as REPO_ROOT  # noqa: F401
from lib.conftest import dead_pid  # noqa: F401

VENDOR_ROOT = REPO_ROOT / "test-fixtures" / "review" / "vendor"
INTEGRATION_ROOT = VENDOR_ROOT / "review-integration"
MIRROR_ROOT = VENDOR_ROOT / "provider-mirror" / "v1.6.0"


@pytest.fixture
def tmp_dir(tmp_path: Path) -> Path:
    return tmp_path


@pytest.fixture
def store_root(tmp_path: Path) -> Path:
    return tmp_path / "odd-plugin" / "review-transactions" / "v2"


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def clone(v):
    return json.loads(json.dumps(v))


def list_files(d, suffix: str) -> list[Path]:
    return sorted(Path(d).glob(f"*{suffix}"))


def py_oracle_err(fn, *args):
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001
        return {"__error__": str(e)}


def age(path, ms: float) -> None:
    t = time.time() - ms / 1000
    p = Path(path)
    if (p / "owner.json").exists() or (p / "owner.json").is_symlink():
        try:
            os.utime(p / "owner.json", (t, t))
        except OSError:
            pass
    os.utime(p, (t, t))


def seed_dir(path, owner_id: str, pid: int | None = None, host: str | None = None) -> Path:
    import socket

    p = Path(path)
    p.mkdir()
    (p / "owner.json").write_text(json.dumps({"pid": dead_pid() if pid is None else pid, "host": host or socket.gethostname(), "ownerId": owner_id, "startedAt": 1}))
    return p


def seed_lock(root, owner=None, raw: str | None = None) -> Path:
    lock = Path(root) / "LOCK"
    lock.mkdir(parents=True, exist_ok=True)
    (lock / "owner.json").write_text(raw if raw is not None else json.dumps(owner))
    return lock


def tree_hash(path) -> str:
    h = hashlib.sha256()
    p = Path(path)

    def walk(q: Path) -> None:
        st = q.lstat()
        body = "" if stat.S_ISDIR(st.st_mode) else os.readlink(q) if stat.S_ISLNK(st.st_mode) else _safe_read(q)
        h.update(f"{str(q)[len(str(p)):]}:{st.st_mode}:{body}".encode("utf-8", "surrogateescape"))
        if stat.S_ISDIR(st.st_mode):
            for n in sorted(os.listdir(q)):
                walk(q / n)

    walk(p)
    return h.hexdigest()


def _safe_read(q: Path) -> str:
    try:
        return q.read_bytes().decode("latin1")
    except OSError:
        return "<unreadable>"


def diff_cases(module: str, fn: str, py_fn, calls: list[list], env: dict | None = None) -> None:
    """Differential helper: runs every args list on v9 (`module.fn`, one node process) and on `py_fn`, and asserts the
    results are equal (a raised error compares as `{"__error__": message}`), naming the first diverging call."""
    from lib.v9_oracle import v9_many

    expected = v9_many(module, fn, calls, env=env)
    for args, want in zip(calls, expected):
        got = py_oracle_err(py_fn, *args)
        assert got == want, f"{module}.{fn}{tuple(args)!r}: python={got!r} v9={want!r}"
