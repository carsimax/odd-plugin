"""Port of v9 review/lock-race.spec.ts (19 test() cases; the edge table and kill-step loop expand to more)."""
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from odd_claude.review.lock import StoreLockContended, StoreLockError, StoreLockOptions, acquire_store_lock, store_lock_path, with_store_lock
from review.conftest import age, dead_pid, seed_dir, tree_hash
from review.lock_testkit import KILLAT_SCRIPT, Events, Rule, Worker, fault_injection  # noqa: F401

SRC = Path(__file__).resolve().parents[2] / "src"
ENV = {**os.environ, "PYTHONPATH": str(SRC)}
H = socket.gethostname()
LOCK = "LOCK"
Q = StoreLockOptions


@pytest.fixture
def root(tmp_path: Path) -> Path:
    r = tmp_path / "v2"
    r.mkdir()
    return r


def lockp(root: Path) -> Path:
    return Path(store_lock_path(str(root)))


def rec(root: Path, name: str = LOCK) -> dict:
    return json.loads((root / name / "owner.json").read_text())


def sleep_until(pred, label: str, limit: float = 5) -> None:
    t0 = time.time()
    while not pred():
        assert time.time() - t0 < limit, f"timeout waiting message {label}"
        time.sleep(0.01)


def wait_msg(out, pred, label):
    sleep_until(lambda: any(pred(m) for m in out), label)


def paused_reclaimer(root: Path):
    seed_dir(lockp(root), "X-dead-holder")
    ev, out = Events(), []
    # C1 becomes the sole claimant and pauses right before moving the stale LOCK away.
    c1 = Worker(ev, str(root), "C1", [Rule("^LOCK$", "^LOCK\\.stale-", signal=2, wait=3)], out, acquired_ev=8, holder_ev=12)
    ev.wait(2, "C1 holds the claim at the LOCK move")
    return ev, out, c1


def release_all(ev: Events, *workers: Worker) -> None:
    for i in (3, 5, 7, 12):
        ev.raise_(i)
    for w in workers:
        w.join()


def test_f1_double_a_second_contender_can_never_take_over_while_the_sole_claimant_is_mid_takeover(root, fault_injection):
    ev, out, c1 = paused_reclaimer(root)
    try:
        assert rec(root)["ownerId"] == "X-dead-holder"
        # C4 sees the stale LOCK and C1's live claim: it must back off, touching neither.
        c4w = Worker(ev, str(root), "C4", [], out, timeout_ms=400)
        c4w.join()
        c4 = next(m for m in out if m["name"] == "C4")
        assert c4["error"] == "StoreLockContended"
        assert c4["blocker"]["kind"] == "reclaim", "F4: the actual blocker is the live reclaimer"
        assert c4["blocker"]["owner"]["pid"] == os.getpid()
        assert re.search(r"being reclaimed by pid \d+", c4["message"])
        assert rec(root)["ownerId"] == "X-dead-holder", "LOCK untouched by the loser"
        assert any(re.fullmatch(r"LOCK\.claim-[0-9a-f]{32}", n) for n in os.listdir(root)), "C1's live claim untouched"
        ev.raise_(3)
        ev.wait(8, "C1 acquired")
        wait_msg(out, lambda m: m["name"] == "C1" and "acquired" in m, "C1 acquired message")
        c5 = Worker(ev, str(root), "C5", [], out, timeout_ms=150)  # exactly one holder: C5 cannot get in while C1 holds
        c5.join()
        m5 = next(m for m in out if m["name"] == "C5")
        assert m5["error"] == "StoreLockContended" and m5["blocker"]["kind"] == "lock"
        assert rec(root)["ownerId"] == next(m for m in out if m["name"] == "C1" and "acquired" in m)["acquired"]
        assert sum(1 for m in out if "acquired" in m) == 1
        ev.raise_(12)
        c1.join()
        wait_msg(out, lambda m: "released" in m, "C1 released message")
        assert next(m for m in out if "released" in m)["released"] == "released"
        assert os.listdir(root) == []
    finally:
        release_all(ev, c1)


