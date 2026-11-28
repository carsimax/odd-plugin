"""S4: a review transaction written by v9 is readable by Python and the reverse. One lineage is driven start -> consent -> approved -> burned
through the v9 server (`node dist/mcp/review-server.js`) and the Python server over stdio, in all four orders of (who starts, who finishes),
then read with the Python store and status modules AND through both servers (`review_inspect`, `review_status`), which must answer the
same bytes. The reviewer is a fake `claude` first on PATH (never the real one); HOME and the data dir are sandboxed under tmp_path; the
`test-fixtures/contracts/review-store/` fixture is placed in a store and read by Python and v9 without a schema error."""
import json
import os
from pathlib import Path

import pytest
from odd_claude.review.ack import is_target_consumed, validate_receipt
from odd_claude.review.snapshot import resolve_repository
from odd_claude.review.state import validate_state_record
from odd_claude.review.status import review_status
from odd_claude.review.store import list_lineages, read_receipt, read_state, store_root_for

from mcp.conftest import Fx, Stdio, binding_values, child_env, choice_args, make_echo_claude, needs_v9_server
from review.conftest import REPO_ROOT

pytestmark = needs_v9_server

IMPLS = ["v9", "py"]


def client(impl: str, f: Fx, claude: str) -> Stdio:
    c = Stdio(impl, child_env(f.dir, f.data, claude), f.repo)
    c.initialize()
    return c


def read_through_both(f: Fx, claude: str, lineage: str) -> dict:
    """review_inspect / review_status / review_assess as the two servers see the store: byte-identical texts."""
    texts = {}
    for impl in IMPLS:
        c = client(impl, f, claude)
        try:
            texts[impl] = [c.request("tools/call", {"name": n, "arguments": a})["result"]["content"][0]["text"] for n, a in (("review_inspect", {}), ("review_status", {}), ("review_assess", {}))]
        finally:
            assert c.close() == 0
    assert texts["py"] == texts["v9"]
    return {"inspect": json.loads(texts["py"][0]), "status": json.loads(texts["py"][1])}


@pytest.mark.parametrize("second", IMPLS)
@pytest.mark.parametrize("first", IMPLS)
def test_s4_a_lineage_started_by_one_implementation_is_finished_by_the_other_and_read_by_both(first, second, make_fx, tmp_path):
    f = make_fx()
    claude = make_echo_claude(tmp_path)
    a = client(first, f, claude)
    try:
        env = a.call("review_start").body
        assert env["action"] == "consent_required"
        lineage = a.call("review_answer_consent", choice_args(env, "granted")).body["lineage_id"]
    finally:
        assert a.close() == 0
    # the Python store reads what `first` wrote (reviewing, one lineage, the schema validates)
    mid = read_state(f.common_dir, lineage)
    assert mid["state"] == "reviewing" and mid["burned"] is not True
    assert validate_state_record(mid)["ok"] is True
    assert list_lineages(f.common_dir)["lineages"] == [lineage]
    seen = read_through_both(f, claude, lineage)
    assert seen["inspect"]["lineages"][0]["state"] == "reviewing" and seen["inspect"]["unreadable"] == []
    assert seen["status"]["next_transition"]["kind"] == "collect"

    b = client(second, f, claude)
    try:
        fc = b.call("review_run", {"lineage_id": lineage}).body
        assert fc["outcome"] == "forecast"
        done = b.call("review_run", {"lineage_id": lineage, "reviewer_run_acknowledged": True, "reviewer_run_binding": fc["reviewer_run_binding"]}).body
        assert done["outcome"] == "closed" and done["acknowledgement"]["outcome"] == "acknowledged"
    finally:
        assert b.close() == 0

    rec = read_state(f.common_dir, lineage)
    assert rec["state"] == "approved" and rec["burned"] is True
    assert validate_state_record(rec)["ok"] is True
    receipt = read_receipt(f.common_dir, lineage)
    assert validate_receipt(receipt)["ok"] is True
    assert receipt["target_identity"] == rec["target_identity"] and receipt["approved_revision"] == rec["approved_revision"]
    assert is_target_consumed(f.common_dir, rec["target_identity"])["status"] == "consumed"
    assert list_lineages(f.common_dir)["lineages"] == [lineage]
    # Python's own status module, and both servers, agree the candidate is closed
    st = review_status(f.repo, {"target": {"kind": "current-changes"}})
    assert st["next_transition"]["kind"] == "stop"
    after = read_through_both(f, claude, lineage)
    assert after["inspect"]["lineages"][0]["burned"] is True and after["inspect"]["lineages"][0]["state"] == "approved"
    assert after["status"] == st or after["status"]["next_transition"] == st["next_transition"]


@pytest.mark.parametrize("second", IMPLS)
@pytest.mark.parametrize("first", IMPLS)
def test_s4_low_risk_start_by_one_acknowledge_by_the_other(first, second, make_fx, tmp_path):
    """The shortest transaction: a documentation-only candidate is approved at once with its one-shot token; the other implementation burns it."""
    f = make_fx(dirty=False, files={"a.md": "one\n"})
    f.write("a.md", "one\ntwo\n")
    claude = make_echo_claude(tmp_path)
    a = client(first, f, claude)
    try:
        started = a.call("review_start").body
        assert started["action"] == "closed" and started["risk_level"] == "low"
    finally:
        assert a.close() == 0
    rec = read_state(f.common_dir, started["lineage_id"])
    assert rec["state"] == "approved" and rec["burned"] is not True and rec["risk_level"] == "low"
    b = client(second, f, claude)
    try:
        done = b.call("review_acknowledge_approved", started["acknowledgement"]).body
        assert done["outcome"] == "acknowledged" and done["burned"] is True
        again = b.call("review_acknowledge_approved", started["acknowledgement"])
        assert again.is_error is True
    finally:
        assert b.close() == 0
    burned = read_state(f.common_dir, started["lineage_id"])
    assert burned["burned"] is True and validate_receipt(read_receipt(f.common_dir, started["lineage_id"]))["ok"] is True
    assert is_target_consumed(f.common_dir, burned["target_identity"])["status"] == "consumed"
    read_through_both(f, claude, started["lineage_id"])


def test_s4_the_review_store_contract_fixture_is_read_by_python_and_v9_without_a_schema_error(make_fx, tmp_path):
    fx_dir = REPO_ROOT / "test-fixtures" / "contracts" / "review-store"
    state_text = (fx_dir / "review-state.json").read_text(encoding="utf-8")
    parsed = json.loads(state_text)
    f = make_fx()
    lineage = parsed["lineage_id"]
    d = Path(store_root_for(f.common_dir), lineage)
    d.mkdir(parents=True, mode=0o700)
    for name in ("review-state.json", "review-receipt.json"):
        fd = os.open(d / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as h:
            h.write((fx_dir / name).read_text(encoding="utf-8"))
    assert validate_state_record(read_state(f.common_dir, lineage))["ok"] is True
    assert validate_receipt(read_receipt(f.common_dir, lineage))["ok"] is True
    seen = read_through_both(f, make_echo_claude(tmp_path), lineage)
    assert [l["lineage_id"] for l in seen["inspect"]["lineages"]] == [lineage], "listed, not reported unreadable"
    assert seen["inspect"]["unreadable"] == []
    assert seen["inspect"]["lineages"][0]["burned"] is True
    assert resolve_repository(f.repo)["commonDir"] == f.common_dir
