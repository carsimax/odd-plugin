"""Port of v9 mcp/review-server.spec.ts (35 `test(` calls, the in-process parts) plus Python-specific cases (stdio framing through real pipes,
a thread-per-call concurrency check). Real temp git repos and data dirs under tmp_path; the reviewer is always the injected fake
(`review/test_run.fake_runner`), never the real `claude`. The stdio protocol cases that cross the process boundary live in
contract/review-server.spec.ts (run with ODD_IMPL=py) and in test_tools_list_parity / test_diff_review_server."""
import io
import json
import os
import re
import threading
import time
from pathlib import Path

import pytest
from mcp.conftest import (
    PLUGIN_ROOT,
    Called,
    binding_values,
    choice_args,
    error_code,
    git,
    good,
    lit,
    make_server,
    SEVERE,
    assess,
    fake_runner,
)
from odd_claude.mcp.jsonschema import SUPPORTED_KEYWORDS, validate_schema
from odd_claude.mcp.review_server import MAX_LINE_BYTES, SUPPORTED_PROTOCOLS, ReviewServer, serve
from odd_claude.mcp.tools import MAX_OUTPUT_BYTES, TOOL_BY_NAME, TOOLS, ToolDefinition, coerce_arguments
from odd_claude.review.consent import REVIEW_CONTRACT, REVIEW_TOOL_NAMES, consent_binding, off_path_command, read_decline
from odd_claude.review.mode import ModeOptions
from odd_claude.review.run import pending_correction_lineage
from odd_claude.review.start import snapshot_target_of
from odd_claude.review.store import list_lineages, read_state


def lineages(f):
    return list_lineages(f.common_dir)["lineages"]


def rpc(server, message):
    return server.handle(message)


# ---- protocol ----


