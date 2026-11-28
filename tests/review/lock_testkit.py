"""Fault-injection harness for the lock race tests (port of v9 lock-race.testkit.ts and lock-child.testkit.ts).

* `Worker`: a thread that runs `acquire_store_lock` with `os.rename` pause points and an optional `os.listdir` that hides
  live claims; the patches are thread-local (installed once by the `fault_injection` fixture), so the main thread and other
  workers are unaffected. Events are `threading.Event`s indexed like v9's Int32Array flags.
* `KILLAT_SCRIPT` / `CHILD_SCRIPT`: `python -c` programs (run with PYTHONPATH=src) for the kill -9 steps and the
  hold/loop children.
"""
import os
import re
import threading
from dataclasses import dataclass, field
from typing import Any

import pytest

from odd_claude.review import lock as lock_mod
from odd_claude.review.lock import StoreLockOptions, acquire_store_lock

_tls = threading.local()
_orig_rename = os.rename
_orig_listdir = os.listdir


def _rename(src, dst, *a, **kw):
    w: "Worker | None" = getattr(_tls, "worker", None)
    if w is None:
        return _orig_rename(src, dst, *a, **kw)
    s, d = w.rel(src), w.rel(dst)
    w.fire(False, s, d)
    r = _orig_rename(src, dst, *a, **kw)
    w.fire(True, s, d)
    return r


def _listdir(path=".", *a, **kw):
    r = _orig_listdir(path, *a, **kw)
    w: "Worker | None" = getattr(_tls, "worker", None)
    if w is None or not w.hide_claims or str(path) != w.root or not any(n.startswith("LOCK.claim-") for n in r):
        return r
    if w.hide_skip > 0:
        w.hide_skip -= 1
        return r
    if w.hide_claims <= 0:
        return r
    w.hide_claims -= 1
    return [n for n in r if not n.startswith("LOCK.claim-")]


@pytest.fixture
def fault_injection(monkeypatch):
    monkeypatch.setattr(os, "rename", _rename)
    monkeypatch.setattr(os, "listdir", _listdir)


@dataclass
class Rule:
    src: str  # regex on the root-relative source
    dst: str  # regex on the root-relative destination
    signal: int | None = None  # event to raise when the rename is about to run
    wait: int | None = None  # event to wait for before running it
    after: bool = False  # signal/wait AFTER the rename ran instead of before it


class Events:
    def __init__(self, n: int = 32):
        self.ev = [threading.Event() for _ in range(n)]

    def raise_(self, i: int) -> None:
        self.ev[i].set()

    def is_set(self, i: int) -> bool:
        return self.ev[i].is_set()

    def wait(self, i: int, label: str, limit_s: float = 5) -> None:
        if not self.ev[i].wait(limit_s):
            raise TimeoutError(f"timeout waiting {label}")


@dataclass
class Worker:
    events: Events
    root: str
    name: str
    rules: list[Rule]
    out: list[dict[str, Any]]
    holder_ev: int | None = None  # `holdEv`
    acquired_ev: int | None = None
    timeout_ms: float = 8000
    #: hide `LOCK.claim-*` from this many listings of the root that contain one, after skipping `hide_skip` such listings.
    hide_claims: float = 0
    hide_skip: int = 1
    thread: threading.Thread = field(init=False)
    used: set[int] = field(default_factory=set)

    def __post_init__(self) -> None:
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def rel(self, p: Any) -> str:
        return str(p)[len(self.root) + 1 :]

    def fire(self, after: bool, s: str, d: str) -> None:
        for k, r in enumerate(self.rules):
            if r.after == after and k not in self.used and re.search(r.src, s) and re.search(r.dst, d):
                self.used.add(k)
                if r.signal is not None:
                    self.events.raise_(r.signal)
                if r.wait is not None:
                    self.events.wait(r.wait, f"{self.name}: wait {r.wait}", 20)

    def _run(self) -> None:
        _tls.worker = self
        try:
            h = acquire_store_lock(self.root, StoreLockOptions(timeout_ms=self.timeout_ms, poll_ms=5))
            self.out.append({"name": self.name, "acquired": h.owner_id})
            if self.acquired_ev is not None:
                self.events.raise_(self.acquired_ev)
            if self.holder_ev is not None:
                self.events.wait(self.holder_ev, f"{self.name}: hold", 20)
            self.out.append({"name": self.name, "released": h.release().status})
        except Exception as e:  # noqa: BLE001
            blocker = getattr(e, "blocker", None)
            self.out.append({
                "name": self.name, "error": type(e).__name__, "message": str(e),
                "blocker": None if blocker is None else {"kind": blocker.kind, "owner": None if blocker.owner is None else {"pid": blocker.owner.pid}},
            })  # fmt: skip
        finally:
            _tls.worker = None

    def join(self, timeout: float = 30) -> None:
        self.thread.join(timeout)
        assert not self.thread.is_alive(), f"{self.name} did not finish"


# `python -c KILLAT_SCRIPT root op regex when`: patches the step, SIGKILLs itself there, then acquires and releases.
KILLAT_SCRIPT = r"""
import os, re, signal, sys
from odd_claude.review import lock
from odd_claude.review.lock import StoreLockOptions, acquire_store_lock
root, op, rx, when = sys.argv[1:5]
def rel(p): return str(p)[len(root) + 1:]
def patch(holder, name, two):
    orig = getattr(holder, name)
    def wrapped(*a, **kw):
        key = f"{rel(a[0])}>{rel(a[1])}" if two else rel(a[0])
        m = isinstance(a[0], str) and re.search(rx, key)
        if m and when == "before": os.kill(os.getpid(), signal.SIGKILL)
        r = orig(*a, **kw)
        if m and when == "after": os.kill(os.getpid(), signal.SIGKILL)
        return r
    setattr(holder, name, wrapped)
{"mkdirSync": lambda: patch(os, "mkdir", False), "openSync": lambda: patch(os, "open", False),
 "renameSync": lambda: patch(os, "rename", True), "rmSync": lambda: patch(lock, "_rm_rf", False)}[op]()
acquire_store_lock(root, StoreLockOptions(timeout_ms=3000)).release()
print("NOT KILLED")
"""

# `python -c CHILD_SCRIPT mode root a [b c d]`: `loop root counter iterations marker log` | `hold root readyfile`.
CHILD_SCRIPT = r"""
import os, sys, time
from odd_claude.review.lock import StoreLockOptions, acquire_store_lock
mode, root, a = sys.argv[1:4]
if mode == "loop":
    counter, iterations, marker, log = a, int(sys.argv[4]), sys.argv[5], sys.argv[6]
    for _ in range(iterations):
        lock = acquire_store_lock(root, StoreLockOptions(timeout_ms=30000, poll_ms=5))
        try:
            try:
                fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL); os.write(fd, str(os.getpid()).encode()); os.close(fd)
            except FileExistsError:
                open(log, "a").write(f"overlap pid={os.getpid()}\n")
            n = int(open(counter).read())
            open(counter, "w").write(str(n + 1))
            try: os.unlink(marker)
            except FileNotFoundError: pass
        finally:
            r = lock.release()
            if r.status != "released": open(log, "a").write(f"release {r.status} pid={os.getpid()}\n")
elif mode == "hold":
    acquire_store_lock(root, StoreLockOptions(timeout_ms=5000))
    open(a, "w").write("ready")
    while True: time.sleep(1)
else:
    raise SystemExit(f"unknown mode {mode}")
"""
