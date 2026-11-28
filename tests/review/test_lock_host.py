"""Port of v9 review/lock-host.spec.ts (11 test() cases)."""
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from odd_claude.review.lock import StoreLockContended, StoreLockOptions, acquire_store_lock, store_lock_path
from review.conftest import dead_pid

M1 = "11111111-1111-4111-8111-111111111111"
M2 = "22222222-2222-4222-8222-222222222222"
B1 = "boot-one/pid:[4026531836]"
B2 = "boot-one/pid:[4026532999]"  # same boot, another pid namespace (a container)
SRC = Path(__file__).resolve().parents[2] / "src"


def seed(root: Path, **owner) -> Path:
    lock = Path(store_lock_path(str(root)))
    lock.mkdir(parents=True, exist_ok=True)
    (lock / "owner.json").write_text(json.dumps({"ownerId": "deadbeef", "startedAt": 1, **owner}))
    return lock


def quick(**kw) -> StoreLockOptions:
    return StoreLockOptions(timeout_ms=300, poll_ms=10, **kw)


def rec(root: Path) -> dict:
    return json.loads((Path(store_lock_path(str(root))) / "owner.json").read_text())


def test_same_machine_id_dead_owner_different_hostname_taken_over(tmp_path: Path):
    root = tmp_path / "v2"
    seed(root, pid=dead_pid(), host="192.168.168.105", machine=M1, boot=B1)
    h = acquire_store_lock(str(root), quick(host="192.168.1.89", machine_id=M1, boot_id=B1))
    r = rec(root)
    assert (r["host"], r["machine"], r["boot"], r["pid"]) == ("192.168.1.89", M1, B1, os.getpid())
    assert h.release().status == "released"


def test_same_machine_id_live_owner_different_hostname_contended_record_untouched(tmp_path: Path):
    root = tmp_path / "v2"
    lock = seed(root, pid=os.getpid(), host="elsewhere", machine=M1, boot=B1)
    before = (lock / "owner.json").read_text()
    with pytest.raises(StoreLockContended) as ei:
        acquire_store_lock(str(root), quick(host="other-name", machine_id=M1, boot_id=B1))
    e = ei.value
    assert e.owner.pid == os.getpid()
    assert f"pid {os.getpid()} on elsewhere" in str(e) and M1[:8] in str(e) and f"boot {B1[:8]}" in str(e)
    assert (lock / "owner.json").read_text() == before


def test_d_different_machine_ids_same_hostname_dead_pid_hostname_rule_taken_over(tmp_path: Path):
    root = tmp_path / "v2"
    seed(root, pid=dead_pid(), host="same-host", machine=M2, boot=B1)
    h = acquire_store_lock(str(root), quick(host="same-host", machine_id=M1, boot_id=B1))
    assert h.release().status == "released"


def test_different_machine_ids_and_different_hostnames_never_local_record_untouched(tmp_path: Path):
    root = tmp_path / "v2"
    lock = seed(root, pid=dead_pid(), host="host-a", machine=M2, boot=B1)
    before = (lock / "owner.json").read_text()
    with pytest.raises(StoreLockContended):
        acquire_store_lock(str(root), quick(host="host-b", machine_id=M1, boot_id=B1))
    assert (lock / "owner.json").read_text() == before


@pytest.mark.parametrize("live", [True, False])
def test_a_same_machine_id_different_boot_identity_other_hostname_contended_byte_identical(tmp_path: Path, live: bool):
    root = tmp_path / "v2"
    lock = seed(root, pid=os.getpid() if live else dead_pid(), host="host-container", machine=M1, boot=B2)
    before = (lock / "owner.json").read_bytes()
    with pytest.raises(StoreLockContended):
        acquire_store_lock(str(root), quick(host="host-mac", machine_id=M1, boot_id=B1))
    assert (lock / "owner.json").read_bytes() == before