def test_initialize_negotiates_the_protocol_version_and_advertises_only_tools_initialized_gets_no_reply():
    s = ReviewServer()
    for v in SUPPORTED_PROTOCOLS:
        r = rpc(s, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": v, "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}})
        result = r["result"]
        assert result["protocolVersion"] == v
        assert result["capabilities"] == {"tools": {"listChanged": False}}
        assert result["serverInfo"]["name"] == "odd-review"
        assert re.match(r"^\d+\.\d+\.\d+", result["serverInfo"]["version"])
    unknown = rpc(s, {"jsonrpc": "2.0", "id": "x", "method": "initialize", "params": {"protocolVersion": "1999-01-01"}})
    assert unknown["id"] == "x"
    assert unknown["result"]["protocolVersion"] == SUPPORTED_PROTOCOLS[0]
    assert rpc(s, {"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    assert rpc(s, {"jsonrpc": "2.0", "id": 2, "method": "ping"})["result"] == {}


def test_tools_list_names_exactly_the_final_review_tools_with_strict_schemas_annotations_and_no_forbidden_literal():
    s = ReviewServer()
    r = rpc(s, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    tools = r["result"]["tools"]
    assert [t["name"] for t in tools] == list(REVIEW_TOOL_NAMES)

    def walk(schema, where):
        for k in schema:
            assert k in SUPPORTED_KEYWORDS, f"{where}: unsupported keyword {k}"
        for k, v in (schema.get("properties") or {}).items():
            walk(v, f"{where}.{k}")
        if schema.get("items"):
            walk(schema["items"], f"{where}[]")
        if schema.get("type") == "object":
            assert schema.get("additionalProperties") is False, f"{where}: closed object"

    forbidden = re.compile("".join(["odd", "_review|gen", "tle|tele", "metry"]), re.I)
    for t in tools:
        assert 20 < len(t["description"]) < 2000, t["name"]
        assert t["inputSchema"]["type"] == "object"
        walk(t["inputSchema"], t["name"])
        assert isinstance(t["annotations"]["readOnlyHint"], bool)
        assert not forbidden.search(json.dumps(t))
    assert [t["name"] for t in tools if t["annotations"]["readOnlyHint"] is True] == ["review_assess", "review_inspect", "review_status"]
    assert [t.name for t in TOOLS] == [t["name"] for t in tools]


def test_protocol_errors_unknown_method_unknown_tool_bad_params_bad_request_batch():
    s = ReviewServer()

    def code(m):
        r = rpc(s, m)
        return None if r is None else r.get("error", {}).get("code")

    assert code({"jsonrpc": "2.0", "id": 1, "method": "resources/list"}) == -32601
    assert code({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "odd_nothing"}}) == -32602
    assert code({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {}}) == -32602
    assert code({"jsonrpc": "2.0", "id": 4, "method": "tools/call"}) == -32602
    assert code({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "review_status", "arguments": []}}) == -32602
    assert code({"id": 6, "method": "ping"}) == -32600
    assert code({"jsonrpc": "2.0", "id": {}, "method": "ping"}) == -32600
    assert code([{"jsonrpc": "2.0", "id": 7, "method": "ping"}]) == -32600
    assert code("nope") == -32600
    assert rpc(s, {"jsonrpc": "2.0", "method": "resources/list"}) is None, "an unknown notification is ignored"


def test_tools_call_invalid_arguments_are_a_typed_tool_error_that_changes_nothing(make_fx):
    f = make_fx()
    call = make_server(f)
    bad = [
        ("review_start", {"target": "everything"}),
        ("review_start", {"surprise": 1}),
        ("review_start", {"cwd": ""}),
        ("review_start", {"lenses": ["risk"]}),  # reason missing
        ("review_start", {"lenses_reason": "x"}),
        ("review_start", {"target": "base-diff"}),
        ("review_start", {"base_ref": "main"}),
        ("review_start", {"target": "base-diff", "base_ref": "main", "projection": "staged"}),
        ("review_answer_consent", {}),
        ("review_answer_consent", {"target_identity": "sha256:abc", "consent": "granted", "consent_binding": f"sha256:{'a' * 64}"}),
        ("review_answer_consent", {"target_identity": f"sha256:{'a' * 64}", "consent": "relay", "consent_binding": f"sha256:{'a' * 64}"}),
        ("review_status", {"acknowledgement": {"lineage_id": "x"}}),
        ("review_run", {"model": "gpt"}),
        ("review_run", {"effort": "high"}),  # effort needs a model
        ("review_run", {"model": "haiku", "effort": "high"}),
        ("review_run", {"timeout_ms": 5}),
        ("review_capture", {"lineage_id": "x"}),
        ("review_capture_group", {"lineage_id": "x", "bindings": []}),
        ("review_capture_group", {"lineage_id": "x", "bindings": ["a", "a"]}),
        ("review_acknowledge_approved", {"lineage_id": "x"}),
        ("review_complete", {"lineage_id": "x", "expected_revision": 5}),
        ("review_inspect", {"limit": 0}),
        ("review_assess", {"escalate": "yes"}),
    ]
    for name, args in bad:
        assert error_code(call(name, args)) == "invalid_input", f"{name} {json.dumps(args)}"
    c = call("review_start", {"target": "everything"})
    assert isinstance(c.body["error"]["errors"], list) and len(c.body["error"]["errors"]) > 0
    assert lineages(f) == []
    assert not os.path.exists(os.path.join(f.common_dir, "odd-plugin")), "nothing was written"


def test_validate_schema_types_bounds_patterns_nesting_unknown_properties():
    schema = {
        "type": "object", "additionalProperties": False, "required": ["a"],
        "properties": {
            "a": {"type": "integer", "minimum": 1, "maximum": 3}, "s": {"type": "string", "pattern": "^x+$", "maxLength": 3},
            "l": {"type": "array", "items": {"type": "string"}, "maxItems": 2}, "c": {"type": "string", "const": "k"},
        },
    }
    assert validate_schema(schema, {"a": 2, "s": "xx", "l": ["q"], "c": "k"}) == []
    assert re.search(r"missing required property a", validate_schema(schema, {})[0])
    assert re.search(r"expected integer", validate_schema(schema, {"a": 1.5})[0])
    assert re.search(r"at most 3", validate_schema(schema, {"a": 4})[0])
    assert len(validate_schema(schema, {"a": 1, "s": "xxxy"})) == 2
    assert re.search(r"\$\.l\[0\]: expected string", validate_schema(schema, {"a": 1, "l": [1]})[0])
    assert re.search(r"unknown property z", validate_schema(schema, {"a": 1, "z": 1})[0])
    assert re.search(r'must be "k"', validate_schema(schema, {"a": 1, "c": "z"})[0])
    assert re.search(r"expected object, got array", validate_schema(schema, [])[0])
    assert len(validate_schema({"type": "array", "items": {"type": "integer"}}, ["x"] * 50)) <= 10


def test_validate_schema_js_edges_integral_double_bool_is_not_a_number_final_newline_and_utf16_length():
    assert validate_schema({"type": "integer"}, 3.0) == [], "Number.isInteger(3.0)"
    assert validate_schema({"type": "integer"}, True) == ["$: expected integer, got boolean"]
    assert validate_schema({"type": "integer"}, 1e400) != [], "Infinity is not an integer"
    assert validate_schema({"type": "string", "pattern": "^a$"}, "a\n") == ["$: must match ^a$"], "`$` is the very end, as in JS"
    assert validate_schema({"type": "string", "maxLength": 1}, "\U0001F600") == ["$: must have at most 1 characters"], "astral = 2 UTF-16 units"
    assert validate_schema({"type": "array", "uniqueItems": True}, [1, "1", True]) == []
    assert validate_schema({"type": "array", "uniqueItems": True}, [{"a": 1}, {"a": 1}]) == ["$: items must be unique"]
    assert validate_schema({"enum": ["a"]}, True) == ['$: must be one of "a"']


# ---- stdio framing through real pipes ----


def feed(w, chunks, end=True):
    def run():
        try:
            for c in chunks:
                w.write(c)
                w.flush()
            if end:
                w.close()
        except OSError:
            pass

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


def test_serve_newline_delimited_framing_parse_errors_oversize_lines_ordering_of_replies_per_request(tmp_path):
    r, w = os.pipe()
    reader, writer = os.fdopen(r, "rb", buffering=0), os.fdopen(w, "wb")
    out = io.BytesIO()
    t = feed(writer, [
        b'{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0",',
        b'"id":2,"method":"tools/list"}\r\nnot json\n\n',
        b"x" * (MAX_LINE_BYTES + 10) + b"\n",
        b'{"jsonrpc":"2.0","id":3,"method":"ping"}\n',
        b'{"jsonrpc":"2.0","id":4,"method":"ping"}',
    ])
    serve(reader, out, {"cwd": str(tmp_path)})
    t.join()
    reader.close()
    lines = [json.loads(x) for x in out.getvalue().decode().split("\n") if x != ""]
    by_id = {l["id"]: l for l in lines if l["id"] is not None}
    assert sorted(by_id) == [1, 2, 3, 4]
    assert len(by_id[2]["result"]["tools"]) == len(REVIEW_TOOL_NAMES)
    assert sorted(l["error"]["code"] for l in lines if l["id"] is None) == sorted([-32700, -32600])
    assert all(l["jsonrpc"] == "2.0" for l in lines)


def test_serve_an_unterminated_oversize_line_is_answered_once_and_dropped_up_to_the_next_newline(tmp_path):
    out = io.BytesIO()
    serve(io.BytesIO(b'{"jsonrpc":"2.0","id":1,"method":"ping"}\n' + b"y" * (MAX_LINE_BYTES + 5) + b'\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n'), out)
    lines = [json.loads(x) for x in out.getvalue().splitlines()]
    assert sorted(l["id"] for l in lines if l["id"] is not None) == [1, 2]
    assert [l["error"]["code"] for l in lines if l["id"] is None] == [-32600]
    assert [l["error"]["message"] for l in lines if l["id"] is None] == ["message too large"]


def test_serve_replies_keep_non_ascii_text_as_utf8_and_split_multibyte_chunks(tmp_path):
    msg = ('{"jsonrpc":"2.0","id":"é😀","method":"ping"}\n').encode()
    cut = msg.index("😀".encode()) + 2  # inside the 4-byte sequence
    out = io.BytesIO()
    r, w = os.pipe()
    reader, writer = os.fdopen(r, "rb", buffering=0), os.fdopen(w, "wb")
    t = feed(writer, [msg[:cut], msg[cut:]])
    serve(reader, out)
    t.join()
    reader.close()
    assert json.loads(out.getvalue()) == {"jsonrpc": "2.0", "id": "é😀", "result": {}}
    assert "é😀".encode() in out.getvalue()


# ---- review_assess / review_inspect / review_status (read-only) ----


def test_review_assess_classifies_a_change_bounds_the_paths_writes_nothing_a_clean_tree_is_not_due(make_fx):
    f = make_fx()
    call = make_server(f)
    a = good(call("review_assess"))
    assert a["outcome"] == "assessed"
    assert re.match(r"^sha256:[0-9a-f]{64}$", a["target_identity"])
    assert a["risk_level"] in ("low", "medium", "high")
    assert a["changed_paths"] == ["a.txt"]
    assert a["changed_paths_truncated"] is False
    assert not os.path.exists(os.path.join(f.common_dir, "odd-plugin")), "no review state written"
    staged = good(call("review_assess", {"projection": "staged"}))
    assert staged["outcome"] == "not_due"
    clean = make_server(make_fx(dirty=False))
    assert good(clean("review_assess"))["outcome"] == "not_due"


def test_review_assess_a_target_that_cannot_be_frozen_is_a_typed_snapshot_error(make_fx):
    f = make_fx()
    call = make_server(f)
    assert error_code(call("review_assess", {"target": "base-diff", "base_ref": "no-such-ref", "committed_only": True})) == "snapshot_error"
    assert error_code(call("review_assess", {"cwd": f.dir})) == "snapshot_error"


def test_review_inspect_lists_lineages_and_the_rdd_mode_an_unreadable_lineage_is_reported(make_fx):
    f = make_fx()
    call = make_server(f, "low")
    empty = good(call("review_inspect"))
    assert empty["lineages"] == []
    assert empty["rdd_mode"]["effective"] == "off", "RDD is off by default"
    assert empty["truncated"] is False
    started = good(call("review_start"))
    one = good(call("review_inspect"))
    assert len(one["lineages"]) == 1
    assert one["lineages"][0]["lineage_id"] == started["lineage_id"]
    assert one["lineages"][0]["state"] == "approved"
    assert one["lineages"][0]["burned"] is False
    Path(f.common_dir, "odd-plugin", "review-transactions", "v2", started["lineage_id"], "review-state.json").write_text("garbage")
    broken = good(call("review_inspect"))
    assert broken["lineages"] == []
    assert len(broken["unreadable"]) == 1
    assert broken["unreadable"][0]["lineage_id"] == started["lineage_id"]


def test_review_inspect_limit_is_coerced_from_a_string_and_an_integral_double_and_truncates(make_fx):
    f = make_fx()
    call = make_server(f, "low")
    good(call("review_start"))
    assert good(call("review_inspect", {"limit": "1"}))["truncated"] is False
    assert good(call("review_inspect", {"limit": 1.0}))["lineages"] != []
    assert error_code(call("review_inspect", {"limit": 1.5})) == "invalid_input"
    assert error_code(call("review_inspect", {"limit": "1.5"})) == "invalid_input"


def test_review_status_follows_status_a_fresh_candidate_offers_review_start_its_command_names_a_registered_tool(make_fx):
    f = make_fx()
    call = make_server(f)
    s = good(call("review_status"))
    assert s["next_transition"]["kind"] == "execute"
    assert s["next_transition"]["execute"]["operation"] == "review.start"
    assert s["next_transition"]["execute"]["command"] == "review_start"
    assert s["next_transition"]["execute"]["command"] in REVIEW_TOOL_NAMES
    assert lineages(f) == []


# ---- review_start / review_answer_consent: consent is never answered by the server ----


def test_review_start_always_relays_medium_risk_returns_the_untouched_consent_envelope_and_creates_nothing(make_fx):
    f = make_fx()
    call = make_server(f, "medium")
    env = good(call("review_start"))
    assert env["action"] == "consent_required"
    assert env["contract"] == REVIEW_CONTRACT
    assert len(env["choices"]) == 2
    for c in env["choices"]:
        assert c["invocation"].startswith("review_answer_consent --contract "), c["invocation"]
    assert env["off_path"]["command"] == off_path_command()
    assert lineages(f) == []
    assert read_decline(f.common_dir, env["target_identity"]) is None
    # the same through the run loop: it returns the envelope, never answers it
    run = good(call("review_run"))
    assert run["outcome"] == "consent-required"
    assert run["envelope"] == env
    assert lineages(f) == []
    assert read_decline(f.common_dir, env["target_identity"]) is None


def test_review_start_low_risk_is_approved_at_once_with_its_one_shot_acknowledgement_a_repeat_is_replayed_never_duplicated(make_fx):
    f = make_fx()
    call = make_server(f, "low")
    r = good(call("review_start"))
    assert r["action"] == "closed"
    assert r["state"] == "approved"
    assert r["risk_level"] == "low"
    assert r["acknowledgement"]["lineage_id"] == r["lineage_id"]
    assert isinstance(r["acknowledgement"]["token"], str)
    again = good(call("review_start"))
    assert again["action"] == "replayed"
    assert again["lineage_id"] == r["lineage_id"]
    assert len(lineages(f)) == 1


def test_review_start_refusals_are_typed_explicit_lenses_on_a_low_risk_review_clean_tree_is_not_due(make_fx):
    f = make_fx()
    call = make_server(f, "low")
    assert error_code(call("review_start", {"lenses": ["risk"], "lenses_reason": "touched shell"})) == "invalid_lenses"
    assert lineages(f) == []
    clean = make_server(make_fx(dirty=False), "high")
    assert good(clean("review_start"))["outcome"] == "not_due"


def test_review_answer_consent_the_humans_explicit_grant_starts_the_review_only_for_the_exact_candidate_asked(make_fx):
    f = make_fx()
    call = make_server(f, "medium")
    env = good(call("review_start"))
    Z = f"sha256:{'0' * 64}"  # a moved candidate: nothing is recorded
    moved = call("review_answer_consent", {**choice_args(env, "granted"), "target_identity": Z, "consent_binding": consent_binding(Z)})
    assert error_code(moved) == "binding_drift"
    assert lineages(f) == []
    declined_wrong = call("review_answer_consent", {**choice_args(env, "declined"), "target_identity": Z, "consent_binding": consent_binding(Z)})
    assert error_code(declined_wrong) == "binding_drift"
    assert read_decline(f.common_dir, env["target_identity"]) is None
    ok = good(call("review_answer_consent", choice_args(env, "granted")))
    assert ok["action"] == "created"
    assert ok["state"] == "reviewing"
    assert ok["target_identity"] == env["target_identity"]
    assert len(lineages(f)) == 1


def test_review_answer_consent_declined_records_a_candidate_scoped_decline_and_creates_no_lineage(make_fx):
    f = make_fx()
    call = make_server(f, "medium")
    env = good(call("review_start"))
    d = good(call("review_answer_consent", choice_args(env, "declined")))
    assert d["outcome"] == "declined"
    assert d["reason_code"] == "consent_declined"
    assert read_decline(f.common_dir, env["target_identity"])
    assert lineages(f) == []


def test_consent_is_never_answered_without_the_humans_explicit_input_omitted_relay_answers_are_refused_and_nothing_changes(make_fx):
    f = make_fx()
    call = make_server(f, "medium")
    env = good(call("review_start"))
    before = json.dumps(list_lineages(f.common_dir))
    B = choice_args(env, "granted")["consent_binding"]
    for args in [
        {"target_identity": env["target_identity"], "consent_binding": B},
        {"consent": "granted", "consent_binding": B},
        {"target_identity": env["target_identity"], "consent": "granted"},
        {"target_identity": env["target_identity"], "consent": "relay", "consent_binding": B},
        {"target_identity": env["target_identity"], "consent": True, "consent_binding": B},
        {"target_identity": env["target_identity"], "consent": "", "consent_binding": B},
    ]:
        assert error_code(call("review_answer_consent", args)) == "invalid_input", json.dumps(args)
    for name in ["review_start", "review_run", "review_status", "review_assess", "review_inspect"]:
        call(name)
    assert json.dumps(list_lineages(f.common_dir)) == before
    assert read_decline(f.common_dir, env["target_identity"]) is None
    assert not os.path.exists(os.path.join(f.common_dir, "odd-plugin", "declines"))


# ---- review_run / capture / acknowledge ----


def consented(call):
    env = good(call("review_start"))
    return good(call("review_answer_consent", choice_args(env, "granted")))["lineage_id"]


def test_review_run_acknowledged_without_the_forecast_binding_is_refused_with_it_the_review_closes_and_the_receipt_exists(make_fx):
    f = make_fx()
    calls, runner = fake_runner()
    call = make_server(f, "medium", runner)
    lineage = consented(call)
    fc = good(call("review_run", {"lineage_id": lineage}))
    assert error_code(call("review_run", {"lineage_id": lineage, "reviewer_run_acknowledged": True})) == "invalid_input"
    assert error_code(call("review_run", {"lineage_id": lineage, "reviewer_run_acknowledged": True, "reviewer_run_binding": "nope"})) == "binding_drift"
    assert len(calls.prompts) == 0, "no reviewer ran on a missing or wrong binding"
    done = good(call("review_run", {"lineage_id": lineage, "reviewer_run_acknowledged": True, "reviewer_run_binding": fc["reviewer_run_binding"]}))
    assert done["outcome"] == "closed"
    assert len(calls.prompts) == 1
    assert done["acknowledgement"]["outcome"] == "acknowledged"
    assert read_state(f.common_dir, lineage)["burned"] is True


def test_review_run_an_unknown_lineage_and_a_candidate_that_moved_are_typed(make_fx):
    f = make_fx()
    calls, runner = fake_runner()
    call = make_server(f, "medium", runner)
    assert error_code(call("review_run", {"lineage_id": "review-0123456789abcdef"})) == "unknown_lineage"
    lineage = consented(call)
    f.write("a.txt", "completely\ndifferent\n")
    assert error_code(call("review_run", {"lineage_id": lineage})) == "binding_drift"


def test_review_capture_and_review_acknowledge_approved_one_slot_forecast_acknowledged_capture_returns_the_token_explicit_acknowledge_burns_once(make_fx):
    f = make_fx()
    calls, runner = fake_runner()
    call = make_server(f, "medium", runner)
    lineage = consented(call)
    st = good(call("review_status"))
    assert st["next_transition"]["kind"] == "collect"
    binding = binding_values(st["next_transition"]["collect"]["inputs"])[0]
    assert error_code(call("review_capture", {"lineage_id": lineage, "binding": binding + "x"})) == "binding_mismatch"  # wrong binding: nothing runs
    fc = good(call("review_capture", {"lineage_id": lineage, "binding": binding}))
    assert fc["outcome"] == "forecast"
    assert len(calls.prompts) == 0
    cap = good(call("review_capture", {"lineage_id": lineage, "binding": binding, "reviewer_run_acknowledged": True, "reviewer_run_binding": fc["reviewer_run_binding"]}))
    assert cap["outcome"] == "captured"
    assert cap["capture"]["outcome"] == "captured"
    assert cap["capture"]["next"] == "approved"
    assert len(calls.prompts) == 1
    rec = read_state(f.common_dir, lineage)
    assert rec["state"] == "approved"
    assert rec["burned"] is False, "capture never acknowledges"
    ack = cap["capture"]["acknowledgement"]
    wrong = call("review_acknowledge_approved", {"lineage_id": lineage, "target_identity": ack["target_identity"], "expected_revision": ack["expected_revision"], "token": "wrong-token"})
    assert error_code(wrong) == "wrong_token"
    assert read_state(f.common_dir, lineage)["burned"] is False
    done = good(call("review_acknowledge_approved", ack))
    assert done["outcome"] == "acknowledged"
    assert done["burned"] is True
    assert os.path.exists(os.path.join(f.common_dir, "odd-plugin", "review-transactions", "v2", lineage, "receipt.json")) or done["receipt"]["lineage_id"] == lineage
    assert call("review_acknowledge_approved", ack).is_error is True, "a token is one-shot"


def test_review_capture_vs_review_capture_group_a_multi_slot_collect_needs_the_whole_ordered_group_partial_reordered_and_stale_bindings_run_nothing(make_fx):
    f = make_fx()
    calls, runner = fake_runner()
    call = make_server(f, "high", runner)
    lineage = consented(call)
    st = good(call("review_status"))
    bindings = binding_values(st["next_transition"]["collect"]["inputs"])
    assert len(bindings) == 4
    assert error_code(call("review_capture", {"lineage_id": lineage, "binding": bindings[0]})) == "group_required"
    assert error_code(call("review_capture_group", {"lineage_id": lineage, "bindings": bindings[:2]})) == "binding_mismatch"
    assert error_code(call("review_capture_group", {"lineage_id": lineage, "bindings": list(reversed(bindings))})) == "binding_mismatch"
    fc = good(call("review_capture_group", {"lineage_id": lineage, "bindings": bindings}))
    assert fc["outcome"] == "forecast"
    assert len(fc["reviewers"]) == 4
    assert len(calls.prompts) == 0
    cap = good(call("review_capture_group", {"lineage_id": lineage, "bindings": bindings, "reviewer_run_acknowledged": True, "reviewer_run_binding": fc["reviewer_run_binding"]}))
    assert cap["outcome"] == "captured"
    assert cap["capture"]["next"] == "approved"
    assert len(calls.prompts) == 4
    assert error_code(call("review_capture_group", {"lineage_id": lineage, "bindings": bindings})) == "no_collect_pending"  # nothing pending any more


def test_review_capture_an_unknown_lineage_is_typed_review_complete_refuses_a_lineage_that_is_not_reviewing(make_fx):
    f = make_fx()
    calls, runner = fake_runner()
    call = make_server(f, "low", runner)
    assert error_code(call("review_capture", {"lineage_id": "review-0123456789abcdef", "binding": "x"})) == "unknown_lineage"
    started = good(call("review_start"))
    c = call("review_complete", {"lineage_id": started["lineage_id"], "expected_revision": started["acknowledgement"]["expected_revision"]})
    assert error_code(c) == "illegal_state"
    stale = call("review_complete", {"lineage_id": started["lineage_id"], "expected_revision": "stale"})
    assert stale.is_error is True


# ---- duplicate-lineage guard ----


def to_correction(f):
    """A high-risk review whose only lens finds a severe issue: the lineage ends in correction_required."""
    calls, runner = fake_runner(findings={"risk": [SEVERE]})
    call = make_server(f, "high", runner)
    lineage = consented(call)
    st = good(call("review_status"))
    bindings = binding_values(st["next_transition"]["collect"]["inputs"])
    fc = good(call("review_capture_group", {"lineage_id": lineage, "bindings": bindings}))
    good(call("review_capture_group", {"lineage_id": lineage, "bindings": bindings, "reviewer_run_acknowledged": True, "reviewer_run_binding": fc["reviewer_run_binding"]}))
    rec = read_state(f.common_dir, lineage)
    for _ in range(3):
        if rec["state"] != "reviewing":
            break
        s = good(call("review_status"))
        t = s["next_transition"]
        if t["kind"] == "execute" and t["execute"]["operation"] == "review.validate":
            assert t["execute"]["command"] == "review_complete"
            good(call("review_complete", lit(t["execute"]["arguments"])))
        else:
            b = binding_values(t["collect"]["inputs"])
            f2 = good(call("review_capture_group", {"lineage_id": lineage, "bindings": b}))
            good(call("review_capture_group", {"lineage_id": lineage, "bindings": b, "reviewer_run_acknowledged": True, "reviewer_run_binding": f2["reviewer_run_binding"]}))
        rec = read_state(f.common_dir, lineage)
    assert rec["state"] == "correction_required", f"reached {rec['state']}"
    return call, lineage, calls


def test_duplicate_lineage_guard_a_direct_review_start_and_review_answer_consent_while_the_lineage_waits_for_its_correction_returns_the_pending_lineage(make_fx):
    f = make_fx()
    call, lineage, _ = to_correction(f)
    f.write("a.txt", "one\nTWO\nthree\nfour\nfive\nsix\n")  # the human corrects the code: another identity than the lineage's target
    before = lineages(f)
    assert len(before) == 1
    pending = call("review_start")
    assert error_code(pending) == "correction_lineage_pending"
    assert pending.body["error"]["lineage"]["lineage_id"] == lineage
    assert pending.body["error"]["lineage"]["state"] == "correction_required"
    assert re.search(r"review_run", pending.body["error"]["message"])
    I1 = f"sha256:{'1' * 64}"
    consent = call("review_answer_consent", {"target_identity": I1, "consent": "granted", "consent_binding": consent_binding(I1)})
    assert error_code(consent) == "correction_lineage_pending"
    assert consent.body["error"]["lineage"]["lineage_id"] == lineage
    declined = call("review_answer_consent", {"target_identity": I1, "consent": "declined", "consent_binding": consent_binding(I1)})
    assert error_code(declined) == "correction_lineage_pending"
    assert lineages(f) == before, "no second lineage"
    assert not os.path.exists(os.path.join(f.common_dir, "odd-plugin", "declines"))
    p = pending_correction_lineage(f.repo, snapshot_target_of({"target": {"kind": "current-changes"}}))
    assert p and "rec" in p and p["rec"]["lineage_id"] == lineage
    run = good(call("review_run", {"lineage_id": lineage}))
    assert run["lineage_id"] == lineage


def test_review_capture_on_the_correction_path_the_validator_binding_comes_from_the_run_forecast_capture_stops_after_the_batch_with_the_acknowledgement(make_fx):
    f = make_fx()
    call, lineage, calls = to_correction(f)
    plan = good(call("review_run", {"lineage_id": lineage}))
    assert plan["outcome"] == "input-required"
    f.write("a.txt", "one\nTWO\nthree\nfour\nfive\nsix\n")
    fc = good(call("review_run", {"lineage_id": lineage}))
    assert fc["outcome"] == "forecast"
    assert [r["role"] for r in fc["reviewers"]] == ["validator"]
    binding = fc["reviewers"][0]["binding"]
    assert error_code(call("review_capture", {"lineage_id": lineage, "binding": "garbage"})) == "binding_mismatch"
    before = len(calls.prompts)
    cap = good(call("review_capture", {"lineage_id": lineage, "binding": binding, "reviewer_run_acknowledged": True, "reviewer_run_binding": fc["reviewer_run_binding"]}))
    assert cap["outcome"] == "captured"
    assert cap["capture"]["next"] == "approved"
    assert len(calls.prompts) == before + 1
    assert read_state(f.common_dir, lineage)["burned"] is False, "capture does not acknowledge"
    done = good(call("review_acknowledge_approved", cap["capture"]["acknowledgement"]))
    assert done["outcome"] == "acknowledged"


def test_duplicate_lineage_guard_an_unreadable_correction_lineage_blocks_a_direct_start_fails_closed_and_nothing_is_created(make_fx):
    f = make_fx()
    call, lineage, _ = to_correction(f)
    f.write("a.txt", "one\nTWO\nthree\nfour\nfive\nsix\n")
    state_path = Path(f.common_dir, "odd-plugin", "review-transactions", "v2", lineage, "review-state.json")
    raw = json.loads(state_path.read_text())
    raw["revision"] = "sha256:tampered"
    state_path.write_text(json.dumps(raw))
    c = call("review_start")
    assert error_code(c) == "authority_error"
    assert c.body["error"]["lineage_id"] == lineage
    assert len(lineages(f)) == 1


def test_without_a_pending_correction_a_direct_start_is_unaffected_by_the_guard(make_fx):
    f = make_fx()
    call = make_server(f, "medium")
    assert good(call("review_start"))["action"] == "consent_required"
    assert pending_correction_lineage(f.repo, snapshot_target_of({"target": {"kind": "current-changes"}})) is None


# ---- every invocation string names something that exists ----


def test_every_invocation_the_plugin_hands_out_names_a_registered_tool_or_an_existing_dist_cli_file(make_fx):
    tools = {t.name for t in TOOLS}

    def cli_exists(text):
        for n in re.findall(r"dist[\\/]cli[\\/]([\w-]+\.js)", text):
            assert (PLUGIN_ROOT / "dist" / "cli" / n).exists(), f"dist/cli/{n} exists"

    f = make_fx()
    call = make_server(f, "medium")
    env = good(call("review_start"))
    for c in env["choices"]:
        tool = c["invocation"].split(" ")[0]
        assert tool in tools, f"{tool} is registered"
        props = list(next(t for t in TOOLS if t.name == tool).input_schema.get("properties", {}))
        for flag in re.finditer(r" --([a-z-]+)", c["invocation"]):
            assert flag.group(1).replace("-", "_") in props, f"{tool} accepts --{flag.group(1)}"
    assert env["off_path"]["command"].startswith("node ")
    cli_exists(env["off_path"]["command"])
    cli_exists(env["off_path"]["note"])
    assert "<plugin>" not in json.dumps(env)
    # the commands of every status transition
    g = make_fx()
    calls, runner = fake_runner()
    call2 = make_server(g, "low", runner)
    start_cmd = good(call2("review_status"))["next_transition"]["execute"]["command"]
    assert start_cmd in tools
    s = good(call2("review_start"))
    ack_cmd = good(call2("review_status", {"acknowledgement": s["acknowledgement"]}))["next_transition"]
    assert ack_cmd["execute"]["operation"] == "review.acknowledge-approved"
    assert ack_cmd["execute"]["command"] in tools
    for t in REVIEW_TOOL_NAMES:
        assert t in tools


# ---- S1: the contract texts an agent follows are accepted literally ----


def literal(call, command, args):
    """Calls the tool a transition names with its arguments exactly as given; the tool must exist and the arguments must validate."""
    tool = TOOL_BY_NAME.get(command)
    assert tool, f"{command} is a registered tool"
    given = lit(args)
    assert validate_schema(tool.input_schema, coerce_arguments(tool.input_schema, given)) == [], f"{command} {json.dumps(given)}"
    return call(command, given)


def test_b1_m1_s1_status_transitions_taken_literally_are_accepted_by_the_named_tool(make_fx):
    # low risk: start, then the acknowledgement transition
    f = make_fx()
    call = make_server(f, "low")
    t = good(call("review_status"))["next_transition"]
    assert t["execute"]["command"] == "review_start"
    started = good(literal(call, t["execute"]["command"], t["execute"]["arguments"]))
    assert started["action"] == "closed"
    ack = good(call("review_status", {"acknowledgement": started["acknowledgement"]}))["next_transition"]
    assert ack["execute"]["command"] == "review_acknowledge_approved"
    assert good(literal(call, ack["execute"]["command"], ack["execute"]["arguments"]))["outcome"] == "acknowledged"
    # medium: the offered start relays; then one reviewer slot through the collect's own command, and per input
    f = make_fx()
    calls, runner = fake_runner()
    call = make_server(f, "medium", runner)
    t = good(call("review_status"))["next_transition"]
    env = good(literal(call, t["execute"]["command"], t["execute"]["arguments"]))
    assert env["action"] == "consent_required"
    good(call("review_answer_consent", choice_args(env, "granted")))
    c = good(call("review_status"))["next_transition"]
    assert c["kind"] == "collect"
    assert c["collect"]["command"] == "review_capture"
    assert len(c["collect"]["inputs"]) == 1
    assert c["collect"]["inputs"][0]["command"] == "review_capture"
    assert good(literal(call, c["collect"]["command"], c["collect"]["arguments"]))["outcome"] == "forecast"
    assert good(literal(call, c["collect"]["inputs"][0]["command"], c["collect"]["inputs"][0]["arguments"]))["outcome"] == "forecast"
    assert len(calls.prompts) == 0
    # high: a group through review_capture_group with the bindings array; one slot of a group is a typed refusal
    f = make_fx()
    calls, runner = fake_runner()
    call = make_server(f, "high", runner)
    consented(call)
    c = good(call("review_status"))["next_transition"]
    assert c["collect"]["command"] == "review_capture_group"
    assert len(c["collect"]["inputs"]) == 4
    assert good(literal(call, c["collect"]["command"], c["collect"]["arguments"]))["outcome"] == "forecast"
    assert error_code(literal(call, c["collect"]["inputs"][0]["command"], c["collect"]["inputs"][0]["arguments"])) == "group_required"
    # a committed range (the gate's path): the start status offers for base-diff carries base_ref and committed_only
    f = make_fx()
    git(f.repo, "checkout", "-q", "-b", "feat")
    git(f.repo, "commit", "-q", "-am", "work")
    call = make_server(f, "medium")
    t = good(call("review_status", {"target": "base-diff", "base_ref": "main", "committed_only": True}))["next_transition"]
    assert any(a["name"] == "committed_only" and a["value"] == "true" for a in t["execute"]["arguments"])
    assert good(literal(call, t["execute"]["command"], t["execute"]["arguments"]))["action"] == "consent_required"
    # the correction and validator steps go through review_run; review_complete is literal inside to_correction
    f = make_fx()
    call, lineage, _ = to_correction(f)
    c = good(call("review_status"))["next_transition"]
    assert c["reason_code"] == "correction_required"
    assert c["collect"]["command"] == "review_run"
    run = good(literal(call, c["collect"]["command"], c["collect"]["arguments"]))
    assert run["outcome"] == "input-required"
    assert run["lineage_id"] == lineage


@pytest.mark.parametrize("answer", ["granted", "declined"])
@pytest.mark.parametrize("case", [
    {"name": "current-changes", "level": "high", "start": {}},
    {"name": "staged lens subset with a quoted reason", "level": "high", "start": {"lenses": ["risk", "reliability"], "lenses_reason": "it's a retry loop"}, "lenses": ["risk", "reliability"]},
    {"name": "medium single lens", "level": "medium", "start": {"lenses": ["reliability"], "lenses_reason": "touched retries"}, "lenses": ["reliability"]},
    {"name": "base-diff committed-only", "level": "medium", "start": {"target": "base-diff", "base_ref": "main", "committed_only": True}, "committed": True},
], ids=lambda c: c["name"] if isinstance(c, dict) else c)
def test_b2_m1_s1_every_consent_choice_incl_base_diff_and_lenses_is_accepted_literally_declined_works_too(make_fx, case, answer):
    f = make_fx()
    if case.get("committed"):
        git(f.repo, "checkout", "-q", "-b", "feat")
        git(f.repo, "commit", "-q", "-am", "work")
    call = make_server(f, case["level"])
    env = good(call("review_start", case["start"]))
    inv = next(x for x in env["choices"] if x["answer"] == answer)["invocation"]
    if case.get("committed"):
        assert "--projection" not in inv, "a base-diff candidate has no projection"
        assert "--committed-only true" in inv
    else:
        assert "--projection workspace" in inv
    args = choice_args(env, answer)
    tool = TOOL_BY_NAME["review_answer_consent"]
    assert validate_schema(tool.input_schema, coerce_arguments(tool.input_schema, args)) == [], f"{case['name']}: {inv}"
    r = good(call("review_answer_consent", args))
    if answer == "granted":
        assert r["state"] == "reviewing", case["name"]
        if case.get("lenses"):
            assert r["selected_lenses"] == [f"review-{l}" for l in case["lenses"]], case["name"]
        assert len(lineages(f)) == 1
    else:
        assert r["outcome"] == "declined", case["name"]
        assert lineages(f) == []


def test_advisory_an_answer_for_another_lens_selection_than_the_envelopes_is_refused_and_nothing_is_recorded(make_fx):
    f = make_fx()
    call = make_server(f, "high")
    env = good(call("review_start", {"lenses": ["risk"], "lenses_reason": "only risk"}))
    args = choice_args(env, "granted")
    for bad in [{**args, "lenses": "risk,reliability"}, {**args, "lenses": "resilience"}, {**args, "lenses_reason": "different"}]:
        assert error_code(call("review_answer_consent", bad)) == "binding_drift"
    no_lenses = {k: v for k, v in args.items() if k not in ("lenses", "lenses_reason")}
    assert error_code(call("review_answer_consent", no_lenses)) == "binding_drift"
    assert lineages(f) == []
    assert len(good(call("review_answer_consent", args))["selected_lenses"]) == 1


# ---- concurrency: in-flight ids and cancellation, observed through a probe tool that waits on the request's abort signal ----


@pytest.fixture
def probe(monkeypatch):
    """A `review_probe` tool that blocks until its request's signal is aborted (text `aborted`) or 5 s pass (`timeout`)."""
    started: list = []

    def run(args, ctx):
        started.append(ctx)
        end = time.time() + 5
        while time.time() < end:
            if ctx.signal is not None and ctx.signal.aborted:
                return {"content": [{"type": "text", "text": "aborted"}]}
            time.sleep(0.005)
        return {"content": [{"type": "text", "text": "timeout"}]}

    tool = ToolDefinition("review_probe", "test probe", {"type": "object", "properties": {}, "required": [], "additionalProperties": False}, {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}, run)
    monkeypatch.setitem(TOOL_BY_NAME, "review_probe", tool)
    return started


def run_in_thread(job):
    box = {}
    t = threading.Thread(target=lambda: box.setdefault("r", job()), daemon=True)
    t.start()
    return t, box


def call_msg(id, name="review_probe", args=None):
    return {"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": name, "arguments": {} if args is None else args}}


