import json
import os
import signal
import subprocess
import sys
import time

from odd_claude.lib.lock import LockOptions, acquire_lock, lock_path, release_lock, release_owned_lock, set_lock_pid

from .conftest import dead_pid, run_py, spawn_py

DEAD = 999999


def rd(p):
    return json.loads(open(p).read())


def ls(d):
    return sorted(os.listdir(d))


def old(p, secs=10):
    t = time.time() - secs
    os.utime(p, (t, t))


def test_lock_is_keyed_by_kind_and_project_path():
    assert lock_path("/d", "warm", "/a") != lock_path("/d", "warm", "/b")
    assert lock_path("/d", "warm", "/a") != lock_path("/d", "registry", "/a")
    assert lock_path("/d", "warm", "/a") == lock_path("/d", "warm", "/a/")
    assert lock_path("/d", "warm", "/a").startswith("/d/locks/warm-") and lock_path("/d", "warm", "/a").endswith(".lock")


def test_second_acquire_while_held_by_a_live_pid_fails_release_by_owner_frees_it(tmp_path):
    p = lock_path(str(tmp_path), "warm", "/proj")
    o = LockOptions(stale_ms=60_000, is_alive=lambda _: True)
    assert acquire_lock(p, 111, o) is True
    assert acquire_lock(p, 222, o) is False
    release_lock(p, 999)  # not the owner
    assert os.path.exists(p)
    set_lock_pid(p, 333)
    release_lock(p, 333)
    assert not os.path.exists(p)
    assert acquire_lock(p, 222, o) is True


def test_stale_by_age_or_dead_pid_is_replaced_corrupt_lock_is_replaced(tmp_path):
    p = lock_path(str(tmp_path), "warm", "/proj")
    now = [1_000]
    o = lambda pid_alive: LockOptions(stale_ms=100, now=lambda: now[0], is_alive=lambda _: pid_alive)
    assert acquire_lock(p, 1, o(True)) is True
    now[0] += 50
    assert acquire_lock(p, 2, o(True)) is False
    now[0] += 100
    assert acquire_lock(p, 3, o(True)) is True
    assert acquire_lock(p, 4, o(False)) is True  # dead pid
    open(p, "w").write("not json")
    old(p)  # unreadable content is stale only when its mtime is older than stale_ms
    assert acquire_lock(p, 5, o(True)) is True
    assert rd(p)["pid"] == 5


def test_stale_takeover_is_exclusive_under_interleaving(tmp_path):
    p = lock_path(str(tmp_path), "warm", "/x/proj")
    acquire_lock(p, 1, LockOptions(stale_ms=1000))
    open(p, "w").write(json.dumps({"pid": DEAD, "startedAt": int(time.time() * 1000)}))
    b = []

    def alive(pid):
        if pid == DEAD and not b:
            b.append(acquire_lock(p, 222, LockOptions(stale_ms=360000, is_alive=lambda _: False)))
        return pid != DEAD

    a = acquire_lock(p, 111, LockOptions(stale_ms=360000, is_alive=alive))
    assert [a, *b].count(True) == 1


def test_a_child_that_exits_before_set_lock_pid_leaves_no_lock(tmp_path):
    p = lock_path(str(tmp_path), "warm", "/x/proj")
    assert acquire_lock(p, 111, LockOptions(stale_ms=360000)) is True
    release_lock(p, 333)
    set_lock_pid(p, 333)
    assert not os.path.exists(p)


def test_an_empty_or_corrupt_fresh_lock_is_held_older_than_stale_ms_it_is_taken_over(tmp_path):
    os.mkdir(tmp_path / "locks")
    p = str(tmp_path / "locks" / "x.lock")
    open(p, "w").close()
    assert acquire_lock(p, 1, LockOptions(stale_ms=2000)) is False
    assert open(p).read() == ""
    old(p, 5)
    assert acquire_lock(p, 2, LockOptions(stale_ms=2000)) is True
    assert rd(p)["pid"] == 2


def test_acquire_is_atomic_with_content_and_leaves_no_temp_or_marker_files(tmp_path):
    p = str(tmp_path / "locks" / "y.lock")
    assert acquire_lock(p, 7, LockOptions(stale_ms=2000)) is True
    assert rd(p)["pid"] == 7 and isinstance(rd(p)["startedAt"], int)
    assert acquire_lock(p, 8, LockOptions(stale_ms=2000, is_alive=lambda _: True)) is False
    assert ls(tmp_path / "locks") == ["y.lock"]
    release_lock(p, 7)
    assert ls(tmp_path / "locks") == []


