"""Port of v9 review/store.spec.ts (36 tests; loops and parametrization expand to more cases here), with the child-process kits
(store-child.testkit.ts, store-crash.testkit.ts) embedded as `KIT_SRC` / `CHILD_SRC` and run through `python -c`."""
import errno
import json
import os
import signal
import stat
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from odd_claude.review import store as st
from odd_claude.review.canonical import canonical_json
from odd_claude.review.lock import StoreLockContended, StoreLockOptions, acquire_store_lock
from odd_claude.review.state import admit_lens_result, start, state_revision
from odd_claude.review.store import (
    MAX_LINEAGES,
    MAX_STATE_BYTES,
    StoreAlreadyExistsError,
    StoreConcurrentUpdateError,
    StoreCorruptError,
    StoreInvalidLineageError,
    StoreInvalidRecordError,
    StoreIoError,
    StoreNotFoundError,
    StoreOptions,
    StoreTransitionRefusedError,
    SweepOptions,
    create_state,
    list_lineages,
    read_receipt,
    read_state,
    store_root_for,
    update_state,
    write_atomic,
    write_receipt,
)

T0 = "2026-11-19T10:00:00.000Z"
T1 = "2026-11-19T10:05:00.000Z"
HOUR = 3_600_000


def hx(c, n):
    return (c * n)[:n]


LINEAGE = f"review-{hx('a', 16)}"
ZERO_ID = f"sha256:{hx('0', 64)}"

KIT_SRC = '''
from odd_claude.review.state import start, state_revision


def mk_record(lineage, n=0):
    out = start({"lineageId": lineage, "targetIdentity": "sha256:" + format(n, "x").rjust(64, "0"), "projection": "workspace",
                 "baseTree": "b" * 40, "candidateTree": "c" * 40, "riskLevel": "medium", "selectedLenses": ["reliability"],
                 "originalChangedLines": 8, "now": "2026-11-19T10:00:00.000Z"})
    assert out["ok"]
    return out["record"]


def counter_of(record):
    return int(record["target_identity"][len("sha256:"):], 16)


def bump(record):
    nxt = {**record, "target_identity": "sha256:" + format(counter_of(record) + 1, "x").rjust(64, "0")}
    nxt["revision"] = state_revision(nxt)
    return {"ok": True, "record": nxt}
'''
_ns: dict = {}
exec(KIT_SRC, _ns)  # noqa: S102 - the same source the children run
mk_record, counter_of, bump = _ns["mk_record"], _ns["counter_of"], _ns["bump"]

CHILD_SRC = KIT_SRC + r'''
import json, os, signal, sys, time
from odd_claude.review import store
from odd_claude.review.lock import StoreLockOptions
from odd_claude.review.store import StoreConcurrentUpdateError, StoreOptions, create_state, read_state, update_state, write_receipt

mode, cd, lin, a, b, c = (sys.argv[1:] + [""] * 6)[:6]
LOCK = StoreOptions(lock=StoreLockOptions(timeout_ms=60_000, poll_ms=5))
if mode == "loop":
    successes, log, stale_every = int(a), b, int(c)
    stale = read_state(cd, lin)["revision"]
    applied = attempt = 0
    while applied < successes:
        attempt += 1
        current = read_state(cd, lin)
        expected = stale if stale_every > 0 and attempt % stale_every == 0 else current["revision"]
        try:
            out = update_state(cd, lin, expected, bump, LOCK)
            open(log, "a").write(f"ok {expected} {out['record']['revision']}\n")
            applied += 1
        except StoreConcurrentUpdateError as e:
            open(log, "a").write(f"conflict {expected} {e.current_revision}\n")
        except Exception as e:
            open(log, "a").write(f"fatal {type(e).__name__}: {e}\n")
            sys.exit(3)
elif mode == "crash":
    current = read_state(cd, lin)
    real = os.rename

    def hook(src, dst, *x, **k):
        if "/.atomic-" in str(src):
            open(a, "w").write("ready")
            time.sleep(1e6)  # blocks until SIGKILL
        return real(src, dst, *x, **k)

    os.rename = hook
    update_state(cd, lin, current["revision"], bump, LOCK)
elif mode in ("create", "receipt"):
    try:
        if mode == "create":
            create_state(cd, mk_record(lin, int(a)), LOCK)
        else:
            write_receipt(cd, lin, {"writer": a, "pad": "x" * 1000}, LOCK)
        result = {"ok": True}
    except Exception as e:
        result = {"ok": False, "name": type(e).__name__}
    print(json.dumps(result))
elif mode == "fscrash":  # <op> is lin; a = killAt, b = phase
    op, kill_at, phase = lin, int(a), b
    lin = "review-" + "a" * 16
    labels, tracked, n = [], set(), [0]

    def interesting(p):
        return isinstance(p, str) and p.startswith(cd) and "/LOCK" not in p

    def ev(label, fn):
        n[0] += 1
        labels.append(label)
        if n[0] == kill_at and phase == "before":
            os.kill(os.getpid(), signal.SIGKILL)
        r = fn()
        if n[0] == kill_at and phase == "after":
            os.kill(os.getpid(), signal.SIGKILL)
        return r

    real = {k: getattr(os, k) for k in ("open", "write", "fsync", "fchmod", "close", "rename", "mkdir", "unlink")}

    def p_open(p, *x, **k):
        if not interesting(p):
            return real["open"](p, *x, **k)
        fd = ev("open " + p[len(cd):], lambda: real["open"](p, *x, **k))
        tracked.add(fd)
        return fd

    def tracked_fn(name):
        def f(fd, *x, **k):
            return ev(name, lambda: real[name](fd, *x, **k)) if fd in tracked else real[name](fd, *x, **k)
        return f

    def p_close(fd):
        if fd not in tracked:
            return real["close"](fd)
        tracked.discard(fd)
        return ev("close", lambda: real["close"](fd))

    def p_rename(s, d, *x, **k):
        return ev("rename " + s[len(cd):], lambda: real["rename"](s, d, *x, **k)) if interesting(s) else real["rename"](s, d, *x, **k)

    def p_mkdir(p, *x, **k):
        return ev("mkdir " + p[len(cd):], lambda: real["mkdir"](p, *x, **k)) if interesting(p) else real["mkdir"](p, *x, **k)

    def p_unlink(p, *x, **k):
        return ev("rm " + p[len(cd):], lambda: real["unlink"](p, *x, **k)) if interesting(p) else real["unlink"](p, *x, **k)

    os.open, os.close, os.rename, os.mkdir, os.unlink = p_open, p_close, p_rename, p_mkdir, p_unlink
    for k in ("write", "fsync", "fchmod"):
        setattr(os, k, tracked_fn(k))
    L = StoreOptions(lock=StoreLockOptions(timeout_ms=20_000, poll_ms=5))
    if op == "create":
        create_state(cd, mk_record(lin, 0), L)
    elif op == "update":
        update_state(cd, lin, read_state(cd, lin)["revision"], bump, L)
    elif op == "receipt":
        write_receipt(cd, lin, {"r": "x" * 5000}, L)
    print(json.dumps({"n": n[0], "labels": labels}))
else:
    raise SystemExit("unknown mode " + mode)
'''