def test_c_same_machine_id_boot_missing_on_the_record_or_here_hostname_rule(tmp_path: Path):
    root = tmp_path / "v2"
    lock = seed(root, pid=dead_pid(), host="old-host", machine=M1)
    with pytest.raises(StoreLockContended):
        acquire_store_lock(str(root), quick(host="new-host", machine_id=M1, boot_id=B1))
    assert json.loads((lock / "owner.json").read_text())["host"] == "old-host"
    with pytest.raises(StoreLockContended):
        acquire_store_lock(str(root), quick(host="new-host", machine_id=M1, boot_id=None))
    assert acquire_store_lock(str(root), quick(host="old-host", machine_id=M1, boot_id=B1)).release().status == "released"
    seed(root, pid=dead_pid(), host="old-host", machine=M1, boot=B1)
    assert acquire_store_lock(str(root), quick(host="old-host", machine_id=M1, boot_id=None)).release().status == "released"


def test_a_test_supplied_host_without_machine_id_records_no_machine_and_no_boot(tmp_path: Path):
    root = tmp_path / "v2"
    h = acquire_store_lock(str(root), quick(host="fake-host"))
    r = rec(root)
    assert r["host"] == "fake-host" and "machine" not in r and "boot" not in r
    assert list(r) == ["pid", "host", "ownerId", "startedAt"]
    assert h.release().status == "released"


def test_old_record_without_machine_different_hostname_fail_closed_same_hostname_taken_over(tmp_path: Path):
    root = tmp_path / "v2"
    lock = seed(root, pid=dead_pid(), host="old-host")
    before = (lock / "owner.json").read_text()
    with pytest.raises(StoreLockContended):
        acquire_store_lock(str(root), quick(host="new-host", machine_id=M1))
    assert (lock / "owner.json").read_text() == before
    assert acquire_store_lock(str(root), quick(host="old-host", machine_id=M1)).release().status == "released"


def test_no_machine_id_available_hostname_only_behaves_as_before_record_has_no_machine(tmp_path: Path):
    root = tmp_path / "v2"
    seed(root, pid=dead_pid(), host=socket.gethostname(), machine=M1)
    h = acquire_store_lock(str(root), quick(machine_id=None))
    r = rec(root)
    assert "machine" not in r and r["host"] == socket.gethostname()
    assert h.release().status == "released"


def test_a_malformed_machine_field_is_ignored_hostname_rule_applies(tmp_path: Path):
    root = tmp_path / "v2"
    seed(root, pid=dead_pid(), host="old-host", machine="not-a-uuid")
    with pytest.raises(StoreLockContended):
        acquire_store_lock(str(root), quick(host="new-host", machine_id=M1))


def test_a_real_process_crash_after_a_hostname_change_is_taken_over_using_the_persisted_id(tmp_path: Path):
    root, state, ready = tmp_path / "v2", tmp_path / "state", tmp_path / "ready"
    state.mkdir()
    script = (
        "import sys, time\n"
        "from odd_claude.review.lock import StoreLockOptions, acquire_store_lock\n"
        "from odd_claude.review.machine_id import machine_id\nfrom odd_claude.review.boot_id import boot_id\n"
        "acquire_store_lock(sys.argv[1], StoreLockOptions(host='old-name', machine_id=machine_id(), boot_id=boot_id()))\n"
        "open(sys.argv[2], 'w').write('r')\nwhile True: time.sleep(1)\n"
    )
    child = subprocess.Popen([sys.executable, "-c", script, str(root), str(ready)], env={**os.environ, "PYTHONPATH": str(SRC), "XDG_STATE_HOME": str(state)})
    try:
        t0 = time.time()
        while not ready.exists():
            assert time.time() - t0 < 10, "child never acquired"
            time.sleep(0.02)
        r = rec(root)
        assert r["host"] == "old-name"
        assert len(r["machine"]) == 36
        child.kill()
        child.wait()
        h = acquire_store_lock(str(root), quick(host="new-name", machine_id=r["machine"], boot_id=r.get("boot")))
        assert h.release().status == "released"
    finally:
        child.kill()
        child.wait()