def test_f2_resurrect_after_a_contended_takeover_finishes_a_later_dead_lock_is_reclaimed_within_budget(root, fault_injection):
    ev, out, c1 = paused_reclaimer(root)
    try:
        Worker(ev, str(root), "C4", [], out, timeout_ms=200).join()
        ev.raise_(3)
        ev.wait(8, "C1 acquired")
        wait_msg(out, lambda m: m["name"] == "C1" and "acquired" in m, "C1 acquired message")
        ev.raise_(12)
        c1.join()
        assert os.listdir(root) == [], "nothing revived by anyone"
        seed_dir(lockp(root), "X2-later-crashed-holder")
        t0 = time.time()
        h = acquire_store_lock(str(root))  # default 2 s budget
        assert time.time() - t0 < 0.5
        assert rec(root)["ownerId"] == h.owner_id
        h.release()
        assert os.listdir(root) == []
    finally:
        release_all(ev, c1)


def paused_after_move(root: Path, timeout_ms: float = 8000):
    seed_dir(lockp(root), "X-dead-holder")
    ev, out = Events(), []
    # C1 (sole claimant) pauses right AFTER it renamed LOCK to LOCK.stale-*, before it observes it.
    c1 = Worker(ev, str(root), "C1", [Rule("^LOCK$", "^LOCK\\.stale-", after=True, signal=2, wait=3)], out, acquired_ev=8, holder_ev=12, timeout_ms=timeout_ms)
    ev.wait(2, "C1 paused after the move")
    names = [n for n in os.listdir(root) if n.startswith("LOCK.stale-")]
    assert len(names) == 1, f"expected one reserved entry, got {names}"
    return ev, out, c1, root / names[0]


def test_move_away_a_concurrent_sweep_deleting_owner_json_of_the_moved_dead_lock_is_the_same_dead_owner(root, fault_injection):
    ev, out, c1, reserved = paused_after_move(root)
    try:
        (reserved / "owner.json").unlink()  # what sweep() does first (owner.json before the directory)
        ev.raise_(3)
        ev.wait(8, "C1 acquired")
        wait_msg(out, lambda m: m["name"] == "C1" and ("acquired" in m or "error" in m), "C1 outcome message")
        assert not any(m["name"] == "C1" and "error" in m for m in out), out
        assert sum(1 for m in out if "acquired" in m) == 1
        assert rec(root)["ownerId"] == next(m for m in out if "acquired" in m)["acquired"]
        ev.raise_(12)
        c1.join()
        wait_msg(out, lambda m: "released" in m, "C1 released message")
        assert next(m for m in out if "released" in m)["released"] == "released"
        assert os.listdir(root) == [], "reserved entry removed"
    finally:
        release_all(ev, c1)


def test_move_away_a_genuine_identity_mismatch_is_put_back_at_lock_free_not_lost_never_two_holders(root, fault_injection):
    import shutil

    ev, out, c1, reserved = paused_after_move(root, 400)
    try:
        shutil.rmtree(reserved)
        seed_dir(reserved, "foreign-live", os.getpid())  # a different, live instance (different inode)
        ev.raise_(3)
        c1.join()
        assert sum(1 for m in out if "acquired" in m) == 0, "nobody may acquire over a live foreign record"
        assert next(m for m in out if "error" in m)["error"] == "StoreLockContended", out
        assert rec(root)["ownerId"] == "foreign-live", "foreign record restored at LOCK"
        assert os.listdir(root) == ["LOCK"], "no stranded copy"
    finally:
        release_all(ev, c1)


def test_move_away_a_mismatch_while_lock_is_taken_keeps_the_foreign_record_aside_and_fails_closed(root, fault_injection):
    import shutil

    ev, out, c1, reserved = paused_after_move(root, 400)
    try:
        shutil.rmtree(reserved)
        seed_dir(reserved, "foreign-live", os.getpid())
        seed_dir(lockp(root), "third-live", os.getpid())  # someone published meanwhile
        ev.raise_(3)
        c1.join()
        assert sum(1 for m in out if "acquired" in m) == 0
        assert next(m for m in out if "error" in m)["error"] == "StoreLockError", out
        assert rec(root)["ownerId"] == "third-live", "current LOCK untouched"
        assert rec(root, reserved.name)["ownerId"] == "foreign-live", "foreign record kept aside, not lost"
        with pytest.raises(StoreLockContended):  # the displaced owner's next ownership check fails closed
            with_store_lock(str(root), lambda: 1, Q(timeout_ms=50))
    finally:
        release_all(ev, c1)