def text_of(r):
    return r["result"]["content"][0]["text"]


def wait_for(cond, seconds=3.0):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.005)
    return False


def test_advisory_a_duplicate_in_flight_json_rpc_id_is_rejected_the_first_call_is_unaffected(make_fx, probe):
    server = ReviewServer()
    job = server.begin(call_msg(7))
    assert callable(job)
    t, box = run_in_thread(job)
    assert wait_for(lambda: len(probe) == 1)
    second = server.handle(call_msg(7))
    assert second["error"]["code"] == -32600
    assert re.search(r"already in flight", second["error"]["message"])
    assert server.handle({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 7}}) is None
    t.join(5)
    assert "error" not in box["r"] and text_of(box["r"]) == "aborted"
    # once settled the id may be reused
    job2 = server.begin(call_msg(7))
    t2, box2 = run_in_thread(job2)
    assert wait_for(lambda: len(probe) == 2)
    server.handle({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 7}})
    t2.join(5)
    assert "error" not in box2["r"]


def test_s1_a2_numeric_and_string_ids_are_distinct_in_flight_requests(probe):
    server = ReviewServer()
    ja, jb = server.begin(call_msg(6)), server.begin(call_msg("6"))  # both registered before either settles
    assert callable(ja) and callable(jb)
    dup, dup_str = server.begin(call_msg(6)), server.begin(call_msg("6"))
    assert dup["error"]["code"] == -32600, "the same id of the same type is still a duplicate"
    assert dup_str["error"]["code"] == -32600
    (ta, a), (tb, b) = run_in_thread(ja), run_in_thread(jb)
    assert wait_for(lambda: len(probe) == 2)
    for rid in (6, "6"):
        server.handle({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": rid}})
    ta.join(5), tb.join(5)
    assert "error" not in a["r"] and "error" not in b["r"]
    assert a["r"]["id"] == 6 and b["r"]["id"] == "6"


def test_s1_a2_notifications_cancelled_aborts_only_the_request_with_the_same_id_type(probe):
    server = ReviewServer()
    jn, js = server.begin(call_msg(6)), server.begin(call_msg("6"))
    (tn, numeric), (ts, string) = run_in_thread(jn), run_in_thread(js)
    assert wait_for(lambda: len(probe) == 2)

    def state(box, t):
        t.join(0.15)
        return "pending" if "r" not in box else text_of(box["r"])

    cancel = lambda rid: server.handle({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": rid}})  # noqa: E731
    assert cancel("6") is None, "a notification gets no reply"
    assert state(string, ts) == "aborted", 'cancelling "6" reaches the string id'
    assert state(numeric, tn) == "pending", "and not the numeric id 6"
    cancel("7")
    assert state(numeric, tn) == "pending", "an unknown id cancels nothing"
    cancel(6)
    assert state(numeric, tn) == "aborted", "cancelling 6 reaches the numeric id"
    assert "review_probe" in TOOL_BY_NAME


def test_serve_calls_overlap_a_cancel_arriving_while_a_call_runs_is_applied_and_the_call_still_answers(probe, tmp_path):
    r, w = os.pipe()
    reader, writer = os.fdopen(r, "rb", buffering=0), os.fdopen(w, "wb")
    out = io.BytesIO()
    done = threading.Thread(target=lambda: serve(reader, out, {"cwd": str(tmp_path)}), daemon=True)
    done.start()
    writer.write((json.dumps(call_msg(1)) + "\n").encode())
    writer.flush()
    assert wait_for(lambda: len(probe) == 1)
    writer.write((json.dumps({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1}}) + "\n" + json.dumps({"jsonrpc": "2.0", "id": 2, "method": "ping"}) + "\n").encode())
    writer.flush()
    writer.close()
    done.join(10)
    assert not done.is_alive()
    reader.close()
    lines = {json.loads(l)["id"]: json.loads(l) for l in out.getvalue().splitlines()}
    assert text_of(lines[1]) == "aborted"
    assert lines[2]["result"] == {}


def test_s1_a1_a_proto_argument_is_an_unknown_property_never_a_schema_bypass(make_fx):
    f = make_fx()
    server = ReviewServer({"deps": {"riskAssessor": assess("low"), "modeOptions": ModeOptions(data_dir=f.data)}, "cwd": f.repo})
    ids = [0]

    def send(name, args_json):
        ids[0] += 1
        msg = json.loads(f'{{"jsonrpc":"2.0","id":{ids[0]},"method":"tools/call","params":{{"name":{json.dumps(name)},"arguments":{args_json}}}}}')
        res = server.handle(msg)
        assert "error" not in res
        return res["result"].get("isError"), res["result"]["content"][0]["text"]

    for name, args in [
        ("review_inspect", '{"__proto__":{"limit":0}}'),
        ("review_status", '{"__proto__":{"projection":"staged"}}'),
        ("review_status", '{"constructor":{"x":1}}'),
        ("review_inspect", '{"prototype":1}'),
        ("review_inspect", '{"limit":"3","__proto__":{"limit":0}}'),
    ]:
        is_error, text = send(name, args)
        assert is_error is True, f"{name} {args}: {text}"
        body = json.loads(text)
        assert body["error"]["code"] == "invalid_input", f"{name} {args}"
        assert re.search(r"unknown property (__proto__|constructor|prototype)", json.dumps(body["error"]["errors"])), f"{name} {args}"
    # the polluted value never reached the tool: nothing was written, and a clean call still works
    assert not os.path.exists(os.path.join(f.common_dir, "odd-plugin"))
    assert len(json.loads(send("review_inspect", '{"limit":"3"}')[1])["lineages"]) == 0


def test_s1_t1_coercion_only_applies_to_the_declared_type_string_properties_keep_their_text(make_fx):
    ack = TOOL_BY_NAME["review_acknowledge_approved"].input_schema
    given = {"lineage_id": "[1]", "target_identity": f"sha256:{'a' * 64}", "expected_revision": "12345", "token": "true"}
    assert dict(coerce_arguments(ack, given)) == given, "string properties are untouched"
    run = TOOL_BY_NAME["review_run"].input_schema
    same = {"lenses_reason": "true", "timeout_ms": "1e3", "reviewer_run_acknowledged": "TRUE", "reviewer_run_binding": "12"}
    assert dict(coerce_arguments(run, same)) == same
    # declared types still coerce (the other side of the rule)
    assert dict(coerce_arguments(run, {"timeout_ms": "5000", "reviewer_run_acknowledged": "true", "lenses": "risk,reliability"})) == {"timeout_ms": 5000, "reviewer_run_acknowledged": True, "lenses": ["risk", "reliability"]}
    # the wrong-shaped values are then rejected by the schema, with nothing run
    f = make_fx()
    call = make_server(f)
    for args in [{"timeout_ms": "1e3"}, {"reviewer_run_acknowledged": "TRUE"}, {"lenses_reason": "true"}]:
        assert error_code(call("review_run", args)) == "invalid_input", json.dumps(args)
    assert lineages(f) == []


def test_coercion_edges_json_arrays_comma_lists_digit_limits_and_unknown_properties_are_left_alone():
    run = TOOL_BY_NAME["review_run"].input_schema
    assert coerce_arguments(run, {"lenses": '["risk","x"]'})["lenses"] == ["risk", "x"]
    assert coerce_arguments(run, {"lenses": "[oops"})["lenses"] == "[oops", "a broken JSON array stays a string (validation reports it)"
    assert coerce_arguments(run, {"lenses": " risk , ,reliability "})["lenses"] == ["risk", "reliability"]
    assert coerce_arguments(run, {"timeout_ms": "-0"})["timeout_ms"] == 0
    assert coerce_arguments(run, {"timeout_ms": "1234567890123456"})["timeout_ms"] == "1234567890123456", "more than 15 digits is left as is"
    assert coerce_arguments(run, {"surprise": "true"}) == {"surprise": "true"}
    assert coerce_arguments(run, [1]) == [1]
    assert coerce_arguments(run, {"binding": "true"}) == {"binding": "true"}


def test_s1_a1_every_tool_rejects_proto_constructor_prototype_top_level_and_nested_writing_nothing(make_fx):
    f = make_fx()
    server = ReviewServer({"deps": {"riskAssessor": assess("low"), "modeOptions": ModeOptions(data_dir=f.data)}, "cwd": f.repo})
    ids = [0]

    def send(name, args_json):
        ids[0] += 1
        msg = json.loads(f'{{"jsonrpc":"2.0","id":{ids[0]},"method":"tools/call","params":{{"name":{json.dumps(name)},"arguments":{args_json}}}}}')
        res = server.handle(msg)
        assert "error" not in res
        r = res["result"]
        assert r.get("isError") is True, f"{name} {args_json}: {r['content'][0]['text'][:200]}"
        return json.loads(r["content"][0]["text"])

    payloads = ['{"__proto__":{"limit":0}}', '{"constructor":{"x":1}}', '{"prototype":1}', '{"cwd":"/x","__proto__":{"cwd":"/y"}}']
    for tool in TOOLS:
        for payload in payloads:
            body = send(tool.name, payload)
            assert body["error"]["code"] == "invalid_input", f"{tool.name} {payload}"
            assert re.search(r"unknown property (__proto__|constructor|prototype)", json.dumps(body["error"]["errors"])), f"{tool.name} {payload}"
    ack = '"lineage_id":"review-0123456789abcdef","target_identity":"sha256:' + "a" * 64 + '","expected_revision":"r","token":"t"'
    for key in ["__proto__", "constructor", "prototype"]:
        body = send("review_status", f'{{"acknowledgement":{{{ack},"{key}":{{"token":"x"}}}}}}')
        assert body["error"]["code"] == "invalid_input", key
        assert re.search(rf"\$\.acknowledgement: unknown property {key}", json.dumps(body["error"]["errors"])), key
    body = send("review_status", '{"acknowledgement":{"__proto__":{"token":"x"}}}')
    assert re.search(r"missing required property|unknown property __proto__", json.dumps(body["error"]["errors"]))
    assert not os.path.exists(os.path.join(f.common_dir, "odd-plugin")), "nothing was written"


# ---- Python-specific: output bound and error mapping ----


def test_an_oversize_result_is_the_typed_output_too_large(monkeypatch):
    from odd_claude.mcp import tools as T

    r = T.ok({"x": "y" * (MAX_OUTPUT_BYTES + 1)})
    assert r["isError"] is True
    body = json.loads(r["content"][0]["text"])
    assert body["error"]["code"] == "output_too_large"
    assert body["error"]["message"] == f"the result is larger than {MAX_OUTPUT_BYTES} bytes and was dropped"


def test_fail_truncates_the_message_to_1000_utf16_units_and_keeps_extra_fields():
    from odd_claude.mcp.tools import fail

    body = json.loads(fail("c", "m" * 2000, {"k": 1})["content"][0]["text"])
    assert body == {"error": {"code": "c", "message": "m" * 1000, "k": 1}}


def test_an_unexpected_exception_inside_a_tool_is_an_internal_error_not_a_crash(make_fx, monkeypatch):
    f = make_fx()
    call = make_server(f)

    def boom(*a, **k):
        raise RuntimeError("kaboom")

    monkeypatch.setattr("odd_claude.mcp.tools.assess_candidate", boom)
    c = call("review_assess")
    assert error_code(c) == "internal_error"
    assert c.body["error"]["message"] == "kaboom"
