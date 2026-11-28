"""Port of v9 review/ack.spec.ts (27 tests; the crash test and the parametrized loops expand to more cases here). The child kit
(ack-child.testkit.ts) is embedded as `CHILD_SRC` and run through `python -c`; it numbers every fs call under the common dir."""
import json
import os
import signal
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

import pytest

from odd_claude.review.ack import (
    RECEIPT_SCHEMA,
    AckRefusedError,
    AcknowledgeOptions,
    acknowledge_approved,
    budget_status,
    find_receipt_for_target,
    is_target_consumed,
    scan_target,
    validate_receipt,
)
from odd_claude.review.canonical import canonical_json, domain_hash
from odd_claude.review.lock import StoreLockOptions
from odd_claude.review.state import (
    admit_lens_result,
    admit_validator_result,
    approve,
    begin_validation,
    require_correction,
    start,
)
from odd_claude.review.store import StoreOptions, create_state, read_receipt, read_state, store_root_for, write_receipt

NOW = "2026-11-19T10:00:00.000Z"
BURN_AT = "2026-11-19T10:05:00.000Z"
LOCK = StoreOptions(lock=StoreLockOptions(timeout_ms=30_000, poll_ms=5))


def hex_(c, n):
    return (c * n)[:n]


def lineage_of(n):
    return f"review-{n:016x}"


def target_of(n):
    return f"sha256:{n:064x}"


@pytest.fixture
def d():
    with tempfile.TemporaryDirectory(prefix="odd-ack-") as t:
        yield os.path.realpath(t)


class Approved(dict):
    __getattr__ = dict.__getitem__


def seed_low(dir_, n):
    """Low risk: approved at start with the token (no lenses)."""
    out = start({"lineageId": lineage_of(n), "targetIdentity": target_of(n), "projection": "workspace", "baseTree": hex_("b", 40), "candidateTree": hex_("c", 40),
                 "riskLevel": "low", "selectedLenses": [], "originalChangedLines": 6, "now": NOW})
    assert out["ok"] and out["ackToken"]
    create_state(dir_, out["record"], LOCK)
    return Approved(lineage=lineage_of(n), target=target_of(n), revision=out["record"]["revision"], token=out["ackToken"], record=out["record"])


def seed_medium(dir_, n):
    """Medium risk: one lens admitted, then approved."""
    s = start({"lineageId": lineage_of(n), "targetIdentity": target_of(n), "projection": "staged", "baseTree": hex_("b", 40), "candidateTree": hex_("d", 40),
               "riskLevel": "medium", "selectedLenses": ["reliability"], "originalChangedLines": 30, "now": NOW})
    assert s["ok"]
    a = admit_lens_result(s["record"], {"now": NOW, "lens": "reliability", "findings": [], "resultHash": f"sha256:{hex_('e', 64)}"})
    assert a["ok"]
    ap = approve(a["record"], {"now": NOW})
    assert ap["ok"]
    create_state(dir_, ap["record"], LOCK)
    return Approved(lineage=lineage_of(n), target=target_of(n), revision=ap["record"]["revision"], token=ap["ackToken"], record=ap["record"])


def state_file(dir_, lin):
    return os.path.join(store_root_for(dir_), lin, "review-state.json")


def receipt_file(dir_, lin):
    return os.path.join(store_root_for(dir_), lin, "review-receipt.json")


def refusal(fn):
    with pytest.raises(AckRefusedError) as e:
        fn()
    return e.value.code


def ack(dir_, a, **over):
    inp = {"lineage": a.lineage, "target": a.target, "expectedRevision": a.revision, "token": a.token, **over}
    return acknowledge_approved(dir_, inp, AcknowledgeOptions(lock=LOCK.lock, now=lambda: BURN_AT))