def wait_b_settled(ev: Events, b: Worker, limit_s: float) -> None:
    # Release A only once B has SETTLED: finished (backed off) or paused at its own move (ev 2). A timeout is a test
    # failure (starved worker), never a reason to continue.
    t0 = time.time()
    while time.time() - t0 < limit_s:
        if not b.thread.is_alive() or ev.is_set(2):
            return
        time.sleep(0.01)
    raise AssertionError(f"B neither finished nor reached its move within {limit_s} s (starved worker?)")


def broken_exclusivity(root: Path, hide_claims: float) -> list[dict]:
    seed_dir(lockp(root), "D-dead-holder")
    ev, out = Events(), []
    src, dst = "^LOCK$", "^LOCK\\.stale-"
    a = Worker(ev, str(root), "A", [Rule(src, dst, signal=6, wait=7)], out, acquired_ev=8, holder_ev=12)
    workers = [a]
    try:
        ev.wait(6, "A (sole claimant) at the move")
        # B cannot see A's claim on its claim listing, so it believes it is alone.
        b = Worker(ev, str(root), "B", [Rule(src, dst, signal=2, wait=3), Rule(src, dst, after=True, signal=4, wait=5)], out, hide_claims=hide_claims, timeout_ms=300)
        workers.append(b)
        wait_b_settled(ev, b, 20)
        ev.raise_(7)  # A moves the dead lock, publishes and holds
        ev.wait(8, "A acquired")
        wait_msg(out, lambda m: m["name"] == "A" and ("acquired" in m or "error" in m), "A outcome message")
        ev.raise_(3)
        if ev.is_set(2):
            ev.wait(4, "B moved A's live LOCK aside")
        c = Worker(ev, str(root), "C", [], out, timeout_ms=300)
        workers.append(c)
        c.join()
        return list(out)
    finally:
        release_all(ev, *workers)


def test_a1_with_a_live_claim_hidden_from_the_first_claim_listing_the_pre_move_recheck_makes_b_back_off(root, fault_injection):
    out = broken_exclusivity(root, 1)
    assert [m["name"] for m in out if "acquired" in m] == ["A"], out
    assert next(m for m in out if m["name"] == "B" and "error" in m)["error"] == "StoreLockContended", out
    assert next(m for m in out if m["name"] == "C" and "error" in m)["error"] == "StoreLockContended", out


@pytest.mark.xfail(reason="documented limit: needs renamex_np RENAME_EXCL / renameat2 (a no-replace rename)", strict=False)
def test_a1_documented_limit_claims_hidden_on_every_listing_cannot_be_closed_without_a_no_replace_rename(root, fault_injection):
    out = broken_exclusivity(root, 1e9)
    assert [m["name"] for m in out if "acquired" in m] == ["A"], out


# --- edge-case table (ported from edge.mjs) ---------------------------------------------------------------------------


def mk_lock(root: Path, rec_=None, raw=None) -> Path:
    lk = lockp(root)
    lk.mkdir()
    if rec_ is not None or raw is not None:
        (lk / "owner.json").write_text(raw if raw is not None else json.dumps(rec_))
    return lk


def claim_name(root: Path) -> Path:
    return root / f"LOCK.claim-{'ab' * 16}"


def _sym(r: Path) -> None:
    tgt = r.parent / "foreign"
    seed_dir(tgt, "sym", os.getpid())
    os.symlink(tgt, lockp(r))


def _plain_aged(r: Path, secs: float, opts=None) -> None:
    lockp(r).write_text("junk")
    age(lockp(r), secs * 1000)


def _dead_lock_dead_claim(r: Path) -> None:
    seed_dir(lockp(r), "X")
    seed_dir(claim_name(r), "deadclaim")


def _dead_lock_old_file_claim(r: Path) -> None:
    seed_dir(lockp(r), "X")
    claim_name(r).write_text("")
    age(claim_name(r), 60e3)