def run_child(*args, timeout=120):
    return subprocess.run([sys.executable, "-c", CHILD_SRC, *map(str, args)], capture_output=True, text=True, timeout=timeout)


@pytest.fixture
def common(tmp_path):
    d = tmp_path / "common.git"
    d.mkdir()
    return str(d)


def mode_of(p):
    return os.lstat(p).st_mode & 0o777


def state_file(cd, lineage=LINEAGE):
    return os.path.join(store_root_for(cd), lineage, "review-state.json")


def no_temps(cd, lineage=LINEAGE):
    return [n for n in os.listdir(os.path.join(store_root_for(cd), lineage)) if n.startswith(".atomic-")]


def fast(timeout_ms=300):
    return StoreLockOptions(timeout_ms=timeout_ms, poll_ms=5)


# ---- core ----


def test_layout_modes_and_create_read_update_round_trip(common):
    rec = mk_record(LINEAGE)
    created = create_state(common, rec)
    assert created == rec
    root = os.path.join(common, "odd-plugin", "review-transactions", "v2")
    assert store_root_for(common) == root
    assert mode_of(root) == 0o700
    assert mode_of(os.path.join(root, LINEAGE)) == 0o700
    assert mode_of(state_file(common)) == 0o600
    assert Path(state_file(common)).read_bytes() == (canonical_json(rec) + "\n").encode()
    assert read_state(common, LINEAGE) == rec
    nxt = update_state(common, LINEAGE, rec["revision"], lambda r: admit_lens_result(r, {"lens": "reliability", "findings": [], "resultHash": f"sha256:{hx('1', 64)}", "now": T1}))
    assert nxt["ok"] is True
    assert nxt["record"]["revision"] != rec["revision"]
    assert read_state(common, LINEAGE) == nxt["record"]
    assert mode_of(state_file(common)) == 0o600
    assert no_temps(common) == []


def test_create_state_refuses_an_existing_lineage_and_leaves_the_file_untouched(common):
    create_state(common, mk_record(LINEAGE))
    before = Path(state_file(common)).read_bytes()
    with pytest.raises(StoreAlreadyExistsError) as e:
        create_state(common, mk_record(LINEAGE, 7))
    assert e.value.code == "STORE_ALREADY_EXISTS"
    assert str(e.value) == f"review store entry already exists: {state_file(common)}"
    assert Path(state_file(common)).read_bytes() == before


def test_create_state_refuses_an_invalid_record_and_writes_nothing(common):
    rec = mk_record(LINEAGE)
    with pytest.raises(StoreInvalidRecordError) as e:
        create_state(common, {**rec, "revision": f"sha256:{hx('9', 64)}"})
    assert e.value.errors == ["revision does not match the record content"]
    assert str(e.value) == "invalid review record: revision does not match the record content"
    with pytest.raises(StoreInvalidRecordError):
        create_state(common, {**rec, "extra": 1})
    assert list_lineages(common) == {"lineages": [], "truncated": False}
    assert not os.path.exists(os.path.join(store_root_for(common), LINEAGE))


def test_cas_mismatch_carries_the_current_revision_and_the_file_is_unchanged(common):
    rec = mk_record(LINEAGE)
    create_state(common, rec)
    one = update_state(common, LINEAGE, rec["revision"], bump)
    before = Path(state_file(common)).read_bytes()
    called = []
    with pytest.raises(StoreConcurrentUpdateError) as e:
        update_state(common, LINEAGE, rec["revision"], lambda r: (called.append(1), bump(r))[1])
    assert e.value.code == "STORE_CONCURRENT_UPDATE"
    assert e.value.expected_revision == rec["revision"]
    assert e.value.current_revision == one["record"]["revision"]
    assert str(e.value) == f"concurrent update: expected revision {rec['revision']}, current {one['record']['revision']}"
    assert called == [], "transition must not run on a CAS mismatch"
    assert Path(state_file(common)).read_bytes() == before
    assert no_temps(common) == []


def test_a_refused_transition_and_an_invalid_transition_result_leave_the_file_unchanged(common):
    from odd_claude.review.state import burn

    rec = mk_record(LINEAGE)
    create_state(common, rec)
    before = Path(state_file(common)).read_bytes()
    with pytest.raises(StoreTransitionRefusedError) as e:
        update_state(common, LINEAGE, rec["revision"], lambda r: burn(r, {"now": T1, "token": "ab" * 32}))
    assert e.value.refusal == {"code": "illegal_state", "message": "cannot burn from reviewing"}
    assert str(e.value) == "transition refused (illegal_state): cannot burn from reviewing"
    with pytest.raises(StoreInvalidRecordError):
        update_state(common, LINEAGE, rec["revision"], lambda r: {"ok": True, "record": {**r, "state": "approved"}})

    def moved_lineage(r):
        moved = {**r, "lineage_id": f"review-{hx('b', 16)}"}
        moved["revision"] = state_revision(moved)
        return {"ok": True, "record": moved}

    with pytest.raises(StoreInvalidRecordError) as e2:
        update_state(common, LINEAGE, rec["revision"], moved_lineage)
    assert e2.value.errors == [f"transition changed lineage_id to review-{hx('b', 16)}"]
    assert Path(state_file(common)).read_bytes() == before
    assert no_temps(common) == []


def test_read_and_update_on_a_missing_lineage_or_store_are_not_found_and_create_nothing(common):
    with pytest.raises(StoreNotFoundError) as e:
        read_state(common, LINEAGE)
    assert e.value.code == "STORE_NOT_FOUND"
    assert str(e.value) == f"review store entry not found: {store_root_for(common)}"
    with pytest.raises(StoreNotFoundError):
        update_state(common, LINEAGE, f"sha256:{hx('1', 64)}", bump)
    assert not os.path.exists(os.path.join(common, "odd-plugin"))
    assert list_lineages(common) == {"lineages": [], "truncated": False}