def test_proof_of_death_only_never_takes_over_a_live_holder_by_age_a_dead_holder_is_taken_over(tmp_path):
    p = str(tmp_path / "locks" / "d.lock")
    now = [1_000]
    o = lambda alive: LockOptions(stale_ms=100, now=lambda: now[0], is_alive=lambda _: alive, proof_of_death_only=True)
    assert acquire_lock(p, 1, o(True)) is True
    now[0] += 10_000
    assert acquire_lock(p, 2, o(True)) is False
    assert rd(p)["pid"] == 1
    assert acquire_lock(p, 3, o(False)) is True
    assert rd(p)["pid"] == 3
    assert ls(tmp_path / "locks") == ["d.lock"]


def test_a_live_takeover_claimant_blocks_another_takeover_a_dead_claim_is_swept(tmp_path):
    d = tmp_path / "locks"
    d.mkdir()
    p = str(d / "c.lock")
    open(p, "w").write(json.dumps({"pid": DEAD, "startedAt": 1}))
    claim = str(d / "c.lock.claim-live")
    open(claim, "w").write(json.dumps({"pid": 4242}))
    alive = lambda pid: pid == 4242
    assert acquire_lock(p, 777, LockOptions(stale_ms=60_000, is_alive=alive)) is False  # 4242 is alive and claiming
    assert rd(p)["pid"] == DEAD
    assert ls(d) == ["c.lock", "c.lock.claim-live"]
    open(claim, "w").write(json.dumps({"pid": 31337}))  # now the claimant is dead
    assert acquire_lock(p, 777, LockOptions(stale_ms=60_000, is_alive=alive)) is True
    assert rd(p)["pid"] == 777
    assert ls(d) == ["c.lock"]


STRESS = """
import os, sys, time, random
from odd_claude.lib.lock import LockOptions, acquire_lock, release_owned_lock
p, inside, overlaps, die = sys.argv[1:5]
deadline = time.time() + 30
while not acquire_lock(p, os.getpid(), LockOptions(stale_ms=2000, proof_of_death_only=True)):
    if time.time() > deadline: sys.exit(3)
    time.sleep((1 + random.random() * 4) / 1000)
try:
    os.close(os.open(inside, os.O_WRONLY | os.O_CREAT | os.O_EXCL))
except FileExistsError:
    open(overlaps, "a").write("x")
time.sleep(0.003)
try: os.unlink(inside)
except OSError: pass
if die != "1": release_owned_lock(p, os.getpid())
"""


def test_processes_that_die_holding_the_lock_never_let_two_live_holders_overlap(tmp_path):
    p, inside, overlaps = str(tmp_path / "locks" / "s.lock"), str(tmp_path / "inside"), str(tmp_path / "overlaps")
    for wave in range(6):
        procs = [spawn_py(STRESS, p, inside, overlaps, "1" if i % 2 == 0 else "0") for i in range(8)]
        # Reap exited children as they finish: an unreaped zombie still answers kill(pid, 0), so it would look alive.
        end = time.time() + 90
        while [c.poll() for c in procs].count(None):
            assert time.time() < end, f"wave {wave} hung"
            time.sleep(0.002)
        assert [c.returncode for c in procs] == [0] * 8, f"wave {wave}"
    assert not os.path.exists(overlaps), "two processes were inside the critical section at once"
    assert [f for f in os.listdir(tmp_path / "locks") if f != "s.lock"] == []


PAUSED = """
import os, sys, time
from odd_claude.lib.lock import LockOptions, acquire_lock, release_owned_lock
p, ev, pause, hold, proof = sys.argv[1:6]
pause = float(pause) / 1000
rn, once = os.rename, []
def patched(a, b, *x, **k):
    if pause and not once and a == p:
        once.append(1)
        open(ev + ".paused", "w").close()
        time.sleep(pause)
    return rn(a, b, *x, **k)
os.rename = patched
end = time.time() + 0.3
while not acquire_lock(p, os.getpid(), LockOptions(stale_ms=2000, proof_of_death_only=proof == "1")):
    if time.time() > end: sys.exit(0)
    time.sleep(0.005)
open(ev, "a").write("+\\n"); time.sleep(float(hold) / 1000); open(ev, "a").write("-\\n")
release_owned_lock(p, os.getpid())
"""