CHILD_SRC = r'''
import json, os, signal, sys
cd, lineage, revision, target, token, kill_at, phase = (sys.argv[1:] + [""] * 7)[:7]
kill_at = int(kill_at or 0)
tracked, labels, n = set(), [], [0]
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
real = {k: getattr(os, k) for k in ("open", "write", "fsync", "fchmod", "close", "rename", "mkdir", "unlink", "rmdir")}
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
def path_fn(name, label):
    def f(p, *x, **k):
        return ev(label + " " + p[len(cd):], lambda: real[name](p, *x, **k)) if interesting(p) else real[name](p, *x, **k)
    return f
os.open, os.close = p_open, p_close
os.rename, os.mkdir, os.unlink, os.rmdir = path_fn("rename", "rename"), path_fn("mkdir", "mkdir"), path_fn("unlink", "rm"), path_fn("rmdir", "rm")
for k in ("write", "fsync", "fchmod"):
    setattr(os, k, tracked_fn(k))
from odd_claude.review.ack import AckRefusedError, AcknowledgeOptions, acknowledge_approved
from odd_claude.review.lock import StoreLockOptions
try:
    acknowledge_approved(cd, {"lineage": lineage, "target": target, "expectedRevision": revision, "token": token}, AcknowledgeOptions(lock=StoreLockOptions(timeout_ms=30000, poll_ms=5)))
    result = {"ok": True}
except Exception as e:
    result = {"ok": False, "code": e.code if isinstance(e, AckRefusedError) else type(e).__name__}
print(json.dumps({**result, "n": n[0], "labels": labels}))
'''


def run_child(dir_, a, kill_at=0, phase="before"):
    r = subprocess.run([sys.executable, "-c", CHILD_SRC, dir_, a.lineage, a.revision, a.target, a.token, str(kill_at), phase], capture_output=True, text=True, timeout=120)
    line = [x for x in r.stdout.strip().split("\n") if x][-1:] 
    out = json.loads(line[0]) if line else {"ok": False, "n": 0, "labels": []}
    return {**out, "signal": -r.returncode if r.returncode < 0 else None, "stderr": r.stderr}


# ---- happy path ----


def test_low_risk_lineage_approved_at_start_burns_and_leaves_a_valid_receipt(d):
    a = seed_low(d, 1)
    assert a.record["state"] == "approved"
    out = ack(d, a)
    assert out["ok"] is True
    state = read_state(d, a.lineage)
    assert state["burned"] is True and state["burn_receipt"] == out["receipt"]["burn_receipt"]
    stored = read_receipt(d, a.lineage)
    v = validate_receipt(stored)
    assert v["ok"], v
    assert stored == out["receipt"]
    r = out["receipt"]
    assert r["schema"] == RECEIPT_SCHEMA == "odd-claude.review-receipt/v1"
    assert (r["lineage_id"], r["target_identity"], r["base_tree"], r["candidate_tree"]) == (a.lineage, a.target, hex_("b", 40), hex_("c", 40))
    assert r["approved_revision"] == a.revision and r["burned_at"] == BURN_AT and state["updated_at"] == BURN_AT
    assert r["selected_lenses"] == [] and r["risk_level"] == "low"
    assert "paths_digest" not in r
    assert r["ledger_hash"] == a.record["ledger_hash"] and r["evidence_hash"] == a.record["evidence_hash"]
    assert find_receipt_for_target(d, a.target) == {"receipt": r, "truncated": False, "problems": []}
    assert is_target_consumed(d, a.target) == {"status": "consumed", "consumed": True, "truncated": False, "problems": []}
    with open(receipt_file(d, a.lineage), "rb") as f:
        assert f.read() == (canonical_json(r) + "\n").encode()


def test_medium_risk_lineage_records_its_lenses_projection_and_trees(d):
    a = seed_medium(d, 2)
    out = ack(d, a)
    r = out["receipt"]
    assert r["selected_lenses"] == ["reliability"] and r["risk_level"] == "medium" and r["projection"] == "staged" and r["candidate_tree"] == hex_("d", 40)
    assert validate_receipt(read_receipt(d, a.lineage))["ok"]


def test_the_default_clock_stamps_an_rfc_3339_utc_millisecond_timestamp(d):
    import re

    a = seed_low(d, 22)
    out = acknowledge_approved(d, {"lineage": a.lineage, "target": a.target, "expectedRevision": a.revision, "token": a.token})
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", out["receipt"]["burned_at"])
    assert validate_receipt(out["receipt"])["ok"]


# ---- typed refusals leave state and store unchanged ----


def snap(d_, a):
    with open(state_file(d_, a.lineage), "rb") as f:
        st = f.read()
    return {"state": st, "receipt": os.path.exists(receipt_file(d_, a.lineage)), "files": sorted(os.listdir(os.path.join(store_root_for(d_), a.lineage)))}