def _unreadable(pid_rec):
    return lambda r: mk_lock(r, pid_rec(dead_pid()))


def _dead_lock_with(claim_setup):
    def setup(r: Path) -> None:
        seed_dir(lockp(r), "X")
        claim_setup(r)

    return setup


EDGES = [
    ("3a live pid aged 1 day", "Contended", None, lambda r: age(mk_lock(r, {"pid": os.getpid(), "host": H, "ownerId": "live", "startedAt": 1}), 864e5)),
    ("3b pid 1 (EPERM => alive)", "Contended", None, lambda r: age(mk_lock(r, {"pid": 1, "host": H, "ownerId": "eperm", "startedAt": 1}), 864e5)),
    ("3c other host, dead pid, aged", "Contended", None, lambda r: age(mk_lock(r, {"pid": dead_pid(), "host": "other.invalid", "ownerId": "remote", "startedAt": 1}), 864e5)),
    ("3d fresh unreadable (empty)", "Contended", None, lambda r: mk_lock(r, raw="")),
    ("3d fresh unreadable ({})", "Contended", None, lambda r: mk_lock(r, raw="{}")),
    ("3d fresh unreadable (garbage)", "Contended", None, lambda r: mk_lock(r, raw="\x00\x01zz")),
    ("3d fresh unreadable (pid string)", "Contended", None, _unreadable(lambda p: {"pid": str(p), "host": H, "ownerId": "x", "startedAt": 1})),
    ("3d fresh unreadable (pid 0)", "Contended", None, _unreadable(lambda p: {"pid": 0, "host": H, "ownerId": "x", "startedAt": 1})),
    ("3d fresh unreadable (ownerId empty)", "Contended", None, _unreadable(lambda p: {"pid": p, "host": H, "ownerId": "", "startedAt": 1})),
    ("3d fresh unreadable (pid float 1.5)", "Contended", None, _unreadable(lambda p: {"pid": 1.5, "host": H, "ownerId": "x", "startedAt": 1})),
    ("3d fresh unreadable (pid bool)", "Contended", None, _unreadable(lambda p: {"pid": True, "host": H, "ownerId": "x", "startedAt": 1})),
    ("3d fresh dir without owner.json", "Contended", None, lambda r: mk_lock(r)),
    ("3e LOCK plain file, fresh", "Contended", None, lambda r: lockp(r).write_text("junk")),
    ("3e plain file aged 59 min, stale_unreadable_ms 1 h", "Contended", {"stale_unreadable_ms": 3600e3}, lambda r: _plain_aged(r, 59 * 60)),
    ("3e plain file older than 30 s -> taken over", "ACQUIRED", None, lambda r: _plain_aged(r, 60)),
    ("3f LOCK symlink -> live foreign dir", "Contended", None, _sym),
    ("3h dead LOCK but LIVE claim", "Contended", None, lambda r: (seed_dir(lockp(r), "X"), seed_dir(claim_name(r), "liveclaim", os.getpid()))),
    ("3h dead LOCK, fresh plain-file claim", "Contended", None, lambda r: (seed_dir(lockp(r), "X"), claim_name(r).write_text(""))),
    ("3h dead LOCK, old plain-file claim -> recovered", "ACQUIRED", None, _dead_lock_old_file_claim),
    ("3h dead LOCK, dead claim -> recovered", "ACQUIRED", None, _dead_lock_dead_claim),
    ("5b EACCES root (0500)", "StoreLockError", None, lambda r: r.chmod(0o500)),
    ("5c EACCES on owner.json (no takeover)", "StoreLockError", None, lambda r: (lambda lk: (lk / "owner.json").chmod(0))(seed_dir(lockp(r), "X"))),
]


