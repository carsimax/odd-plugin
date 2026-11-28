"""Port of v9 review/lock.spec.ts (13 test() cases)."""
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from odd_claude.review.lock import (
    StoreLockContended, StoreLockError, StoreLockOptions, StoreLockReleaseResult, acquire_store_lock, store_lock_path, with_store_lock,
)
from review.conftest import age, dead_pid, seed_lock
from review.lock_testkit import CHILD_SCRIPT

SRC = Path(__file__).resolve().parents[2] / "src"
ENV = {**os.environ, "PYTHONPATH": str(SRC)}
HOST = socket.gethostname()
Q = StoreLockOptions


def owner(root) -> dict:
    return json.loads((Path(store_lock_path(str(root))) / "owner.json").read_text())


def dead(pid: int) -> dict:
    return {"pid": pid, "host": HOST, "ownerId": "deadbeef", "startedAt": 1}


def test_acquire_writes_the_owner_record_release_removes_everything(store_root: Path):
    before = int(time.time() * 1000)
    h = acquire_store_lock(str(store_root))
    rec = owner(store_root)
    assert rec["pid"] == os.getpid()
    assert rec["host"] == HOST
    assert len(rec["ownerId"]) == 32 and set(rec["ownerId"]) <= set("0123456789abcdef")
    assert before <= rec["startedAt"] <= int(time.time() * 1000)
    assert rec["ownerId"] == h.owner_id
    assert os.listdir(store_root) == ["LOCK"]
    assert h.release() == StoreLockReleaseResult("released")
    assert os.listdir(store_root) == []
    h2 = acquire_store_lock(str(store_root))  # reusable
    assert h2.owner_id != h.owner_id
    h2.release()


def test_contention_bounded_wait_then_store_lock_contended_holder_untouched(store_root: Path):
    h = acquire_store_lock(str(store_root))
    t0 = time.time()
    with pytest.raises(StoreLockContended) as ei:
        acquire_store_lock(str(store_root), Q(timeout_ms=300, poll_ms=25))
    assert not isinstance(ei.value, StoreLockError)
    assert ei.value.owner.owner_id == h.owner_id
    assert ei.value.code == "STORE_LOCK_CONTENDED"
    assert f"review store lock is held by pid {os.getpid()} on {HOST}" in str(ei.value)
    assert str(ei.value).endswith(f"): {store_lock_path(str(store_root))}")
    elapsed = (time.time() - t0) * 1000
    assert 280 <= elapsed < 1500, elapsed
    assert os.listdir(store_root) == ["LOCK"]
    assert owner(store_root)["ownerId"] == h.owner_id
    h.release()


def test_default_start_budget_is_2s_timeout_0_tries_exactly_once(store_root: Path):
    h = acquire_store_lock(str(store_root))
    t0 = time.time()
    with pytest.raises(StoreLockContended):
        acquire_store_lock(str(store_root), Q(timeout_ms=0))
    assert time.time() - t0 < 0.2
    h.release()


def test_release_by_a_non_owner_is_a_no_op_with_a_typed_result(store_root: Path):
    a = acquire_store_lock(str(store_root))
    assert a.release().status == "released"
    b = acquire_store_lock(str(store_root))
    assert a.release().status == "not-owner"  # stale handle, someone else owns
    assert owner(store_root)["ownerId"] == b.owner_id
    assert b.release().status == "released"
    assert b.release().status == "absent"
    assert os.listdir(store_root) == []


def test_stale_takeover_dead_pid_on_the_same_host(store_root: Path):
    seed_lock(store_root, dead(dead_pid()))
    h = acquire_store_lock(str(store_root), Q(timeout_ms=500))
    rec = owner(store_root)
    assert rec["ownerId"] == h.owner_id
    assert rec["pid"] == os.getpid()
    assert os.listdir(store_root) == ["LOCK"]
    h.release()
    assert os.listdir(store_root) == []


def test_no_takeover_live_pid_other_host_with_a_dead_pid(store_root: Path):
    seed_lock(store_root, {"pid": os.getpid(), "host": HOST, "ownerId": "live", "startedAt": 1})
    age(store_lock_path(str(store_root)), 3_600_000)  # age alone never matters for a readable record
    with pytest.raises(StoreLockContended):
        acquire_store_lock(str(store_root), Q(timeout_ms=100))
    import shutil

    shutil.rmtree(store_lock_path(str(store_root)))
    seed_lock(store_root, {"pid": dead_pid(), "host": "some-other-host.invalid", "ownerId": "remote", "startedAt": 1})
    age(store_lock_path(str(store_root)), 3_600_000)
    with pytest.raises(StoreLockContended):
        acquire_store_lock(str(store_root), Q(timeout_ms=100))
    assert owner(store_root)["ownerId"] == "remote"
    assert os.listdir(store_root) == ["LOCK"]