def test_refusals_wrong_token_malformed_token_wrong_target_stale_revision_change_nothing(d):
    a = seed_low(d, 3)
    before = snap(d, a)
    assert refusal(lambda: ack(d, a, token=hex_("a", 64))) == "wrong_token"
    assert refusal(lambda: ack(d, a, token="nope")) == "wrong_token"
    assert refusal(lambda: ack(d, a, token=a.token.upper())) == "wrong_token"
    assert refusal(lambda: ack(d, a, target=target_of(99))) == "wrong_target"
    assert refusal(lambda: ack(d, a, expectedRevision=f"sha256:{hex_('1', 64)}")) == "concurrent_update"
    assert refusal(lambda: ack(d, a, target="x")) == "invalid_input"
    assert refusal(lambda: ack(d, a, expectedRevision="x")) == "invalid_input"
    assert snap(d, a) == before
    assert is_target_consumed(d, a.target)["consumed"] is False
    assert ack(d, a)["ok"] is True  # the genuine token still works afterwards


def test_refusal_messages_are_prefixed_with_the_code(d):
    a = seed_low(d, 23)
    with pytest.raises(AckRefusedError) as e:
        ack(d, a, target="x")
    assert str(e.value) == "acknowledge refused (invalid_input): target must be sha256:<64 hex>"
    with pytest.raises(AckRefusedError) as e:
        ack(d, a, token="nope")
    assert str(e.value) == "acknowledge refused (wrong_token): the acknowledgement token must be 64 lowercase hex characters"
    with pytest.raises(AckRefusedError) as e:
        ack(d, a, target=target_of(99))
    assert str(e.value) == "acknowledge refused (wrong_target): the target does not match this lineage"


def test_refusal_a_lineage_that_is_not_approved_is_not_acknowledged(d):
    out = start({"lineageId": lineage_of(4), "targetIdentity": target_of(4), "projection": "workspace", "baseTree": hex_("b", 40), "candidateTree": hex_("c", 40),
                 "riskLevel": "medium", "selectedLenses": ["risk"], "originalChangedLines": 6, "now": NOW})
    assert out["ok"]
    create_state(d, out["record"], LOCK)
    a = Approved(lineage=lineage_of(4), target=target_of(4), revision=out["record"]["revision"], token=hex_("a", 64), record=out["record"])
    before = snap(d, a)
    assert refusal(lambda: ack(d, a)) == "not_approved"
    assert snap(d, a) == before


def test_refusal_a_second_acknowledge_is_target_already_acknowledged_and_changes_nothing(d):
    a = seed_low(d, 5)
    ack(d, a)
    before = snap(d, a)
    receipt_before = open(receipt_file(d, a.lineage), "rb").read()
    assert refusal(lambda: ack(d, a)) == "target_already_acknowledged"  # stale (pre-burn) revision
    live = read_state(d, a.lineage)["revision"]
    assert refusal(lambda: ack(d, a, expectedRevision=live)) == "target_already_acknowledged"
    assert refusal(lambda: ack(d, a, expectedRevision=live, token=hex_("a", 64))) == "target_already_acknowledged"
    assert snap(d, a) == before
    assert open(receipt_file(d, a.lineage), "rb").read() == receipt_before


def test_refusal_a_corrupt_pre_existing_receipt_blocks_the_burn_and_nothing_changes(d):
    a = seed_low(d, 6)
    open(receipt_file(d, a.lineage), "w").write("{not json")
    before = snap(d, a)
    assert refusal(lambda: ack(d, a)) == "corrupt_receipt"
    assert snap(d, a) == before
    assert read_state(d, a.lineage)["burned"] is False


def test_refusal_a_receipt_path_that_is_not_a_file_or_is_a_symlink_is_corrupt_receipt(d):
    a = seed_low(d, 24)
    os.mkdir(receipt_file(d, a.lineage))
    before = snap(d, a)
    assert refusal(lambda: ack(d, a)) == "corrupt_receipt"
    assert snap(d, a) == before


def test_refusal_a_valid_looking_receipt_that_disagrees_with_the_approval_is_corrupt_receipt(d):
    a = seed_low(d, 7)
    other = seed_low(d, 8)
    ack(d, other)  # its receipt is valid, but for another lineage
    with open(receipt_file(d, a.lineage), "wb") as f:
        f.write(open(receipt_file(d, other.lineage), "rb").read())
    before = snap(d, a)
    assert refusal(lambda: ack(d, a)) == "corrupt_receipt"
    assert snap(d, a) == before