@pytest.mark.parametrize("label,want,opts,setup", EDGES, ids=[e[0] for e in EDGES])
def test_edge(root: Path, label, want, opts, setup):
    if label.startswith(("5b", "5c")) and os.getuid() == 0:
        pytest.skip("root ignores permissions")
    try:
        setup(root)
        base = None if want == "ACQUIRED" else tree_hash(root)
        t0 = time.perf_counter()
        try:
            acquire_store_lock(str(root), Q(timeout_ms=200, **(opts or {}))).release()
            got = "ACQUIRED"
        except StoreLockContended:
            got = "Contended"
        except StoreLockError:
            got = "StoreLockError"
        ms = (time.perf_counter() - t0) * 1000
        assert got == want
        if want == "ACQUIRED":
            assert [n for n in os.listdir(root) if n == "LOCK" or n.startswith("LOCK.claim-")] == [], "nothing held afterwards"
        else:
            assert tree_hash(root) == base, "tree unchanged on refusal"
        assert ms < 2500
    finally:
        root.chmod(0o700)
        for p in root.rglob("owner.json"):
            try:
                p.chmod(0o600)
            except OSError:
                pass


@pytest.mark.skipif(os.getuid() == 0, reason="root ignores permissions")
def test_edge_5b_eacces_on_the_parent_of_a_missing_root(root: Path):
    try:
        root.chmod(0o500)
        with pytest.raises(StoreLockError):
            acquire_store_lock(str(root / "sub" / "v2"), Q(timeout_ms=200))
        assert os.listdir(root) == []
    finally:
        root.chmod(0o700)


def test_edge_4a_release_by_a_non_owner_leaves_the_tree_unchanged(root: Path):
    import shutil

    a = acquire_store_lock(str(root))
    shutil.rmtree(lockp(root))
    mk_lock(root, {"pid": os.getpid(), "host": H, "ownerId": "B", "startedAt": 1})
    before = tree_hash(root)
    assert a.release().status == "not-owner"
    assert tree_hash(root) == before


def test_edge_4b_4c_4d_with_store_lock_lock_replaced_or_removed_mid_fn_fails_closed_the_fn_error_wins(root: Path):
    import shutil

    def replace():
        shutil.rmtree(lockp(root))
        mk_lock(root, {"pid": os.getpid(), "host": H, "ownerId": "B", "startedAt": 1})
        return 1

    with pytest.raises(StoreLockError, match=r"ownership was lost while held \(not-owner\)"):
        with_store_lock(str(root), replace)
    assert rec(root)["ownerId"] == "B", "B intact"
    shutil.rmtree(lockp(root))

    def remove():
        shutil.rmtree(lockp(root))
        return 1

    with pytest.raises(StoreLockError, match=r"ownership was lost while held \(absent\)"):
        with_store_lock(str(root), remove)

    def remove_then_boom():
        shutil.rmtree(lockp(root))
        raise RuntimeError("fn-boom")

    with pytest.raises(RuntimeError, match="fn-boom"):
        with_store_lock(str(root), remove_then_boom)


def test_edge_5a_default_budget_2s_contended_bounded(root: Path):
    h = acquire_store_lock(str(root))
    t0 = time.time()
    with pytest.raises(StoreLockContended):
        acquire_store_lock(str(root))
    ms = (time.time() - t0) * 1000
    assert 1900 <= ms < 3500, ms
    h.release()


# --- F3 sweep ---------------------------------------------------------------------------------------------------------


def test_f3_sweep_dead_owner_leftovers_are_removed_live_fresh_other_host_entries_and_lock_are_not_touched(root: Path):
    dead = dead_pid()
    seed_dir(root / "LOCK.tmp-aa", "a", dead)
    seed_dir(root / "LOCK.stale-bb", "b", dead)
    seed_dir(root / "LOCK.release-cc", "c", dead)
    seed_dir(claim_name(root), "d", dead)
    seed_dir(root / "LOCK.reclaim", "e", dead)  # legacy guard name
    seed_dir(root / "LOCK.tmp-live", "f", os.getpid())
    seed_dir(root / "LOCK.stale-remote", "g", dead, "other.invalid")
    (root / "LOCK.tmp-fresh-empty").mkdir()
    (root / "LOCK.tmp-old-empty").mkdir()
    age(root / "LOCK.tmp-old-empty", 3600e3)
    (root / "unrelated").write_text("x")
    h = acquire_store_lock(str(root))
    assert sorted(os.listdir(root)) == ["LOCK", "LOCK.stale-remote", "LOCK.tmp-fresh-empty", "LOCK.tmp-live", "unrelated"]
    h.release()