def test_unreadable_owner_record_not_stale_while_fresh_stale_once_old(store_root: Path):
    for raw in ["", "{not json", json.dumps({"pid": "x"}), json.dumps({"pid": dead_pid(), "host": HOST})]:
        lock = seed_lock(store_root, raw=raw)
        with pytest.raises(StoreLockContended):
            acquire_store_lock(str(store_root), Q(timeout_ms=100))
        assert lock.exists(), f"fresh {raw!r}"
        age(lock, 3_600_000)
        h = acquire_store_lock(str(store_root), Q(timeout_ms=500))
        assert os.listdir(store_root) == ["LOCK"]
        h.release()
    lock = Path(store_lock_path(str(store_root)))  # directory without any owner file
    lock.mkdir(parents=True)
    with pytest.raises(StoreLockContended):
        acquire_store_lock(str(store_root), Q(timeout_ms=100))
    old = time.time() - 3600
    os.utime(lock, (old, old))
    acquire_store_lock(str(store_root), Q(timeout_ms=500)).release()
    assert os.listdir(store_root) == []


def test_a_leftover_claim_from_a_dead_contender_does_not_block_takeover(store_root: Path):
    seed_lock(store_root, dead(dead_pid()))
    guard = Path(f"{store_lock_path(str(store_root))}.claim-{'ab' * 16}")
    guard.mkdir()
    (guard / "owner.json").write_text(json.dumps({"pid": dead_pid(), "host": HOST, "ownerId": "g", "startedAt": 1}))
    h = acquire_store_lock(str(store_root), Q(timeout_ms=1000))
    assert os.listdir(store_root) == ["LOCK"]
    h.release()
    assert os.listdir(store_root) == []


def _hammer(root: Path, tmp: Path, with_stale: bool) -> None:
    counter, marker, log = tmp / "counter", tmp / "inside", tmp / "overlap.log"
    counter.write_text("0")
    log.write_text("")
    if with_stale:
        seed_lock(root, dead(dead_pid()))
    n, it = 6, 15
    ps = [subprocess.Popen([sys.executable, "-c", CHILD_SCRIPT, "loop", str(root), str(counter), str(it), str(marker), str(log)], env=ENV, stderr=subprocess.PIPE, text=True) for _ in range(n)]
    for i, p in enumerate(ps):
        err = p.communicate(timeout=120)[1]
        assert p.returncode == 0, f"child {i} exit code {p.returncode}; stderr: {err}"
        assert err == "", f"child {i} wrote to stderr"
    assert log.read_text() == "", "overlap or foreign release detected"
    assert int(counter.read_text()) == n * it, "counter lost updates"
    assert not marker.exists(), "marker left behind"
    assert os.listdir(root) == [], "store root not clean"


def test_exclusivity_under_real_process_concurrency(store_root: Path, tmp_path: Path):
    store_root.mkdir(parents=True)
    _hammer(store_root, tmp_path, False)


def test_concurrent_contenders_racing_one_stale_takeover_exactly_one_wins_at_a_time(store_root: Path, tmp_path: Path):
    store_root.mkdir(parents=True)
    _hammer(store_root, tmp_path, True)


def test_crash_simulation_kill_9_of_the_holder_next_acquirer_takes_over(store_root: Path, tmp_path: Path):
    store_root.mkdir(parents=True)
    ready = tmp_path / "ready"
    child = subprocess.Popen([sys.executable, "-c", CHILD_SCRIPT, "hold", str(store_root), str(ready)], env=ENV)
    try:
        for _ in range(400):
            if ready.exists():
                break
            time.sleep(0.025)
        assert ready.exists(), "child never acquired"
        held = owner(store_root)
        assert held["pid"] == child.pid
        with pytest.raises(StoreLockContended):  # alive: no takeover
            acquire_store_lock(str(store_root), Q(timeout_ms=100))
        child.kill()
        child.wait()
        h = acquire_store_lock(str(store_root), Q(timeout_ms=1000))
        rec = owner(store_root)
        assert rec["pid"] == os.getpid()
        assert rec["ownerId"] != held["ownerId"]
        assert os.listdir(store_root) == ["LOCK"]
        h.release()
        assert os.listdir(store_root) == []
    finally:
        child.kill()
        child.wait()


def test_fail_closed_unexpected_fs_error_raises_store_lock_error_never_ownership(tmp_path: Path, store_root: Path):
    blocker = tmp_path / "blocker"
    blocker.write_text("x")
    with pytest.raises(StoreLockError) as ei:
        acquire_store_lock(str(blocker / "v2"))
    assert not isinstance(ei.value, StoreLockContended)
    assert ei.value.code == "STORE_LOCK_ERROR"
    assert str(ei.value).startswith(f"cannot create review store root {blocker}/v2: ")
    store_root.mkdir(parents=True)  # LOCK that is a plain file: unreadable and fresh -> contended, never acquired
    Path(store_lock_path(str(store_root))).write_text("junk")
    with pytest.raises(StoreLockContended):
        acquire_store_lock(str(store_root), Q(timeout_ms=50))
    assert Path(store_lock_path(str(store_root))).read_text() == "junk"


def test_with_store_lock_releases_on_success_and_on_raise(store_root: Path):
    assert with_store_lock(str(store_root), lambda: 42) == 42
    assert os.listdir(store_root) == []

    def boom():
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        with_store_lock(str(store_root), boom)
    assert os.listdir(store_root) == []