def test_a_matching_receipt_from_a_crashed_attempt_is_reused_with_its_burned_at(d):
    a = seed_low(d, 25)
    ack(d, a)
    receipt = read_receipt(d, a.lineage)
    # rewind to "approved + receipt, unburned" by restoring the approved state bytes
    st = read_state(d, a.lineage)
    assert st["burned"]
    from odd_claude.review.store import write_atomic

    write_atomic(state_file(d, a.lineage), canonical_json(a.record) + "\n")
    os.utime(state_file(d, a.lineage))
    out = acknowledge_approved(d, {"lineage": a.lineage, "target": a.target, "expectedRevision": a.revision, "token": a.token}, AcknowledgeOptions(lock=LOCK.lock, now=lambda: "2030-01-01T00:00:00.000Z"))
    assert out["receipt"] == receipt and out["record"]["updated_at"] == receipt["burned_at"] == BURN_AT


# ---- receipt validation ----


def test_validate_receipt_rejects_tampering_unknown_and_missing_fields(d):
    a = seed_low(d, 9)
    receipt = ack(d, a)["receipt"]
    assert validate_receipt(receipt)["ok"]
    assert validate_receipt({**receipt, "risk_level": "high"})["ok"] is False  # hash no longer matches
    assert validate_receipt({**receipt, "extra": 1}) == {"ok": False, "errors": ["unknown field extra"]}
    missing = {k: v for k, v in receipt.items() if k != "burned_at"}
    assert validate_receipt(missing) == {"ok": False, "errors": ["missing field burned_at"]}
    assert validate_receipt({**receipt, "schema": "other-tool.review-receipt/v1"})["ok"] is False
    assert validate_receipt(None) == {"ok": False, "errors": ["receipt must be an object"]}
    assert validate_receipt([]) == {"ok": False, "errors": ["receipt must be an object"]}
    assert validate_receipt({**receipt, "receipt_hash": "sha256:" + "0" * 64}) == {"ok": False, "errors": ["receipt_hash does not match the receipt content"]}


def test_validate_receipt_names_every_malformed_field_in_order(d):
    a = seed_low(d, 26)
    r = ack(d, a)["receipt"]
    bad = {**r, "schema": "x", "lineage_id": "l", "target_identity": "t", "projection": "p", "base_tree": "z", "burned_at": "2026-02-30", "risk_level": "r", "selected_lenses": ["risk", "nope"]}
    assert validate_receipt(bad) == {"ok": False, "errors": [
        f"schema must be {RECEIPT_SCHEMA}", "lineage_id must match review-<16 hex>", "target_identity must be sha256:<64 hex>",
        "projection must be workspace or staged", "base_tree must be a tree id", "burned_at must be a UTC RFC 3339 timestamp",
        "risk_level must be low, medium or high", "selected_lenses must be a list of known lenses"]}
    assert validate_receipt({**r, "burned_at": "2026-11-19T10:05:00١Z"})["ok"] is False  # ASCII digits only


# ---- gates ----


def test_find_receipt_for_target_ignores_other_lineages_unknown_targets_and_unburned_approvals_are_not_consumed(d):
    a, b, c = seed_low(d, 10), seed_medium(d, 11), seed_low(d, 12)  # c: approved, never acknowledged
    ra, rb = ack(d, a), ack(d, b)
    assert find_receipt_for_target(d, a.target)["receipt"] == ra["receipt"]
    assert find_receipt_for_target(d, b.target)["receipt"] == rb["receipt"]
    assert "receipt" not in find_receipt_for_target(d, c.target)
    assert is_target_consumed(d, c.target)["consumed"] is False
    assert "receipt" not in find_receipt_for_target(d, target_of(777))
    assert is_target_consumed(d, target_of(777))["consumed"] is False


def test_a_valid_receipt_next_to_an_unburned_approval_is_never_consumption(d):
    a, done = seed_low(d, 13), seed_low(d, 14)
    receipt = ack(d, done)["receipt"]
    body = {k: v for k, v in {**receipt, "lineage_id": a.lineage, "target_identity": a.target}.items() if k != "receipt_hash"}
    write_receipt(d, a.lineage, {**body, "receipt_hash": domain_hash("review-receipt", 1, body)}, LOCK)
    assert "receipt" not in find_receipt_for_target(d, a.target)
    assert is_target_consumed(d, a.target) == {"status": "not_consumed", "consumed": False, "truncated": False, "problems": []}