def max_holders(ev):
    n = m = 0
    for line in open(ev).read().split("\n"):
        if line == "+":
            n += 1
            m = max(m, n)
        if line == "-":
            n -= 1
    return m


def wait_for(path, secs=20):
    end = time.time() + secs
    while not os.path.exists(path):
        assert time.time() < end, f"{path} never appeared"
        time.sleep(0.01)


def test_an_age_based_takeover_never_removes_a_fresh_lock_created_after_the_old_live_holder_released(tmp_path):
    h = subprocess.Popen(["/bin/sleep", "20"])
    try:
        (tmp_path / "locks").mkdir()
        p, ev = str(tmp_path / "locks" / "w.lock"), str(tmp_path / "ev")
        open(p, "w").write(json.dumps({"pid": h.pid, "startedAt": int(time.time() * 1000) - 10_000}))
        p1 = spawn_py(PAUSED, p, ev, "1500", "1000", "0")
        wait_for(ev + ".paused")  # p1 judged the lock stale by age and is paused before moving it
        os.unlink(p)
        p3 = spawn_py(PAUSED, p, ev, "0", "2500", "0")
        p1.wait(timeout=60), p3.wait(timeout=60)
        assert max_holders(ev) == 1, "a fresh lock was moved aside: two holders"
    finally:
        h.kill()
        h.wait()


def test_a_dead_pid_takeover_paused_between_reread_and_move_never_yields_two_holders(tmp_path):
    (tmp_path / "locks").mkdir()
    p, ev = str(tmp_path / "locks" / "s.lock"), str(tmp_path / "ev")
    open(p, "w").write(json.dumps({"pid": DEAD, "startedAt": 1}))
    p1 = spawn_py(PAUSED, p, ev, "1500", "300", "1")
    wait_for(ev + ".paused")
    others = [spawn_py(PAUSED, p, ev, "0", "20", "1") for _ in range(8)]
    for c in [p1, *others]:
        c.wait(timeout=60)
    assert max_holders(ev) == 1


def test_an_empty_claim_older_than_stale_ms_does_not_block_a_dead_pid_takeover_forever(tmp_path):
    (tmp_path / "locks").mkdir()
    p = str(tmp_path / "locks" / "e.lock")
    open(p, "w").write(json.dumps({"pid": DEAD, "startedAt": 1}))
    open(f"{p}.claim-12345-crashed", "w").close()
    os.utime(f"{p}.claim-12345-crashed", (0, 0))
    assert acquire_lock(p, os.getpid(), LockOptions(stale_ms=2000, proof_of_death_only=True)) is True
    assert ls(tmp_path / "locks") == ["e.lock"]


def test_dead_pid_and_old_unreadable_stale_leftovers_are_swept_a_live_one_is_kept(tmp_path):
    d = tmp_path / "locks"
    d.mkdir()
    p = str(d / "k.lock")
    alive = lambda pid: pid in (50, 60)
    assert acquire_lock(p, 50, LockOptions(stale_ms=2000, is_alive=alive)) is True  # a live holder: later acquires are contended
    open(f"{p}.1.dead.stale", "w").write(json.dumps({"pid": DEAD, "startedAt": 1}))
    open(f"{p}.1.old.stale", "w").close()
    os.utime(f"{p}.1.old.stale", (0, 0))
    open(f"{p}.1.fresh.stale", "w").close()  # possibly mid-write: kept
    open(f"{p}.1.live.stale", "w").write(json.dumps({"pid": 60, "startedAt": int(time.time() * 1000)}))
    assert acquire_lock(p, 60, LockOptions(stale_ms=2000, is_alive=alive)) is False
    assert ls(d) == ["k.lock", "k.lock.1.fresh.stale", "k.lock.1.live.stale"]
    assert rd(p)["pid"] == 50


def test_acquire_never_throws_and_fails_safe(tmp_path):
    (tmp_path / "f").write_text("x")
    assert acquire_lock(str(tmp_path / "f" / "sub" / "a.lock"), 1, LockOptions(stale_ms=1)) is False
    release_lock(str(tmp_path / "nope.lock"), 1)
    release_owned_lock(str(tmp_path / "nope.lock"), 1)
    set_lock_pid(str(tmp_path / "nodir" / "x.lock"), 1)