def _corrupt_cases(good, parsed, other, rec):
    def w(data):
        return lambda f: Path(f).write_bytes(data if isinstance(data, bytes) else data.encode())

    def fifo(f):
        os.mkfifo(f)

    return [
        ("empty", w(""), "invalid-json"),
        ("truncated", w(good[: len(good) // 2]), "invalid-json"),
        ("not json", w("garbage"), "invalid-json"),
        ("array", w("[]"), "invalid-record"),
        ("bad revision", w(json.dumps({**parsed, "revision": f"sha256:{hx('9', 64)}"})), "revision-mismatch"),
        ("content edited, revision kept", w(json.dumps({**parsed, "updated_at": T1})), "revision-mismatch"),
        ("unknown field", w(json.dumps({**parsed, "sneaky": True})), "invalid-record"),
        ("missing field", w(json.dumps({k: v for k, v in parsed.items() if k != "findings"})), "invalid-record"),
        ("lineage mismatch", w(canonical_json(mk_record(f"review-{hx('b', 16)}"))), "lineage-mismatch"),
        ("symlink", lambda f: os.symlink(other, f), "not-regular"),
        ("directory", lambda f: os.mkdir(f), "not-regular"),
        ("fifo", fifo, "not-regular"),
        ("oversized", w(b" " * (MAX_STATE_BYTES + 1)), "oversized"),
        ("bom", w(b"\xef\xbb\xbf" + good.encode()), "invalid-json"),
        ("duplicate-key array record", w("[" + good + "]"), "invalid-record"),
    ]


def test_corrupt_or_unsafe_state_files_raise_typed_errors_are_never_repaired_and_update_refuses_them(common):
    rec = mk_record(LINEAGE)
    create_state(common, rec)
    file = state_file(common)
    good = Path(file).read_text()
    parsed = json.loads(good)
    other = os.path.join(common, "elsewhere.json")
    Path(other).write_text(good)
    for name, corrupt, kind in _corrupt_cases(good, parsed, other, rec):
        if os.path.isdir(file) and not os.path.islink(file):
            os.rmdir(file)
        elif os.path.lexists(file):
            os.unlink(file)
        corrupt(file)
        snapshot = Path(file).read_bytes() if stat.S_ISREG(os.lstat(file).st_mode) else None
        with pytest.raises(StoreCorruptError) as e:
            read_state(common, LINEAGE)
        assert e.value.kind == kind, f"{name}: {e.value}"
        assert e.value.code == "STORE_CORRUPT"
        assert e.value.path.endswith("review-state.json")
        with pytest.raises(StoreCorruptError):
            update_state(common, LINEAGE, rec["revision"], bump)
        with pytest.raises(StoreAlreadyExistsError):
            create_state(common, rec)
        if snapshot is not None:
            assert Path(file).read_bytes() == snapshot, f"{name}: file must not be repaired"
        assert no_temps(common) == [], name
    assert Path(other).read_text() == good, "symlink target untouched"


def test_a_symlinked_lineage_directory_or_store_root_is_refused(tmp_path, common):
    rec = mk_record(LINEAGE)
    create_state(common, rec)
    root = store_root_for(common)
    link = f"review-{hx('c', 16)}"
    os.symlink(os.path.join(root, LINEAGE), os.path.join(root, link))
    with pytest.raises(StoreCorruptError):
        read_state(common, link)
    with pytest.raises(StoreAlreadyExistsError):
        create_state(common, mk_record(link))
    assert list_lineages(common)["lineages"] == [LINEAGE], "symlinked lineage ignored by the listing"
    c2 = str(tmp_path / "second.git")
    os.makedirs(os.path.join(c2, "odd-plugin", "review-transactions"))
    target = os.path.join(c2, "real-root")
    os.mkdir(target)
    os.symlink(target, os.path.join(c2, "odd-plugin", "review-transactions", "v2"))
    with pytest.raises(StoreCorruptError):
        create_state(c2, rec)
    assert os.listdir(target) == []


@pytest.mark.parametrize("bad", [
    "../x", "..", ".", "", "review-../../etc", "review-AAAAAAAAAAAAAAAA", "review-aaaaaaaaaaaaaaa", "review-aaaaaaaaaaaaaaaaa", f"{LINEAGE}/..", f"{LINEAGE}\0",
    "/abs/path", "review-aaaaaaaaaaaaaaaa/../review-aaaaaaaaaaaaaaaa", f"{LINEAGE}\n", " " + LINEAGE, "review-ａａａａａａａａａａａａａａａａ",
])
def test_lineage_ids_are_validated_everywhere(common, bad):
    rec = mk_record(LINEAGE)
    create_state(common, rec)
    for call in (
        lambda: read_state(common, bad),
        lambda: update_state(common, bad, rec["revision"], bump),
        lambda: create_state(common, {**rec, "lineage_id": bad}),
        lambda: write_receipt(common, bad, {"a": 1}),
        lambda: read_receipt(common, bad),
    ):
        with pytest.raises(StoreInvalidLineageError) as e:
            call()
        assert e.value.code == "STORE_INVALID_LINEAGE"
    with pytest.raises(StoreInvalidLineageError) as e:
        read_state(common, bad)
    assert str(e.value) == f"invalid review lineage id (want review-<16 hex>): {json.dumps(bad, ensure_ascii=False)}"
    assert sorted(os.listdir(common)) == ["odd-plugin"]
    assert [n for n in os.listdir(store_root_for(common)) if n != "LOCK"] == [LINEAGE]


def test_a_non_string_lineage_is_invalid_and_a_record_without_lineage_says_undefined(common):
    with pytest.raises(StoreInvalidLineageError) as e:
        read_state(common, 5)
    assert str(e.value).endswith(": 5")
    with pytest.raises(StoreInvalidLineageError) as e:
        create_state(common, {"a": 1})
    assert str(e.value).endswith(": undefined")
    with pytest.raises(StoreInvalidLineageError):
        create_state(common, None)


def test_write_receipt_is_atomic_create_only_mode_0600_and_read_receipt_round_trips(common):
    create_state(common, mk_record(LINEAGE))
    receipt = {"schema": "odd-claude.review-receipt/v1", "lineage_id": LINEAGE, "z": 1, "a": [1, 2]}
    write_receipt(common, LINEAGE, receipt)
    file = os.path.join(store_root_for(common), LINEAGE, "review-receipt.json")
    assert mode_of(file) == 0o600
    assert Path(file).read_bytes() == (canonical_json(receipt) + "\n").encode()
    assert read_receipt(common, LINEAGE) == receipt
    before = Path(file).read_bytes()
    with pytest.raises(StoreAlreadyExistsError):
        write_receipt(common, LINEAGE, {"other": True})
    assert Path(file).read_bytes() == before
    assert no_temps(common) == []
    with pytest.raises(StoreNotFoundError):
        write_receipt(common, f"review-{hx('d', 16)}", {"a": 1})
    for bad in ([1], "x", None, 3):
        with pytest.raises(StoreInvalidRecordError) as e:
            write_receipt(common, LINEAGE, bad)
        assert e.value.errors == ["receipt must be a JSON object"]
    with pytest.raises(StoreInvalidRecordError) as e:
        write_receipt(common, LINEAGE, {"pad": "x" * MAX_STATE_BYTES})
    assert e.value.errors == [f"receipt exceeds {MAX_STATE_BYTES} bytes"]


def test_read_receipt_missing_and_corrupt(common):
    create_state(common, mk_record(LINEAGE))
    with pytest.raises(StoreNotFoundError):
        read_receipt(common, LINEAGE)
    file = os.path.join(store_root_for(common), LINEAGE, "review-receipt.json")
    Path(file).write_text("[1]")
    with pytest.raises(StoreCorruptError) as e:
        read_receipt(common, LINEAGE)
    assert (e.value.kind, str(e.value).split(": ", 2)[2]) == ("invalid-record", "receipt must be a JSON object")
    Path(file).write_text("{")
    with pytest.raises(StoreCorruptError) as e:
        read_receipt(common, LINEAGE)
    assert e.value.kind == "invalid-json"


def test_list_lineages_is_bounded_and_ignores_junk(common):
    assert list_lineages(common) == {"lineages": [], "truncated": False}
    a, b = f"review-{hx('a', 16)}", f"review-{hx('b', 16)}"
    create_state(common, mk_record(b))
    create_state(common, mk_record(a))
    root = store_root_for(common)
    os.mkdir(os.path.join(root, "review-short"))
    os.mkdir(os.path.join(root, "junk"))
    Path(root, f"review-{hx('c', 16)}").write_text("a file, not a lineage dir")
    Path(root, ".DS_Store").write_text("x")
    assert list_lineages(common) == {"lineages": [a, b], "truncated": False}
    assert list_lineages(common, limit=2) == {"lineages": [a, b], "truncated": False}, "junk never counts against the limit"
    assert list_lineages(common, limit=1) == {"lineages": [a], "truncated": True}
    assert list_lineages(common, limit=0) == {"lineages": [], "truncated": True}
    assert list_lineages(common, limit=-3) == {"lineages": [], "truncated": True}


def test_write_atomic_a_failure_before_rename_cleans_the_temp_and_keeps_the_previous_file(common, monkeypatch):
    d = os.path.join(common, "d")
    os.mkdir(d)
    file = os.path.join(d, "f.json")
    write_atomic(file, b"old")
    assert mode_of(file) == 0o600

    def boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(os, "rename", boom)
    with pytest.raises(RuntimeError, match="boom"):
        write_atomic(file, b"new")
    monkeypatch.undo()
    assert Path(file).read_text() == "old"
    assert os.listdir(d) == ["f.json"]


def test_write_atomic_accepts_str_and_bytes_and_uses_the_atomic_temp_name(common, monkeypatch):
    seen = []
    real = os.rename
    monkeypatch.setattr(os, "rename", lambda a, b: (seen.append(os.path.basename(a)), real(a, b))[1])
    write_atomic(os.path.join(common, "s.json"), "héllo")
    write_atomic(os.path.join(common, "b.json"), "héllo".encode())
    assert Path(common, "s.json").read_bytes() == Path(common, "b.json").read_bytes() == "héllo".encode()
    import re

    assert all(re.fullmatch(r"\.atomic-\d+-[0-9a-f]{16}", n) for n in seen) and len(seen) == 2


def test_concurrent_updaters_in_several_processes_no_lost_update(common):
    rec = mk_record(LINEAGE)
    create_state(common, rec)
    N, M = 4, 15
    logs = [os.path.join(common, f"log-{i}.txt") for i in range(N)]
    with ThreadPoolExecutor(N) as ex:
        results = list(ex.map(lambda log: run_child("loop", common, LINEAGE, M, log, 3), logs))
    for r in results:
        assert (r.returncode, r.stderr) == (0, "")
    lines = [ln for lg in logs for ln in Path(lg).read_text().split("\n") if ln]
    assert not [ln for ln in lines if ln.startswith("fatal")], lines
    oks = [ln.split(" ") for ln in lines if ln.startswith("ok ")]
    conflicts = [ln.split(" ") for ln in lines if ln.startswith("conflict ")]
    assert len(oks) == N * M
    assert conflicts, "stale attempts must be rejected"
    for _, expected, current in conflicts:
        assert expected != current
    from_to = {}
    for _, frm, to in oks:
        assert frm not in from_to, "two writes applied from the same predecessor revision (lost update)"
        from_to[frm] = to
    cur = rec["revision"]
    for i in range(N * M):
        assert cur in from_to, f"broken chain at step {i}"
        cur = from_to[cur]
    assert cur not in from_to
    final = read_state(common, LINEAGE)
    assert final["revision"] == cur
    assert counter_of(final) == N * M
    assert final["revision"] == state_revision(final)
    assert no_temps(common) == []
    assert mode_of(state_file(common)) == 0o600


def test_kill_9_during_write_atomic_previous_state_intact_and_the_next_update_sweeps_the_temp(common):
    rec = mk_record(LINEAGE)
    create_state(common, rec)
    before = Path(state_file(common)).read_bytes()
    ready = os.path.join(common, "ready")
    child = subprocess.Popen([sys.executable, "-c", CHILD_SRC, "crash", common, LINEAGE, ready], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 20
    while not os.path.exists(ready) and time.time() < deadline:
        time.sleep(0.01)
    assert os.path.exists(ready), "child never reached the pre-rename point"
    child.send_signal(signal.SIGKILL)
    assert child.wait() == -signal.SIGKILL
    assert Path(state_file(common)).read_bytes() == before
    assert read_state(common, LINEAGE) == rec
    assert len(no_temps(common)) >= 1, "the orphaned temp proves the kill landed mid-write"
    assert list_lineages(common)["lineages"] == [LINEAGE]
    nxt = update_state(common, LINEAGE, rec["revision"], bump, StoreOptions(lock=StoreLockOptions(timeout_ms=10_000, poll_ms=10)))
    assert counter_of(nxt["record"]) == 1
    assert no_temps(common) == []
    assert read_state(common, LINEAGE) == nxt["record"]


def test_a_read_only_0400_state_file_is_still_readable(common):
    rec = mk_record(LINEAGE)
    create_state(common, rec)
    os.chmod(state_file(common), 0o400)
    assert read_state(common, LINEAGE) == rec
    os.chmod(state_file(common), 0o600)
    os.truncate(state_file(common), len(Path(state_file(common)).read_bytes()))
    assert read_state(common, LINEAGE) == rec


def test_m1_a_hardlinked_state_file_is_refused_as_not_regular_and_never_rewritten(common):
    rec = mk_record(LINEAGE)
    create_state(common, rec)
    file = state_file(common)
    outside = os.path.join(common, "outside.json")
    os.link(file, outside)
    before = Path(outside).read_bytes()
    with pytest.raises(StoreCorruptError) as e:
        read_state(common, LINEAGE)
    assert e.value.kind == "not-regular"
    assert "hardlinked (nlink 2)" in str(e.value)
    with pytest.raises(StoreCorruptError):
        update_state(common, LINEAGE, rec["revision"], bump)
    assert Path(outside).read_bytes() == before
    assert Path(file).read_bytes() == before
    assert os.lstat(file).st_nlink == 2


def test_m2_list_lineages_reports_truncation_when_the_scan_cap_is_hit(common):
    create_state(common, mk_record(f"review-{hx('a', 16)}"))
    create_state(common, mk_record(f"review-{hx('b', 16)}"))
    root = store_root_for(common)
    for i in range(20):
        Path(root, f"junk-{i}").write_text("x")
    assert list_lineages(common) == {"lineages": [f"review-{hx('a', 16)}", f"review-{hx('b', 16)}"], "truncated": False}
    capped = list_lineages(common, max_scan=5)
    assert capped["truncated"] is True
    assert len(capped["lineages"]) <= 2
    assert list_lineages(common, max_scan=1000)["truncated"] is False


@pytest.mark.skipif(os.getuid() == 0, reason="root ignores permission bits")
def test_m3_filesystem_failures_surface_as_typed_store_io_error(common):
    with pytest.raises(StoreIoError) as e:
        create_state(os.path.join(common, "nope"), mk_record(LINEAGE))
    assert e.value.code == "STORE_IO"
    assert e.value.errno == "ENOENT"
    assert e.value.path == os.path.join(common, "nope", "odd-plugin")
    assert str(e.value).startswith(f"review store I/O failure (ENOENT): {e.value.path}: ")
    assert not os.path.exists(os.path.join(common, "nope"))
    create_state(common, mk_record(LINEAGE))
    root = store_root_for(common)
    os.chmod(root, 0)
    try:
        with pytest.raises(StoreIoError) as l:
            list_lineages(common)
        assert l.value.errno == "EACCES"
        with pytest.raises(StoreIoError) as r:
            read_state(common, LINEAGE)
        assert r.value.errno == "EACCES"
    finally:
        os.chmod(root, 0o700)


def test_typed_maps_only_bare_os_errors(common):
    assert isinstance(st._typed(OSError(errno.ENOSPC, "No space left on device", "/x")), StoreIoError)
    plain = ValueError("x")
    assert st._typed(plain) is plain
    lock_err = StoreLockContended(common, 1)
    assert st._typed(lock_err) is lock_err
    io = st._typed(OSError(errno.EACCES, "Permission denied", "/p"))
    assert (io.errno, io.path) == ("EACCES", "/p")


def test_m5_write_receipt_requires_a_valid_state_for_the_lineage(common):
    create_state(common, mk_record(LINEAGE))
    empty = f"review-{hx('e', 16)}"
    os.mkdir(os.path.join(store_root_for(common), empty), 0o700)
    with pytest.raises(StoreNotFoundError):
        write_receipt(common, empty, {"a": 1})
    assert not os.path.exists(os.path.join(store_root_for(common), empty, "review-receipt.json"))
    Path(state_file(common)).write_text("garbage")
    with pytest.raises(StoreCorruptError):
        write_receipt(common, LINEAGE, {"a": 1})
    assert not os.path.exists(os.path.join(store_root_for(common), LINEAGE, "review-receipt.json"))
    assert no_temps(common) == []


def tree_snapshot(root):
    out = []

    def walk(p):
        s = os.lstat(p)
        body = Path(p).read_bytes().decode("latin1") if stat.S_ISREG(s.st_mode) else ""
        out.append(f"{p[len(root):]}:{s.st_mode:o}:{body}")
        if stat.S_ISDIR(s.st_mode):
            for n in sorted(os.listdir(p)):
                walk(os.path.join(p, n))

    walk(root)
    return out


@pytest.mark.parametrize("kind", ["symlink", "file"])
@pytest.mark.parametrize("seg", ["odd-plugin", "odd-plugin/review-transactions", "odd-plugin/review-transactions/v2"])
def test_hostile_namespace_segments_make_all_apis_raise_store_corrupt_and_leave_the_real_tree_unchanged(common, seg, kind):
    rec = mk_record(LINEAGE)
    create_state(common, rec)
    p = os.path.join(common, seg)
    moved = os.path.join(common, "moved-real")
    os.rename(p, moved)
    if kind == "symlink":
        os.symlink(moved, p)
    else:
        Path(p).write_text("x")
    before = tree_snapshot(moved)
    for call in (
        lambda: read_state(common, LINEAGE),
        lambda: update_state(common, LINEAGE, rec["revision"], bump),
        lambda: create_state(common, rec),
        lambda: write_receipt(common, LINEAGE, {"a": 1}),
        lambda: read_receipt(common, LINEAGE),
        lambda: list_lineages(common),
    ):
        with pytest.raises(StoreCorruptError):
            call()
    assert tree_snapshot(moved) == before


def test_eight_concurrent_create_state_and_write_receipt_exactly_one_wins(tmp_path):
    K = 8
    cd = str(tmp_path / "c1.git")
    os.mkdir(cd)
    with ThreadPoolExecutor(K) as ex:
        rs = list(ex.map(lambda i: run_child("create", cd, LINEAGE, i + 1), range(K)))
    out = []
    for r in rs:
        assert r.returncode == 0, r.stderr
        out.append(json.loads(r.stdout))
    wins = [(r, i + 1) for i, r in enumerate(out) if r["ok"]]
    assert len(wins) == 1
    assert all(r["name"] == "StoreAlreadyExistsError" for r in out if not r["ok"])
    assert counter_of(read_state(cd, LINEAGE)) == wins[0][1]
    assert no_temps(cd) == []
    cd2 = str(tmp_path / "c2.git")
    os.mkdir(cd2)
    create_state(cd2, mk_record(LINEAGE))
    with ThreadPoolExecutor(K) as ex:
        rs = list(ex.map(lambda i: run_child("receipt", cd2, LINEAGE, i + 1), range(K)))
    out = [json.loads(r.stdout) for r in rs]
    wins = [(r, i + 1) for i, r in enumerate(out) if r["ok"]]
    assert len(wins) == 1
    assert all(r["name"] == "StoreAlreadyExistsError" for r in out if not r["ok"])
    assert read_receipt(cd2, LINEAGE)["writer"] == str(wins[0][1])
    assert no_temps(cd2) == []


def test_kill_9_at_every_fs_call_of_create_update_receipt(tmp_path):
    import itertools

    ids = itertools.count()  # next() is atomic under the GIL: the jobs run in threads

    def setup(op):
        d = tmp_path / f"crash-{next(ids)}.git"
        d.mkdir()
        if op != "create":
            create_state(str(d), mk_record(LINEAGE))
        return str(d)

    L = StoreOptions(lock=StoreLockOptions(timeout_ms=10_000, poll_ms=5))

    def temps(cd):
        try:
            return [n for n in os.listdir(os.path.join(store_root_for(cd), LINEAGE)) if n.startswith(".atomic-")]
        except OSError:
            return []

    def check(op, cd):
        def try_(f):
            try:
                return True, f()
            except Exception as e:  # noqa: BLE001
                return False, e

        if op == "create":
            rs = try_(lambda: read_state(cd, LINEAGE))
            if not rs[0] and not isinstance(rs[1], StoreNotFoundError):
                return f"read {type(rs[1]).__name__}"
            if not try_(lambda: list_lineages(cd))[0]:
                return "list failed"
            nx = try_(lambda: update_state(cd, LINEAGE, rs[1]["revision"], bump, L)) if rs[0] else try_(lambda: create_state(cd, mk_record(LINEAGE), L))
            if not nx[0]:
                return f"next {type(nx[1]).__name__}: {nx[1]}"
            if temps(cd):
                return "temps not swept"
            return None if counter_of(read_state(cd, LINEAGE)) == (1 if rs[0] else 0) else "counter"
        if op == "update":
            rs = try_(lambda: read_state(cd, LINEAGE))
            if not rs[0]:
                return f"read {type(rs[1]).__name__}"
            c0 = counter_of(rs[1])
            if c0 not in (0, 1):
                return f"counter {c0}"
            nx = try_(lambda: update_state(cd, LINEAGE, rs[1]["revision"], bump, L))
            if not nx[0]:
                return f"next {type(nx[1]).__name__}: {nx[1]}"
            if temps(cd):
                return "temps not swept"
            return None if counter_of(read_state(cd, LINEAGE)) == c0 + 1 else "counter after"
        rr = try_(lambda: read_receipt(cd, LINEAGE))
        if not rr[0] and not isinstance(rr[1], StoreNotFoundError):
            return f"readReceipt {type(rr[1]).__name__}"
        if rr[0] and len(str(rr[1]["r"])) != 5000:
            return "partial receipt"
        nx = try_(lambda: write_receipt(cd, LINEAGE, {"r": "x" * 5000}, L))
        if rr[0] and (nx[0] or not isinstance(nx[1], StoreAlreadyExistsError)):
            return "rewrite of an existing receipt was not refused"
        if not rr[0] and not nx[0]:
            return f"next {type(nx[1]).__name__}: {nx[1]}"
        up = try_(lambda: update_state(cd, LINEAGE, read_state(cd, LINEAGE)["revision"], bump, L))
        if not up[0]:
            return f"update after {type(up[1]).__name__}: {up[1]}"
        return "temps not swept after update" if temps(cd) else None

    failures, cases = [], 0
    for op in ("create", "update", "receipt"):
        probe = run_child("fscrash", setup(op), op, 0, "none")
        assert probe.returncode == 0, probe.stderr
        info = json.loads(probe.stdout)
        n, labels = info["n"], info["labels"]
        assert n >= 8, f"{op}: only {n} fs events counted"
        assert any(label.startswith("rename") for label in labels), f"{op}: no rename counted"
        if op == "create":
            assert labels.count("fsync") >= 6, f"create must fsync the 3 namespace dirs, the lineage dir, the file and its dir: {labels}"
        jobs = [(k, ph) for k in range(1, n + 1) for ph in ("before", "after")]

        def one(job, op=op, labels=labels):
            k, ph = job
            cd = setup(op)
            r = run_child("fscrash", cd, op, k, ph)
            tag = f"{op} k={k}({labels[k - 1]}) {ph}"
            if r.returncode != -signal.SIGKILL:
                return f"NOKILL {tag}: {r.returncode} {r.stderr[-300:]}"
            problem = check(op, cd)
            return f"{tag}: {problem}" if problem else None

        cases += len(jobs)
        with ThreadPoolExecutor(8) as ex:
            failures += [f for f in ex.map(one, jobs) if f]
    assert cases >= 60, f"only {cases} crash cases"
    assert failures == []


# ---- sweep of abandoned lineage directories (a crash in the middle of START) ----

L2 = f"review-{hx('2', 16)}"
TEMP_A = ".atomic-123-0123456789abcdef"
TEMP_B = ".atomic-456-fedcba9876543210"


def old_opts(**kw):
    return StoreOptions(sweep=SweepOptions(now=lambda: time.time() * 1000 + 2 * HOUR, **kw))


def lin(n):
    return f"review-{n:016x}"


def abandon(cd, id_, temps=()):
    d = os.path.join(store_root_for(cd), id_)
    os.makedirs(d, mode=0o700, exist_ok=True)
    for t in temps:
        Path(d, t).write_text("x")
    return d


def sha_of(c):
    return f"sha256:{hx(c, 64)}"


def test_sweep_create_state_removes_an_old_empty_dir_and_an_old_temp_only_dir_then_writes_the_new_lineage(common):
    create_state(common, mk_record(LINEAGE))
    empty = abandon(common, lin(1))
    temp_only = abandon(common, lin(2), [TEMP_A, TEMP_B])
    create_state(common, mk_record(L2, 1), old_opts())
    assert not os.path.exists(empty)
    assert not os.path.exists(temp_only)
    assert list_lineages(common)["lineages"] == sorted([L2, LINEAGE])
    assert read_state(common, L2)["lineage_id"] == L2


def test_sweep_a_young_directory_and_the_default_age_are_respected_and_read_only_calls_never_sweep(common):
    create_state(common, mk_record(LINEAGE))
    young = abandon(common, lin(1), [TEMP_A])
    old = abandon(common, lin(2))
    create_state(common, mk_record(L2, 1))  # real clock: nothing is an hour old
    assert os.path.exists(young) and os.path.exists(old)
    now = time.time() * 1000
    create_state(common, mk_record(lin(9), 9), StoreOptions(sweep=SweepOptions(now=lambda: now + HOUR - 60_000)))
    assert os.path.exists(young)
    read_state(common, LINEAGE)
    list_lineages(common)
    assert os.path.exists(old)
    create_state(common, mk_record(lin(10), 8), old_opts())
    assert not os.path.exists(young)
    assert not os.path.exists(old)


def test_sweep_injectable_min_age_ms(common):
    create_state(common, mk_record(LINEAGE))
    d = abandon(common, lin(1))
    create_state(common, mk_record(L2, 1), StoreOptions(sweep=SweepOptions(min_age_ms=10 * HOUR, now=lambda: time.time() * 1000 + 2 * HOUR)))
    assert os.path.exists(d)
    create_state(common, mk_record(lin(3), 3), StoreOptions(sweep=SweepOptions(min_age_ms=0, now=lambda: time.time() * 1000 + 1)))
    assert not os.path.exists(d)


def test_sweep_never_removes_a_live_lineage_a_lock_or_any_other_file_nor_a_young_dir_or_a_non_lineage_name(common):
    rec = mk_record(LINEAGE)
    create_state(common, rec)
    root = store_root_for(common)
    receipt_only = abandon(common, lin(1), [TEMP_A])
    Path(receipt_only, "review-receipt.json").write_text("{}")
    state_only = abandon(common, lin(2))
    Path(state_only, "review-state.json").write_text("{}")
    other = abandon(common, lin(3), [TEMP_A])
    Path(other, "notes.txt").write_text("x")
    locked = abandon(common, lin(4))
    os.mkdir(os.path.join(locked, "LOCK"))
    locked_file = abandon(common, lin(5))
    Path(locked_file, "LOCK.1").write_text("x")
    junk = os.path.join(root, "review-NOTHEX0000000000")
    os.mkdir(junk)
    short = os.path.join(root, "review-abc")
    os.mkdir(short)
    temp_dir = abandon(common, lin(6))
    os.mkdir(os.path.join(temp_dir, TEMP_A))
    keep_all = [receipt_only, state_only, other, locked, locked_file, junk, short, temp_dir]
    before = [sorted(os.listdir(d)) for d in keep_all]
    atomic_dir = os.path.join(root, TEMP_B)
    os.mkdir(atomic_dir)
    create_state(common, mk_record(L2, 1), old_opts())
    for d, b in zip(keep_all, before):
        assert os.path.exists(d), f"{d} survived"
        assert sorted(os.listdir(d)) == b
    assert os.path.exists(atomic_dir)
    assert Path(state_file(common)).read_bytes() == (canonical_json(rec) + "\n").encode()
    assert read_state(common, LINEAGE)["revision"] == rec["revision"]


def test_sweep_a_symlink_named_like_a_lineage_is_never_followed_or_removed(common):
    create_state(common, mk_record(LINEAGE))
    target = os.path.join(common, "outside")
    os.mkdir(target)
    Path(target, TEMP_A).write_text("precious")
    link = os.path.join(store_root_for(common), lin(1))
    os.symlink(target, link)
    empty = os.path.join(common, "outside-empty")
    os.mkdir(empty)
    link2 = os.path.join(store_root_for(common), lin(2))
    os.symlink(empty, link2)
    create_state(common, mk_record(L2, 1), old_opts())
    assert os.path.islink(link) and os.path.islink(link2)
    assert Path(target, TEMP_A).read_text() == "precious"
    assert os.path.exists(empty)


def test_sweep_a_temp_with_nlink_over_1_a_symlink_or_a_fifo_keeps_its_directory(common):
    create_state(common, mk_record(LINEAGE))
    outside = os.path.join(common, "outside.txt")
    Path(outside).write_text("precious")
    hard = abandon(common, lin(1))
    os.link(outside, os.path.join(hard, TEMP_A))
    sym = abandon(common, lin(2), [TEMP_B])
    os.symlink(outside, os.path.join(sym, TEMP_A))
    fifo = abandon(common, lin(3), [TEMP_B])
    os.mkfifo(os.path.join(fifo, TEMP_A))
    create_state(common, mk_record(L2, 1), old_opts())
    assert Path(outside).read_text() == "precious"
    assert os.listdir(hard) == [TEMP_A]
    assert sorted(os.listdir(sym)) == [TEMP_A, TEMP_B]
    assert sorted(os.listdir(fifo)) == [TEMP_A, TEMP_B]
    assert os.path.islink(os.path.join(sym, TEMP_A))


def test_sweep_at_most_the_cap_per_call_default_16_the_rest_on_later_calls(common):
    create_state(common, mk_record(LINEAGE))
    for i in range(1, 21):
        abandon(common, lin(i), [TEMP_A] if i % 2 else [])

    def left():
        return [n for n in os.listdir(store_root_for(common)) if n.startswith("review-") and n not in (LINEAGE, L2, lin(0xAAA))]

    create_state(common, mk_record(L2, 1), old_opts())
    assert len(left()) == 4, "one call removes at most 16 of 20"
    create_state(common, mk_record(lin(0xAAA), 2), old_opts(max=3))
    assert len(left()) == 1, "an explicit cap of 3"


def test_sweep_with_the_root_lock_held_by_another_holder_nothing_is_swept_or_created(common):
    create_state(common, mk_record(LINEAGE))
    d = abandon(common, lin(1), [TEMP_A])
    handle = acquire_store_lock(store_root_for(common))
    try:
        opts = old_opts()
        opts.lock = fast()
        with pytest.raises(StoreLockContended):
            create_state(common, mk_record(L2, 1), opts)
        assert os.listdir(d) == [TEMP_A]
        assert not os.path.exists(os.path.join(store_root_for(common), L2))
    finally:
        handle.release()
    create_state(common, mk_record(L2, 1), old_opts())
    assert not os.path.exists(d)


@pytest.mark.skipif(os.getuid() == 0, reason="root ignores permission bits")
def test_sweep_a_failure_while_sweeping_never_fails_create_state(common):
    create_state(common, mk_record(LINEAGE))
    bad = abandon(common, lin(1), [TEMP_A])
    good = abandon(common, lin(2))
    os.chmod(bad, 0o500)
    try:
        rec = create_state(common, mk_record(L2, 1), old_opts())
        assert rec["lineage_id"] == L2
    finally:
        os.chmod(bad, 0o700)
    assert not os.path.exists(good)
    assert read_state(common, L2)["lineage_id"] == L2


def test_sweep_create_state_of_the_lineage_whose_own_abandoned_dir_is_old_still_succeeds(common):
    create_state(common, mk_record(LINEAGE))
    abandon(common, L2, [TEMP_A])
    create_state(common, mk_record(L2, 1), old_opts())
    assert read_state(common, L2)["lineage_id"] == L2
    assert no_temps(common, L2) == []


def test_sweep_future_dated_dir_temp_and_near_miss_names_are_kept(common):
    create_state(common, mk_record(LINEAGE))
    future = time.time() + 10 * 3600
    past = time.time() - 5 * 3600
    f_dir = abandon(common, lin(1), [TEMP_A])
    os.utime(os.path.join(f_dir, TEMP_A), (past, past))
    os.utime(f_dir, (future, future))
    t_dir = abandon(common, lin(2), [TEMP_A])
    os.utime(os.path.join(t_dir, TEMP_A), (future, future))
    os.utime(t_dir, (past, past))
    near_dirs = [f"review-{hx('a', 15)}", f"review-{hx('a', 17)}", f"review-{hx('E', 16)}", f"review-{hx('a', 16)}.bak", f" review-{hx('a', 16)}"]
    for n in near_dirs:
        abandon(common, n)
    near_temps = [".atomic-123-0123456789abcde", ".atomic-123-0123456789abcdef0", ".atomic-x-0123456789abcdef", ".atomic--0123456789abcdef", "atomic-123-0123456789abcdef", ".atomic-123-0123456789ABCDEF"]
    for i, n in enumerate(near_temps):
        abandon(common, lin(0x100 + i), [n])
    abandon(common, lin(3), [TEMP_A])
    create_state(common, mk_record(L2, 1), old_opts())
    left = os.listdir(store_root_for(common))
    assert lin(3) not in left, "the control was swept"
    for n in [lin(1), lin(2), *near_dirs, *[lin(0x100 + i) for i in range(len(near_temps))]]:
        assert n in left, f"{n} kept"
    assert os.listdir(os.path.join(store_root_for(common), lin(1))) == [TEMP_A]
    assert os.listdir(os.path.join(store_root_for(common), lin(2))) == [TEMP_A]


def test_sweep_old_live_lineages_beyond_the_examine_cap_do_not_starve_abandoned_dirs(common):
    create_state(common, mk_record(LINEAGE))
    root = store_root_for(common)
    for i in range(1, 2001):
        d = os.path.join(root, lin(i))
        os.mkdir(d, 0o700)
        Path(d, "review-state.json").write_text("{}")
    abandoned = [lin(0x10000 + i) for i in range(500)]
    for n in abandoned:
        abandon(common, n, [TEMP_A])

    def remaining():
        return sum(os.path.exists(os.path.join(root, n)) for n in abandoned)

    calls = 0
    while remaining() > 0 and calls < 45:
        calls += 1
        create_state(common, mk_record(lin(0x20000 + calls), calls), old_opts())
    assert remaining() == 0, f"all swept in {calls} calls"
    for i in range(1, 2001, 199):
        assert os.path.exists(os.path.join(root, lin(i), "review-state.json")), "live lineages untouched"


def test_sweep_a_review_state_of_any_type_keeps_its_dir_and_never_touches_a_target(common):
    create_state(common, mk_record(LINEAGE))
    outside = os.path.join(common, "outside-dir")
    os.mkdir(outside)
    secret = os.path.join(outside, "secret.txt")
    Path(secret).write_text("precious")
    kinds = [lambda f: os.symlink(outside, f), lambda f: os.symlink(os.path.join(outside, "missing"), f), lambda f: os.mkdir(f), lambda f: os.mkfifo(f)]
    dirs = []
    for i, make in enumerate(kinds):
        d = abandon(common, lin(i + 1), [TEMP_A])
        make(os.path.join(d, "review-state.json"))
        dirs.append(d)
    control = abandon(common, lin(9), [TEMP_A])
    create_state(common, mk_record(L2, 1), old_opts())
    for d in dirs:
        assert sorted(os.listdir(d)) == [TEMP_A, "review-state.json"]
    assert Path(secret).read_text() == "precious"
    assert os.listdir(outside) == ["secret.txt"]
    assert not os.path.exists(control), "the plain abandoned control was swept"


def test_sweep_scans_at_most_max_lineages_entries_per_call(common):
    create_state(common, mk_record(LINEAGE))
    root = store_root_for(common)
    for i in range(1, MAX_LINEAGES + 1):
        d = os.path.join(root, lin(i))
        os.mkdir(d, 0o700)
        Path(d, "review-state.json").write_text("{}")
    abandoned = [lin(0x100000 + i) for i in range(512)]
    for n in abandoned:
        abandon(common, n, [TEMP_A])
    with os.scandir(root) as it:
        order = [e.name for e in it]
    tail = [n for n in abandoned if order.index(n) >= MAX_LINEAGES + 2]
    head = [n for n in abandoned if order.index(n) < MAX_LINEAGES - 2]
    assert tail, "setup: some abandoned dirs sit past the scan bound"
    create_state(common, mk_record(L2, 1), old_opts(max=1000))
    for n in tail:
        assert os.path.exists(os.path.join(root, n)), f"{n} past the bound is not reached"
    for n in head:
        assert not os.path.exists(os.path.join(root, n)), f"{n} within the bound is swept"


# ---- extras that pin the port's own seams ----


def test_constants_and_store_root():
    assert (MAX_STATE_BYTES, MAX_LINEAGES, st.ABANDONED_MIN_AGE_MS, st.ABANDONED_SWEEP_MAX) == (1 << 20, 10_000, 3_600_000, 16)
    assert store_root_for("/a//b/") == "/a/b/odd-plugin/review-transactions/v2"


def test_update_state_returns_the_outcome_with_extra_fields_and_the_validated_record(common):
    from odd_claude.review.state import approve

    create_state(common, mk_record(LINEAGE))
    rec = read_state(common, LINEAGE)
    a = update_state(common, LINEAGE, rec["revision"], lambda r: admit_lens_result(r, {"lens": "reliability", "findings": [], "resultHash": sha_of("1"), "now": T1}))
    out = update_state(common, LINEAGE, a["record"]["revision"], lambda r: approve(r, {"now": T1, "randomToken": lambda: "cd" * 32}))
    assert out["ackToken"] == "cd" * 32
    assert out["record"]["state"] == "approved"
    assert read_state(common, LINEAGE) == out["record"]


def test_s4_the_review_store_contract_fixture_loads_without_a_schema_error(common):
    from odd_claude.review.state import validate_state_record

    fx = Path(__file__).resolve().parents[2] / "test-fixtures" / "contracts" / "review-store"
    state_text = (fx / "review-state.json").read_text(encoding="utf-8")
    receipt_text = (fx / "review-receipt.json").read_text(encoding="utf-8")
    parsed = json.loads(state_text)
    assert validate_state_record(parsed) == {"ok": True, "record": parsed}
    assert canonical_json(parsed) + "\n" == state_text, "the fixture is canonical JSON, newline-terminated"
    assert canonical_json(json.loads(receipt_text)) + "\n" == receipt_text
    lineage = parsed["lineage_id"]
    d = os.path.join(store_root_for(common), lineage)
    os.makedirs(d, mode=0o700)
    for name, text in (("review-state.json", state_text), ("review-receipt.json", receipt_text)):
        fd = os.open(os.path.join(d, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
    rec = read_state(common, lineage)
    assert rec == parsed and rec["state"] == "approved" and rec["burned"] is True
    assert read_receipt(common, lineage) == json.loads(receipt_text)
    assert list_lineages(common) == {"lineages": [lineage], "truncated": False}