def test_a_burned_state_whose_receipt_is_missing_corrupt_or_mismatched_yields_no_receipt_and_is_never_plain_consumed(d):
    a = seed_low(d, 15)
    ack(d, a)
    open(receipt_file(d, a.lineage), "w").write("{not json")
    r = find_receipt_for_target(d, a.target)
    assert "receipt" not in r and r["problems"][0]["code"] == "receipt_corrupt"
    assert is_target_consumed(d, a.target)["status"] == "unknown"
    other = seed_low(d, 16)
    ack(d, other)
    with open(receipt_file(d, a.lineage), "wb") as f:
        f.write(open(receipt_file(d, other.lineage), "rb").read())
    r = find_receipt_for_target(d, a.target)
    assert "receipt" not in r and r["problems"][0]["code"] == "receipt_mismatch"
    assert r["problems"][0]["message"] == "the receipt does not match the burned state"
    assert is_target_consumed(d, a.target)["status"] == "unknown"


def test_f1_a_burned_lineage_with_a_missing_or_corrupt_receipt_is_not_plain_consumed(d):
    a = seed_low(d, 40)
    ack(d, a)
    open(receipt_file(d, a.lineage), "w").write("{}")
    r = is_target_consumed(d, a.target)
    assert r["consumed"] is not True and r["status"] == "unknown" and r["problems"][0]["code"] == "receipt_corrupt"
    os.unlink(receipt_file(d, a.lineage))
    m = is_target_consumed(d, a.target)
    assert m["consumed"] is not True and m["problems"][0]["code"] == "receipt_missing"


def test_f1_an_unreadable_state_is_never_reported_as_plain_not_consumed_or_consumed(d):
    a = seed_low(d, 42)
    ack(d, a)
    open(state_file(d, a.lineage), "w").write("{garbage")
    r = is_target_consumed(d, a.target)
    assert r["status"] == "unknown" and r["consumed"] is False and r["problems"][0]["code"] == "state_unreadable"
    assert "receipt" not in find_receipt_for_target(d, a.target)


def test_f1_a_valid_matching_receipt_stays_consumed_even_beside_an_unrelated_unreadable_lineage(d):
    a, b = seed_low(d, 43), seed_low(d, 48)
    ack(d, a)
    open(state_file(d, b.lineage), "w").write("{garbage")
    r = is_target_consumed(d, a.target)
    assert r["consumed"] is True and r["problems"][0]["code"] == "state_unreadable"
    assert is_target_consumed(d, target_of(555))["status"] == "unknown"


def test_f2_a_re_hashed_receipt_whose_risk_lenses_projection_ledger_disagree_with_the_burned_state_is_a_mismatch(d):
    a = seed_medium(d, 41)
    receipt = ack(d, a)["receipt"]

    def forge(patch):
        forged = {**{k: v for k, v in receipt.items() if k != "receipt_hash"}, **patch}
        open(receipt_file(d, a.lineage), "w").write(canonical_json({**forged, "receipt_hash": domain_hash("review-receipt", 1, forged)}) + "\n")
        return find_receipt_for_target(d, a.target)

    for patch in [{"risk_level": "low", "selected_lenses": []}, {"risk_level": "high"}, {"selected_lenses": ["risk"]}, {"projection": "workspace"},
                  {"ledger_hash": f"sha256:{hex_('7', 64)}"}, {"evidence_hash": f"sha256:{hex_('7', 64)}"}, {"base_tree": hex_("9", 40)}, {"candidate_tree": hex_("9", 40)},
                  {"burned_at": "2026-11-19T10:06:00.000Z"}, {"burn_receipt": f"sha256:{hex_('7', 64)}"}]:
        f = forge(patch)
        assert "receipt" not in f, patch
        assert f["problems"][0]["code"] == "receipt_mismatch", patch
        assert is_target_consumed(d, a.target)["status"] == "unknown" and is_target_consumed(d, a.target)["consumed"] is False, patch