def test_f3_sweep_is_bounded_per_acquire_64_entries(root: Path):
    dead = dead_pid()
    for i in range(100):
        seed_dir(root / f"LOCK.stale-{i:03d}", f"o{i}", dead)
    acquire_store_lock(str(root)).release()
    assert len(os.listdir(root)) == 36
    acquire_store_lock(str(root)).release()
    assert os.listdir(root) == []


# --- kill -9 at each step (ported from kills.sh/killat.mjs) ------------------------------------------------------------

PROTOCOL = [
    ("publish: mkdir tmp", False, "mkdirSync", r"^LOCK\.tmp-[0-9a-f]+$"),
    ("publish: owner.json opened", False, "openSync", r"^LOCK\.tmp-[0-9a-f]+/owner\.json$"),
    ("publish: rename tmp -> LOCK", False, "renameSync", r">LOCK$"),
    ("release: LOCK -> release-", False, "renameSync", r"^LOCK>LOCK\.release-"),
    ("release: rm release-", False, "rmSync", r"^LOCK\.release-"),
    ("claim: mkdir tmp", True, "mkdirSync", r"^LOCK\.claim-[0-9a-f]+\.tmp-"),
    ("claim: rename tmp -> claim", True, "renameSync", r"^LOCK\.claim-[0-9a-f]+\.tmp-[0-9a-f]+>LOCK\.claim-[0-9a-f]+$"),
    ("takeover: LOCK -> stale-", True, "renameSync", r"^LOCK>LOCK\.stale-"),
    ("takeover: rm stale-", True, "rmSync", r"^LOCK\.stale-"),
    ("claim release: claim -> release-", True, "renameSync", r"^LOCK\.claim-[0-9a-f]{32}>LOCK\.claim-[0-9a-f]{32}\.release-"),
    ("claim release: rm", True, "rmSync", r"^LOCK\.claim-[0-9a-f]{32}\.release-"),
]
STEPS = [(f"{label} ({when})", stale, op, rx, when) for label, stale, op, rx in PROTOCOL for when in ("before", "after")]


def test_kill_9_at_every_protocol_step_the_next_default_acquire_owns_within_500_ms(tmp_path: Path):
    runs = []
    for i, (label, stale, op, rx, when) in enumerate(STEPS):
        r = tmp_path / f"s{i}" / "v2"
        r.mkdir(parents=True)
        if stale:
            seed_dir(lockp(r), "X", dead_pid())
        runs.append((label, r, subprocess.Popen([sys.executable, "-c", KILLAT_SCRIPT, str(r), op, rx, when], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)))
    problems: list[str] = []
    for label, r, p in runs:
        p.wait(timeout=60)
        if p.returncode != -9:
            problems.append(f"{label}: child was not killed ({p.returncode}); step never matched")
    for label, r, _ in runs:
        t0 = time.time()
        try:
            h = acquire_store_lock(str(r))
        except Exception as e:  # noqa: BLE001
            problems.append(f"{label}: next acquire failed: {e}")
            continue
        ms = (time.time() - t0) * 1000
        if ms >= 500:
            problems.append(f"{label}: next acquire took {ms} ms")
        if rec(r)["ownerId"] != h.owner_id:
            problems.append(f"{label}: not the owner")
        if h.release().status != "released":
            problems.append(f"{label}: release not released")
        left = os.listdir(r)
        if any(n == "LOCK" or re.fullmatch(r"LOCK\.claim-[0-9a-f]{32}", n) for n in left):
            problems.append(f"{label}: lock/claim left: {left}")
        if any(not re.match(r"LOCK\.(tmp|stale|release|claim)-", n) for n in left):
            problems.append(f"{label}: unexpected entries {left}")
        acquire_store_lock(str(r), Q(timeout_ms=300)).release()  # nothing is stuck for the one after
    assert problems == []