# --- S3: cross-process semantics with real child processes (no mocks of the lock) ---

HOLD = """
import os, sys
from odd_claude.lib.lock import LockOptions, acquire_lock, release_owned_lock
p = sys.argv[1]
assert acquire_lock(p, os.getpid(), LockOptions(stale_ms=int(sys.argv[2]), proof_of_death_only=True))
print("held", flush=True)
if sys.stdin.readline().strip() == "release":
    release_owned_lock(p, os.getpid())
    print("released", flush=True)
sys.stdin.read()
"""

TRY = """
import os, sys
from odd_claude.lib.lock import LockOptions, acquire_lock
ok = acquire_lock(sys.argv[1], os.getpid(), LockOptions(stale_ms=int(sys.argv[2]), proof_of_death_only=sys.argv[3] == "1"))
print(os.getpid() if ok else "no")
"""

RACE = """
import os, sys, time
from odd_claude.lib.lock import LockOptions, acquire_lock
p, go = sys.argv[1:3]
while not os.path.exists(go): time.sleep(0.001)
ok = acquire_lock(p, os.getpid(), LockOptions(stale_ms=60000, proof_of_death_only=True))
print("won" if ok else "lost", flush=True)
time.sleep(1.5)
"""


def try_in_child(p, stale_ms=60_000, proof="1"):
    out = run_py(TRY, p, str(stale_ms), proof).stdout.strip()
    return None if out == "no" else int(out)


def start_holder(p):
    h = spawn_py(HOLD, p, "60000", stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    assert h.stdout.readline().strip() == "held"
    return h


def test_s3_exclusive_create_exactly_one_of_many_racing_processes_wins(tmp_path):
    p, go = str(tmp_path / "locks" / "r.lock"), str(tmp_path / "go")
    procs = [spawn_py(RACE, p, go, stdout=subprocess.PIPE, text=True) for _ in range(6)]
    time.sleep(0.5)
    open(go, "w").close()
    results = [c.stdout.readline().strip() for c in procs]
    for c in procs:
        c.wait(timeout=30)
    assert sorted(results) == ["lost"] * 5 + ["won"]
    assert rd(p)["pid"] in [c.pid for c in procs]


def test_s3_owned_release_only_the_owner_frees_the_lock_and_no_marker_remains(tmp_path):
    p = str(tmp_path / "locks" / "o.lock")
    h = start_holder(p)
    try:
        assert rd(p)["pid"] == h.pid
        release_owned_lock(p, os.getpid())  # not the owner: no-op
        assert rd(p)["pid"] == h.pid
        assert try_in_child(p) is None  # live holder in another process
        h.stdin.write("release\n"), h.stdin.flush()
        assert h.stdout.readline().strip() == "released"
        assert ls(tmp_path / "locks") == []
        assert try_in_child(p) is not None
    finally:
        h.kill()
        h.wait()


def test_s3_kill_9_holder_is_taken_over_by_a_contender_process(tmp_path):
    p = str(tmp_path / "locks" / "k.lock")
    h = start_holder(p)
    assert try_in_child(p) is None  # held while alive, by another process
    os.kill(h.pid, signal.SIGKILL)  # kill -9: no release runs
    h.wait()
    assert rd(p)["pid"] == h.pid  # the lock file outlives its holder
    taker = try_in_child(p)
    assert taker is not None and taker != h.pid
    assert rd(p)["pid"] == taker
    assert ls(tmp_path / "locks") == ["k.lock"]


def test_s3_eperm_live_pid_of_another_user_pid_1_is_not_taken_over(tmp_path):
    (tmp_path / "locks").mkdir()
    p = str(tmp_path / "locks" / "e.lock")
    raw = json.dumps({"pid": 1, "startedAt": int(time.time() * 1000)})
    open(p, "w").write(raw)
    assert try_in_child(p) is None
    assert open(p).read() == raw
    assert ls(tmp_path / "locks") == ["e.lock"]


def test_s3_esrch_dead_pid_is_taken_over(tmp_path):
    (tmp_path / "locks").mkdir()
    p = str(tmp_path / "locks" / "d.lock")
    open(p, "w").write(json.dumps({"pid": dead_pid(), "startedAt": int(time.time() * 1000)}))
    taker = try_in_child(p)
    assert taker is not None
    assert rd(p)["pid"] == taker
    assert ls(tmp_path / "locks") == ["d.lock"]