def test_g1_an_uncertain_consumption_is_never_truthy(d):
    a = seed_low(d, 50)
    ack(d, a)
    open(receipt_file(d, a.lineage), "w").write("{}")
    r = is_target_consumed(d, a.target)
    assert bool(r["consumed"]) is False and r["status"] == "unknown" and r["problems"][0]["code"] == "receipt_corrupt"


def test_g2_a_re_hashed_receipt_with_a_foreign_approved_revision_is_not_proof(d):
    a = seed_medium(d, 51)
    receipt = ack(d, a)["receipt"]
    assert read_state(d, a.lineage)["approved_revision"] == a.revision
    forged = {**{k: v for k, v in receipt.items() if k != "receipt_hash"}, "approved_revision": f"sha256:{hex_('f', 64)}"}
    open(receipt_file(d, a.lineage), "w").write(canonical_json({**forged, "receipt_hash": domain_hash("review-receipt", 1, forged)}) + "\n")
    f = find_receipt_for_target(d, a.target)
    assert "receipt" not in f and f["problems"][0]["code"] == "receipt_mismatch"
    assert is_target_consumed(d, a.target)["status"] == "unknown"


def test_truncated_scan_without_a_match_is_not_consumed_a_match_inside_the_window_is(d):
    a, b = seed_low(d, 0x22), seed_low(d, 0x30)
    ack(d, b)
    t = is_target_consumed(d, b.target, {"limit": 1})
    assert t["consumed"] is False and t["status"] == "not_consumed" and t["truncated"] is True
    ack(d, a)
    m = is_target_consumed(d, a.target, {"limit": 1})
    assert m["consumed"] is True and m["status"] == "consumed"


def test_f4_an_invalid_or_unknown_lineage_is_a_typed_ack_refused_error(d):
    a = seed_low(d, 44)
    assert refusal(lambda: ack(d, a, lineage="not-a-lineage")) == "invalid_input"
    assert refusal(lambda: ack(d, a, lineage=lineage_of(999))) == "authority_absent"
    with tempfile.TemporaryDirectory(prefix="odd-ack-empty-") as empty:
        assert refusal(lambda: ack(os.path.realpath(empty), a)) == "authority_absent"  # no store at all


def test_token_edge_cases_are_wrong_token_with_nothing_changed(d):
    a = seed_low(d, 45)
    other = seed_low(d, 46)
    before = snap(d, a)
    for token in [f"{a.token}\n", f"{a.token}\0", f"\0{a.token[1:]}", f"{a.token} ", 12345, None, {}, [a.token], "", other.token, "é" * 64, True]:
        assert refusal(lambda: ack(d, a, token=token)) == "wrong_token", repr(token)
    assert snap(d, a) == before
    assert snap(d, other)["receipt"] is False
    assert ack(d, a)["ok"] is True


def test_a_missing_input_is_invalid_input_and_a_missing_token_wrong_token(d):
    a = seed_low(d, 27)
    assert refusal(lambda: acknowledge_approved(d, None)) == "invalid_input"
    assert refusal(lambda: acknowledge_approved(d, {"lineage": a.lineage, "expectedRevision": a.revision, "token": a.token})) == "invalid_input"
    assert refusal(lambda: acknowledge_approved(d, {"lineage": a.lineage, "target": a.target, "token": a.token})) == "invalid_input"
    assert refusal(lambda: acknowledge_approved(d, {"target": a.target, "expectedRevision": a.revision, "token": a.token})) == "invalid_input"
    assert refusal(lambda: acknowledge_approved(d, {"lineage": a.lineage, "target": a.target, "expectedRevision": a.revision})) == "wrong_token"


def test_the_scan_is_bounded_and_reports_truncation(d):
    a = seed_low(d, 17)
    seed_low(d, 18)
    ack(d, a)
    assert find_receipt_for_target(d, a.target, {"maxScan": 1})["truncated"] is True
    assert is_target_consumed(d, a.target, {"limit": 1})["truncated"] is True
    assert is_target_consumed(d, a.target)["truncated"] is False
    assert scan_target(d, a.target)["burnedLineages"] == [a.lineage]


def test_an_empty_store_scans_clean(d):
    assert is_target_consumed(d, target_of(1)) == {"status": "not_consumed", "consumed": False, "truncated": False, "problems": []}
    assert scan_target(d, target_of(1)) == {"receipts": [], "burnedLineages": [], "truncated": False, "problems": []}