def test_kill_9_of_a_reclaimer_holding_its_claim_lock_stays_reclaimable(root: Path):
    seed_dir(lockp(root), "X", dead_pid())
    subprocess.run([sys.executable, "-c", KILLAT_SCRIPT, str(root), "renameSync", r"^LOCK>LOCK\.stale-", "before"], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    assert any(n.startswith("LOCK.claim-") for n in os.listdir(root)), "dead claimant's claim is left behind"
    t0 = time.time()
    acquire_store_lock(str(root)).release()
    assert time.time() - t0 < 0.5
    seed_dir(lockp(root), "X3", dead_pid())
    t1 = time.time()
    acquire_store_lock(str(root)).release()
    assert time.time() - t1 < 0.5
    assert os.listdir(root) == []


# --- review follow-ups (M1-M3) -----------------------------------------------------------------------------------------


def test_m1_a_sweep_that_deletes_the_fresh_lock_stale_of_a_concurrent_taker_never_surfaces_a_store_lock_error(root, fault_injection):
    seed_dir(lockp(root), "X-dead-holder")
    ev, out = Events(), []
    a = Worker(ev, str(root), "A", [Rule("^LOCK$", "^LOCK\\.stale-", signal=2, wait=3, after=True)], out, timeout_ms=400)  # pauses AFTER the rename
    try:
        ev.wait(2, "A renamed LOCK away")
        b = acquire_store_lock(str(root), Q(timeout_ms=1000))  # its sweep sees A's moved-away dead lock
        ev.raise_(3)
        a.join()
        msg = next(m for m in out if m["name"] == "A")
        assert "acquired" in msg or msg.get("error") == "StoreLockContended", msg
        assert msg.get("error") != "StoreLockError"
        assert rec(root)["ownerId"] == b.owner_id, "B holds LOCK"
        assert b.release().status == "released"
    finally:
        release_all(ev, a)


_CHILD_ACQUIRE = """
import json, sys, time
from odd_claude.review.lock import StoreLockOptions, acquire_store_lock
t0 = time.perf_counter()
try:
    l = acquire_store_lock(sys.argv[1], StoreLockOptions(timeout_ms=int(sys.argv[2])))
    ms = (time.perf_counter() - t0) * 1000
    l.release()
    print(json.dumps({"outcome": "acquired", "ms": ms}))
except Exception as e:
    print(json.dumps({"outcome": type(e).__name__, "ms": (time.perf_counter() - t0) * 1000}))
"""


def _child_acquire(root: Path, timeout_ms: int) -> tuple[int, dict]:
    r = subprocess.run([sys.executable, "-c", _CHILD_ACQUIRE, str(root), str(timeout_ms)], env=ENV, capture_output=True, text=True, timeout=10)
    return r.returncode, json.loads(r.stdout.strip())


def test_m2_a_fifo_or_a_symlink_to_dev_zero_as_owner_json_is_unreadable_never_read_to_the_end(tmp_path: Path):
    fifo = tmp_path / "fifo"
    lockp(fifo).mkdir(parents=True)
    os.mkfifo(lockp(fifo) / "owner.json")
    code, r = _child_acquire(fifo, 300)
    assert code == 0 and r["outcome"] == "StoreLockContended" and r["ms"] < 1000, r
    zero = tmp_path / "zero"
    lockp(zero).mkdir(parents=True)
    os.symlink("/dev/zero", lockp(zero) / "owner.json")
    code, r = _child_acquire(zero, 300)
    assert code == 0 and r["outcome"] == "StoreLockContended" and r["ms"] < 1000, r


def test_m3_a_fresh_unreadable_claim_blocking_the_reclaim_does_not_blame_the_dead_holders_pid(root: Path):
    dead = dead_pid()
    seed_dir(lockp(root), "X-dead", dead)
    (root / f"LOCK.claim-{'a' * 32}").mkdir()  # fresh, no owner record
    with pytest.raises(StoreLockContended) as ei:
        acquire_store_lock(str(root), Q(timeout_ms=200, poll_ms=20))
    e = ei.value
    assert e.blocker.kind == "reclaim" and e.blocker.owner is None and e.owner is None
    assert f"pid {dead}" not in str(e)
    assert str(e).startswith("a stale review store lock is being reclaimed (waited ")
    assert rec(root)["ownerId"] == "X-dead", "LOCK untouched"
