"""Differential: review/lock against v9 dist/review/lock.js through the oracle (pure path function, owner-record format,
contention messages, and takeover of a lock the other implementation left behind)."""
import json
import os
import re
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from lib.v9_oracle import needs_v9, v9
from odd_claude.review.lock import StoreLockContended, StoreLockOptions, acquire_store_lock, store_lock_path
from review.conftest import dead_pid, diff_cases

pytestmark = needs_v9

SRC = Path(__file__).resolve().parents[2] / "src"
M1 = "11111111-1111-4111-8111-111111111111"
B1 = "boot-one/pid:[4026531836]"
HOST = "fixed-host"


def test_store_lock_path_matches_v9_normalization():
    roots = ["/a/b", "/a/b/", "a/b", "a//b", "a/./b/../c", "/", "", ".", "..", "/a/../..", "//a", "///a//b", "é/\U0001f600", "a b/ c", "mem://root", "/a/b/.", "x\n"]
    diff_cases("review/lock", "storeLockPath", store_lock_path, [[r] for r in roots])


def _owner(root: Path) -> dict:
    return json.loads((root / "LOCK" / "owner.json").read_text())


@pytest.mark.parametrize("opts", [
    {"host": HOST, "machineId": M1, "bootId": B1}, {"host": HOST, "machineId": None, "bootId": None}, {"host": HOST, "machineId": M1, "bootId": None},
    {"host": HOST, "machineId": "not-a-uuid", "bootId": "has space"}, {"host": "é \U0001f600", "machineId": M1, "bootId": B1},
])  # fmt: skip
def test_the_owner_record_has_the_same_keys_order_and_value_types(tmp_path: Path, opts: dict):
    r9, rp = tmp_path / "v9", tmp_path / "py"
    got9 = v9("review/lock", "acquireStoreLock", str(r9), {**opts, "timeoutMs": 100})
    h = acquire_store_lock(str(rp), StoreLockOptions(timeout_ms=100, host=opts["host"], machine_id=opts["machineId"], boot_id=opts["bootId"]))
    a, b = _owner(r9), _owner(rp)
    assert list(a) == list(b) == [k for k in ("pid", "host", "machine", "boot", "ownerId", "startedAt") if k in a]
    assert {k: type(v) for k, v in a.items()} == {k: type(v) for k, v in b.items()}
    assert {k: v for k, v in a.items() if k in ("host", "machine", "boot")} == {k: v for k, v in b.items() if k in ("host", "machine", "boot")}
    assert sorted(got9) == ["owner", "ownerId", "path"] and got9["path"] == str(r9 / "LOCK") and got9["owner"]["ownerId"] == a["ownerId"]
    assert len(a["ownerId"]) == len(b["ownerId"]) == 32 and abs(a["startedAt"] - b["startedAt"]) < 60_000
    assert os.listdir(r9) == os.listdir(rp) == ["LOCK"]
    h.release()


def _norm(msg: str) -> str:
    return re.sub(r"\(waited \d+ ms\)", "(waited N ms)", msg)


SEEDS = [
    {"pid": os.getpid(), "host": "elsewhere", "machine": M1, "boot": B1},
    {"pid": os.getpid(), "host": "elsewhere", "machine": M1},
    {"pid": os.getpid(), "host": "elsewhere"},
    {"pid": os.getpid(), "host": "é \U0001f600", "machine": M1, "boot": B1},
    {"pid": 1, "host": HOST, "machine": "not-a-uuid"},
]


@pytest.mark.parametrize("seed", SEEDS)
def test_the_contended_message_and_owner_match_v9(tmp_path: Path, seed: dict):
    root = tmp_path / "v2"
    (root / "LOCK").mkdir(parents=True)
    (root / "LOCK" / "owner.json").write_text(json.dumps({"ownerId": "live", "startedAt": 1, **seed}))
    want = v9("review/lock", "acquireStoreLock", str(root), {"timeoutMs": 0, "host": HOST, "machineId": None, "bootId": None})
    with pytest.raises(StoreLockContended) as ei:
        acquire_store_lock(str(root), StoreLockOptions(timeout_ms=0, host=HOST, machine_id=None, boot_id=None))
    assert _norm(str(ei.value)) == _norm(want["__error__"])
    assert ei.value.owner.pid == seed["pid"]


def test_the_reclaim_message_with_an_unreadable_claim_matches_v9(tmp_path: Path):
    root = tmp_path / "v2"
    (root / "LOCK").mkdir(parents=True)
    (root / "LOCK" / "owner.json").write_text(json.dumps({"pid": dead_pid(), "host": socket.gethostname(), "ownerId": "X", "startedAt": 1}))
    (root / f"LOCK.claim-{'a' * 32}").mkdir()
    want = v9("review/lock", "acquireStoreLock", str(root), {"timeoutMs": 0})
    with pytest.raises(StoreLockContended) as ei:
        acquire_store_lock(str(root), StoreLockOptions(timeout_ms=0))
    assert _norm(str(ei.value)) == _norm(want["__error__"])
    assert ei.value.blocker.kind == "reclaim" and ei.value.owner is None


def test_python_takes_over_a_lock_v9_left_behind_and_v9_takes_over_one_python_left_behind(tmp_path: Path):
    r1 = tmp_path / "left-by-v9"
    left = v9("review/lock", "acquireStoreLock", str(r1))  # the node process exits without releasing: a dead owner
    assert _owner(r1)["pid"] != os.getpid()
    h = acquire_store_lock(str(r1), StoreLockOptions(timeout_ms=1000))
    assert _owner(r1)["ownerId"] == h.owner_id != left["ownerId"]
    assert h.release().status == "released" and os.listdir(r1) == []
    r2 = tmp_path / "left-by-py"
    script = "import sys; from odd_claude.review.lock import acquire_store_lock; acquire_store_lock(sys.argv[1])"
    subprocess.run([sys.executable, "-c", script, str(r2)], env={**os.environ, "PYTHONPATH": str(SRC)}, check=True, timeout=60)
    before = _owner(r2)
    got = v9("review/lock", "acquireStoreLock", str(r2), {"timeoutMs": 1000})
    assert isinstance(got, dict) and got["ownerId"] != before["ownerId"], got
    assert _owner(r2)["ownerId"] == got["ownerId"]


def test_the_two_implementations_agree_a_live_foreign_lock_blocks(tmp_path: Path):
    root = tmp_path / "v2"
    h = acquire_store_lock(str(root))  # held by this live process
    got = v9("review/lock", "acquireStoreLock", str(root), {"timeoutMs": 0})
    assert "review store lock is held by pid" in got["__error__"] and str(os.getpid()) in got["__error__"]
    assert _owner(root)["ownerId"] == h.owner_id
    h.release()