# ---- budgets ----


def test_budget_status_reuses_the_state_budget_and_attempt_cap(d):
    a = seed_low(d, 19)
    assert budget_status(a.record) == {"correctionBudget": 3, "actualCorrectionLines": 0, "linesRemaining": 3, "attempts": 0, "attemptsRemaining": 2}
    assert budget_status({**a.record, "correction_attempts": 1, "actual_correction_lines": 2}) == {
        "correctionBudget": 3, "actualCorrectionLines": 2, "linesRemaining": 1, "attempts": 1, "attemptsRemaining": 1}
    assert budget_status({**a.record, "correction_attempts": 5, "actual_correction_lines": 9}) == {
        "correctionBudget": 3, "actualCorrectionLines": 9, "linesRemaining": 0, "attempts": 5, "attemptsRemaining": 0}


# ---- concurrency ----


def test_concurrent_acknowledges_with_the_same_token_exactly_one_succeeds_one_receipt_one_burn(d):
    a = seed_low(d, 20)
    with ThreadPoolExecutor(6) as ex:
        results = list(ex.map(lambda _: run_child(d, a), range(6)))
    assert sum(1 for r in results if r["ok"]) == 1, results
    for r in results:
        if not r["ok"]:
            assert r["code"] in ("target_already_acknowledged", "concurrent_update"), r
    state = read_state(d, a.lineage)
    assert state["burned"] is True
    v = validate_receipt(read_receipt(d, a.lineage))
    assert v["ok"] and v["receipt"]["burn_receipt"] == state["burn_receipt"]
    assert [f for f in os.listdir(os.path.join(store_root_for(d), a.lineage)) if f.startswith(".atomic-")] == []
    assert is_target_consumed(d, a.target)["consumed"] is True


def test_16_parallel_processes_with_the_same_token_exactly_one_succeeds(d):
    a = seed_low(d, 47)
    with ThreadPoolExecutor(16) as ex:
        results = list(ex.map(lambda _: run_child(d, a), range(16)))
    assert sum(1 for r in results if r["ok"]) == 1, results
    for r in results:
        if not r["ok"]:
            assert r["code"] in ("target_already_acknowledged", "concurrent_update"), r
    assert read_state(d, a.lineage)["burned"] is True
    assert validate_receipt(read_receipt(d, a.lineage))["ok"]


# ---- crash safety: SIGKILL at every fs call ----


def test_crash_at_every_fs_call_never_burned_without_receipt_never_receipt_as_consumption_retry_with_the_same_token_completes(tmp_path):
    with tempfile.TemporaryDirectory(prefix="odd-ack-") as pd:
        probe = seed_low(os.path.realpath(pd), 30)
        counted = run_child(os.path.realpath(pd), probe, 0, "before")
        assert counted["ok"] is True, counted
    total, labels = counted["n"], counted["labels"]
    assert total >= 8, f"expected a non-trivial number of fs calls, got {total}"
    assert any("review-receipt.json" in label for label in labels) or any(".atomic-" in label for label in labels)

    def one(job):
        k, phase = job
        with tempfile.TemporaryDirectory(prefix="odd-ack-") as t:
            dd = os.path.realpath(t)
            a = seed_low(dd, 31)
            child = run_child(dd, a, k, phase)
            where = f"k={k} {phase} ({labels[k - 1]})"
            # an "open" that fails (ENOENT probe of an absent receipt) raises before the "after" kill point: nothing to crash
            if child["signal"] is None and phase == "after" and labels[k - 1].startswith("open "):
                return None
            assert child["signal"] == signal.SIGKILL, f"{where}: child was not killed: {child}"
            state = read_state(dd, a.lineage)
            has_receipt = os.path.exists(receipt_file(dd, a.lineage))
            consumed = is_target_consumed(dd, a.target)
            seen = None
            if state["burned"]:
                assert has_receipt, f"{where}: burned WITHOUT a receipt"
                assert validate_receipt(read_receipt(dd, a.lineage))["ok"], f"{where}: burned with an invalid receipt"
                assert consumed["consumed"] is True, where
                assert find_receipt_for_target(dd, a.target)["receipt"]["burn_receipt"] == state["burn_receipt"], where
                seen = "burned"
            else:
                assert consumed["consumed"] is False, f"{where}: unburned approval counted as consumed"
                assert "receipt" not in find_receipt_for_target(dd, a.target), where
                assert state["revision"] == a.revision, where
                seen = "receipt_unburned" if has_receipt else "nothing"
            try:
                ack(dd, a)
                retry = "ok"
            except AckRefusedError as e:
                retry = e.code
            if state["burned"]:
                assert retry == "target_already_acknowledged", where
            else:
                assert retry == "ok", f"{where}: retry did not complete"
            final = read_state(dd, a.lineage)
            assert final["burned"] is True, where
            v = validate_receipt(read_receipt(dd, a.lineage))
            assert v["ok"], where
            r = v["receipt"]
            assert (r["burn_receipt"], r["approved_revision"], r["burned_at"]) == (final["burn_receipt"], a.revision, final["updated_at"]), where
            assert is_target_consumed(dd, a.target)["consumed"] is True, where
            assert find_receipt_for_target(dd, a.target)["receipt"]["receipt_hash"] == r["receipt_hash"], where
            assert refusal(lambda: ack(dd, a)) == "target_already_acknowledged", where  # and a further attempt is refused
            return seen

    jobs = [(k, ph) for k in range(1, total + 1) for ph in ("before", "after")]
    with ThreadPoolExecutor(8) as ex:
        seen = {s for s in ex.map(one, jobs) if s}
    assert "receipt_unburned" in seen, "the receipt/burn boundary was never exercised"
    assert "burned" in seen, "no crash point landed after the burn commit"
    assert "nothing" in seen, "no crash point landed before the receipt"


