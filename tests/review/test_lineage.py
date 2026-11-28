"""Port of v9 review/lineage.spec.ts (3 tests) plus extra cases (raw state reader, find_lineage over real stores)."""
import json
import os

import pytest

from odd_claude.review.lineage import find_lineage, has_role, lenses_pending, read_raw_state
from odd_claude.review.state import burn, start
from odd_claude.review.store import create_state, store_root_for, update_state


def rec(lenses, results):
    return {"selected_lenses": lenses, "admitted_role_results": results}


def test_lenses_pending_lists_selected_lenses_without_an_admitted_lens_result():
    r = rec(["a", "b", "c"], [{"role": "lens", "lens": "b"}, {"role": "refuter", "lens": "c"}])
    assert lenses_pending(r) == ["a", "c"]
    assert lenses_pending(rec([], [])) == []


def test_has_role_is_true_only_for_an_admitted_result_of_that_role():
    r = rec(["a"], [{"role": "lens", "lens": "a"}, {"role": "refuter"}])
    assert has_role(r, "lens") is True
    assert has_role(r, "refuter") is True
    assert has_role(r, "validator") is False


def test_find_lineage_on_a_store_without_lineages_finds_nothing(tmp_path):
    assert find_lineage(str(tmp_path), "id", "workspace") == {}


NOW = "2026-11-19T10:00:00.000Z"


def low(n, target="sha256:" + "1" * 64, projection="workspace"):
    out = start({"lineageId": f"review-{n:016x}", "targetIdentity": target, "projection": projection, "baseTree": "b" * 40, "candidateTree": "c" * 40,
                 "riskLevel": "low", "selectedLenses": [], "originalChangedLines": 6, "now": NOW})
    assert out["ok"]
    return out


def state_path(cd, n):
    return os.path.join(store_root_for(cd), f"review-{n:016x}", "review-state.json")


def test_read_raw_state_absent_oversized_invalid_and_unsafe(tmp_path):
    p = tmp_path / "s.json"
    assert read_raw_state(str(p)) is None  # absent
    p.write_text('{"a": 1}')
    assert read_raw_state(str(p)) == {"a": 1}
    p.write_text("[1]")
    assert read_raw_state(str(p)) is None
    p.write_text("not json")
    assert read_raw_state(str(p)) is None
    p.write_text("﻿{}")
    assert read_raw_state(str(p)) is None  # a BOM is not JSON
    p.write_bytes(b"x" * ((1 << 20) + 1))
    assert read_raw_state(str(p)) is None  # oversized regular file: skipped
    p.write_bytes(b'{"k": "\xff"}')
    assert read_raw_state(str(p)) == {"k": "�"}
    link = tmp_path / "l.json"
    link.symlink_to(p)
    assert read_raw_state(str(link)) == "unsafe"
    hard = tmp_path / "h.json"
    os.link(p, hard)
    assert read_raw_state(str(p)) == "unsafe" and read_raw_state(str(hard)) == "unsafe"
    assert read_raw_state(str(tmp_path)) == "unsafe"  # directory
    assert read_raw_state(str(tmp_path / "a\0b")) == "unsafe"


def test_find_lineage_picks_the_live_then_the_burned_lineage_of_the_exact_candidate(tmp_path):
    cd = str(tmp_path)
    a = low(1)
    create_state(cd, a["record"])
    found = find_lineage(cd, a["record"]["target_identity"], "workspace")
    assert found == {"live": a["record"]}
    assert find_lineage(cd, a["record"]["target_identity"], "staged") == {}
    assert find_lineage(cd, "sha256:" + "2" * 64, "workspace") == {}
    burned = update_state(cd, a["record"]["lineage_id"], a["record"]["revision"], lambda r: burn(r, {"token": a["ackToken"], "now": NOW}))["record"]
    assert find_lineage(cd, a["record"]["target_identity"], "workspace") == {"burned": burned}
    b = low(2)
    create_state(cd, b["record"])
    both = find_lineage(cd, a["record"]["target_identity"], "workspace")
    assert both["live"]["lineage_id"] == b["record"]["lineage_id"] and both["burned"]["lineage_id"] == a["record"]["lineage_id"]


def test_find_lineage_reports_an_unreadable_lineage_only_when_its_raw_record_claims_the_candidate(tmp_path):
    cd = str(tmp_path)
    a, b = low(1), low(2, target="sha256:" + "3" * 64)
    create_state(cd, a["record"])
    create_state(cd, b["record"])
    raw = json.loads(open(state_path(cd, 1)).read())
    open(state_path(cd, 1), "w").write(json.dumps({**raw, "revision": "sha256:" + "0" * 64}))  # revision mismatch: unreadable
    open(state_path(cd, 2), "w").write("{garbage")
    found = find_lineage(cd, a["record"]["target_identity"], "workspace")
    assert found == {"unreadable": a["record"]["lineage_id"]}
    assert find_lineage(cd, b["record"]["target_identity"], "workspace") == {}  # garbage claims nothing
    assert find_lineage(cd, a["record"]["target_identity"], "staged") == {}


def test_find_lineage_symlinked_state_is_unsafe_and_claims_nothing(tmp_path):
    cd = str(tmp_path)
    a = low(1)
    create_state(cd, a["record"])
    real = state_path(cd, 1)
    os.rename(real, real + ".real")
    os.symlink(real + ".real", real)
    assert find_lineage(cd, a["record"]["target_identity"], "workspace") == {}


def test_find_lineage_honors_limit_and_max_scan(tmp_path):
    cd = str(tmp_path)
    for n in (1, 2, 3):
        create_state(cd, low(n)["record"])
    t = "sha256:" + "1" * 64
    assert find_lineage(cd, t, "workspace", {"limit": 1})["live"]["lineage_id"] == "review-0000000000000001"
    assert find_lineage(cd, t, "workspace", {"maxScan": 0}) == {}