# ---- after a correction the acknowledgement binds the validated corrected candidate ----


def seed_corrected(dir_, n):
    s = start({"lineageId": lineage_of(n), "targetIdentity": target_of(n), "projection": "workspace", "baseTree": hex_("b", 40), "candidateTree": hex_("c", 40),
               "riskLevel": "medium", "selectedLenses": ["reliability"], "originalChangedLines": 8, "now": NOW})
    assert s["ok"]
    finding = {"id": "R3-001", "lens": "reliability", "severity": "CRITICAL", "location": "a.ts:1", "claim": "boom"}
    a = admit_lens_result(s["record"], {"now": NOW, "lens": "reliability", "findings": [finding], "resultHash": f"sha256:{hex_('e', 64)}"})
    assert a["ok"]
    c = require_correction(a["record"], {"fixFindingIds": ["R3-001"], "now": NOW})
    assert c["ok"]
    corrected = target_of(n + 1000)
    v = begin_validation(c["record"], {"actualCorrectionLines": 2, "correctionTargetIdentity": corrected, "correctionCandidateTree": hex_("d", 40), "now": NOW})
    assert v["ok"]
    adm = admit_validator_result(v["record"], {"now": NOW, "resultHash": f"sha256:{hex_('f', 64)}"})
    assert adm["ok"]
    ap = approve(adm["record"], {"now": NOW})
    assert ap["ok"]
    create_state(dir_, ap["record"], LOCK)
    return Approved(lineage=lineage_of(n), target=corrected, original=target_of(n), corrected=corrected, revision=ap["record"]["revision"], token=ap["ackToken"], record=ap["record"])


def test_ack_refuses_an_identity_that_is_neither_the_target_nor_the_validated_corrected_candidate_binding_the_corrected_one_consumes_only_it(d):
    a = seed_corrected(d, 21)
    rev = a.revision
    assert refusal(lambda: ack(d, a, target=a.original)) == "wrong_target"
    assert refusal(lambda: ack(d, a, target=target_of(999))) == "wrong_target"
    assert read_state(d, a.lineage)["revision"] == rev and read_state(d, a.lineage)["burned"] is False
    assert not os.path.exists(receipt_file(d, a.lineage))
    done = ack(d, a)
    assert done["receipt"]["target_identity"] == a.corrected and done["receipt"]["candidate_tree"] == hex_("d", 40)
    assert done["record"]["target_identity"] == a.corrected
    assert is_target_consumed(d, a.corrected)["status"] == "consumed"
    assert is_target_consumed(d, a.original) == {"status": "not_consumed", "consumed": False, "truncated": False, "problems": []}
    assert "receipt" not in find_receipt_for_target(d, a.original)
    assert find_receipt_for_target(d, a.corrected)["receipt"]["lineage_id"] == a.lineage
