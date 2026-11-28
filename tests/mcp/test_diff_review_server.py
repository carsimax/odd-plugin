"""Differential: the Python review server against the compiled v9 server (`node dist/mcp/review-server.js`), both as stdio children on the SAME
repository and data dir, with sandboxed HOME/data. Every call shape (valid and invalid arguments, coercion, unknown methods and tools, bad
ids, oversize and malformed lines, lone surrogates, invalid UTF-8) must answer the same bytes. Only read-only and refusing calls are used,
so one repository serves both runs (the writing flows are covered by test_cross_impl_transaction). Cancellation and in-flight ids are
checked live against a slow fake reviewer for both implementations."""
import json
import time

import pytest
from odd_claude.mcp.server_core import MAX_LINE_BYTES

from mcp.conftest import Fx, Stdio, binding_values, child_env, choice_args, make_echo_claude, needs_v9_server, norm, run_raw

pytestmark = needs_v9_server

SHA = f"sha256:{'a' * 64}"


def msg(id, method, params=None):
    return {"jsonrpc": "2.0", "id": id, "method": method, **({} if params is None else {"params": params})}


def tool(id, name, args=None):
    return msg(id, "tools/call", {"name": name, "arguments": {} if args is None else args})


def enc(messages):
    return ("\n".join(m if isinstance(m, str) else json.dumps(m) for m in messages) + "\n").encode()


@pytest.fixture
def fx(make_fx):
    return make_fx()


def both(fx: Fx, data: bytes, extra_path=None):
    env = child_env(fx.dir, fx.data, extra_path)
    v9, rc9 = run_raw("v9", data, env, fx.repo)
    py, rcp = run_raw("py", data, env, fx.repo)
    assert rc9 == rcp == 0
    return v9, py


def assert_same(fx: Fx, data: bytes, expect_lines: int | None = None):
    v9, py = both(fx, data)
    assert norm(py) == norm(v9)
    if expect_lines is not None:
        assert len(norm(py)) == expect_lines
    return py


PROTOCOL = [
    msg(1, "initialize", {"protocolVersion": "2025-03-26"}),
    {"jsonrpc": "2.0", "method": "notifications/initialized"},
    msg(2, "ping"),
    msg(3, "resources/list"),
    msg("a" * 150, "m" * 150),
    msg(4, "tools/call"),
    msg(5, "tools/call", {}),
    msg(6, "tools/call", {"name": 5}),
    msg(7, "tools/call", {"name": "odd_nothing"}),
    msg(8, "tools/call", {"name": "x" * 150}),
    msg(9, "tools/call", {"name": "review_status", "arguments": []}),
    msg(10, "tools/call", {"name": "review_status", "arguments": None}),
    msg(11, "tools/call", {"name": "review_status", "arguments": "s"}),
    {"id": 12, "method": "ping"},
    {"jsonrpc": "2.0", "id": {}, "method": "ping"},
    {"jsonrpc": "2.0", "id": None, "method": "ping"},
    {"jsonrpc": "2.0", "id": True, "method": "ping"},
    {"jsonrpc": "1.0", "id": 13, "method": "ping"},
    {"jsonrpc": "2.0", "id": 14, "method": 5},
    {"jsonrpc": "2.0", "id": 15},
    [{"jsonrpc": "2.0", "id": 16, "method": "ping"}],
    "nope",
    "5",
    "null",
    {"jsonrpc": "2.0", "method": "resources/list"},
    {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 99}},
    {"jsonrpc": "2.0", "method": "notifications/cancelled"},
    msg(1.5, "ping"),
    msg("1", "ping"),
]


def test_diff_protocol_shapes_answer_the_same_bytes(fx):
    assert_same(fx, enc(PROTOCOL))


def test_diff_ids_numbers_normalise_like_json_stringify(fx):
    data = b"\n".join(
        l.encode() for l in [
            '{"jsonrpc":"2.0","id":1e3,"method":"ping"}', '{"jsonrpc":"2.0","id":12345678901234567890,"method":"ping"}',
            '{"jsonrpc":"2.0","id":-0,"method":"ping"}', '{"jsonrpc":"2.0","id":1.0,"method":"ping"}', '{"jsonrpc":"2.0","id":0.1,"method":"ping"}',
            '{"jsonrpc":"2.0","id":1e21,"method":"ping"}', '{"jsonrpc":"2.0","id":"\\u00e9\\ud83d\\ude00","method":"ping"}',
        ]
    ) + b"\n"
    assert_same(fx, data, 7)


def test_diff_unicode_lone_surrogates_and_invalid_utf8(fx):
    data = (
        b'{"jsonrpc":"2.0","id":1,"method":"\\ud83d"}\n'
        + '{"jsonrpc":"2.0","id":2,"method":"é😀"}\n'.encode()
        + b'{"jsonrpc":"2.0","id":3,"method":"bad\xff\xfebytes"}\n'
        + b'{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"review_status","arguments":{"projection":"\\ud800"}}}\n'
    )
    assert_same(fx, data, 4)


def test_diff_framing_blank_lines_crlf_parse_errors_and_eof_without_newline(fx):
    data = b'\n  \n{"jsonrpc":"2.0","id":1,"method":"ping"}\r\n{bad\n\t\n{"jsonrpc":"2.0","id":2,"method":"ping"}\r\n\r\n{"jsonrpc":"2.0","id":3,"method":"ping"}'
    assert_same(fx, data, 4)


def test_diff_a_terminated_line_over_the_cap_is_dropped_with_the_invalid_request_error(fx):
    data = b'{"jsonrpc":"2.0","id":1,"method":"ping"}\n' + b"x" * (MAX_LINE_BYTES + 10) + b'\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n'
    assert_same(fx, data, 3)


def test_diff_an_unterminated_line_over_the_cap_is_answered_once_and_dropped_to_the_next_newline(fx):
    data = b"y" * (MAX_LINE_BYTES + 5) + b'\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n' + b"z" * (MAX_LINE_BYTES + 5)
    assert_same(fx, data, 3)  # each unterminated overflow is answered once; the ping in between is served


def test_diff_the_cap_edge_a_line_of_exactly_the_cap_is_parsed_one_byte_more_is_dropped(fx):
    pad = MAX_LINE_BYTES - len('{"jsonrpc":"2.0","id":1,"method":"ping","x":""}')
    at_cap = ('{"jsonrpc":"2.0","id":1,"method":"ping","x":"' + "a" * pad + '"}').encode()
    assert len(at_cap) == MAX_LINE_BYTES
    over = at_cap[:-2] + b'a"}'
    assert len(over) == MAX_LINE_BYTES + 1
    assert_same(fx, at_cap + b"\n" + over + b"\n", 2)
    assert_same(fx, at_cap + over[:10], 1)


def test_diff_multibyte_line_at_the_byte_cap_counts_bytes_not_characters(fx):
    pad = (MAX_LINE_BYTES - len('{"jsonrpc":"2.0","id":1,"method":"ping","x":""}')) // 2
    line = ('{"jsonrpc":"2.0","id":1,"method":"ping","x":"' + "é" * (pad + 3) + '"}').encode()
    assert len(line) > MAX_LINE_BYTES and len(line.decode()) < MAX_LINE_BYTES
    assert_same(fx, line + b"\n" + b'{"jsonrpc":"2.0","id":2,"method":"ping"}\n', 2)


BAD_CALLS = [
    ("review_start", {"target": "everything"}), ("review_start", {"surprise": 1}), ("review_start", {"cwd": ""}), ("review_start", {"cwd": "x" * 4097}),
    ("review_start", {"lenses": ["risk"]}), ("review_start", {"lenses_reason": "x"}), ("review_start", {"target": "base-diff"}),
    ("review_start", {"base_ref": "main"}), ("review_start", {"target": "base-diff", "base_ref": "main", "projection": "staged"}),
    ("review_start", {"lenses": ["a", "b", "c", "d", "e"], "lenses_reason": "r"}), ("review_start", {"locale": "e"}), ("review_start", {"locale": "en-"}),
    ("review_start", {"locale": "en-US\n"}), ("review_start", {"contract": "nope"}), ("review_start", {"target_identity": SHA + "\n"}),
    ("review_start", {"target_identity": "sha256:abc"}),
    ("review_answer_consent", {}), ("review_answer_consent", {"target_identity": SHA, "consent": "relay", "consent_binding": SHA}),
    ("review_answer_consent", {"target_identity": SHA, "consent": "granted", "consent_binding": SHA}),
    ("review_answer_consent", {"target_identity": SHA, "consent": "declined", "consent_binding": SHA, "lenses": "risk", "lenses_reason": "r"}),
    ("review_status", {"acknowledgement": {"lineage_id": "x"}}), ("review_status", {"acknowledgement": "x"}), ("review_status", {"detail": "verbose"}),
    ("review_status", {"acknowledgement": {"lineage_id": "review-0123456789abcdef", "target_identity": SHA, "expected_revision": "r", "token": "t", "extra": 1}}),
    ("review_run", {"model": "gpt"}), ("review_run", {"effort": "high"}), ("review_run", {"model": "haiku", "effort": "high"}), ("review_run", {"timeout_ms": 5}),
    ("review_run", {"timeout_ms": 8000000}), ("review_run", {"timeout_ms": 1500.5}), ("review_run", {"timeout_ms": "1e3"}), ("review_run", {"reviewer_run_acknowledged": "TRUE"}),
    ("review_run", {"lenses_reason": "true"}), ("review_run", {"reviewer_run_binding": ""}),
    ("review_capture", {"lineage_id": "x"}), ("review_capture", {"lineage_id": "review-0123456789abcdef", "binding": "x"}),
    ("review_capture", {"lineage_id": "a/b", "binding": "x"}), ("review_capture_group", {"lineage_id": "x", "bindings": []}),
    ("review_capture_group", {"lineage_id": "x", "bindings": ["a", "a"]}), ("review_capture_group", {"lineage_id": "review-0123456789abcdef", "bindings": ["a"]}),
    ("review_capture_group", {"lineage_id": "review-0123456789abcdef", "bindings": "[\"a\",\"b\"]"}), ("review_capture_group", {"lineage_id": "review-0123456789abcdef", "bindings": "[1]"}),
    ("review_capture_group", {"lineage_id": "review-0123456789abcdef", "bindings": ["a"] * 9}),
    ("review_acknowledge_approved", {"lineage_id": "x"}), ("review_acknowledge_approved", {"lineage_id": "review-0123456789abcdef", "target_identity": SHA, "expected_revision": "r", "token": "t"}),
    ("review_acknowledge_approved", {"lineage_id": "review-zz", "target_identity": SHA, "expected_revision": "r", "token": "t"}),
    ("review_complete", {"lineage_id": "x", "expected_revision": 5}), ("review_complete", {"lineage_id": "review-0123456789abcdef", "expected_revision": "r"}),
    ("review_inspect", {"limit": 0}), ("review_inspect", {"limit": 101}), ("review_inspect", {"limit": 1.5}), ("review_inspect", {"limit": "2"}), ("review_inspect", {"limit": "1.5"}),
    ("review_inspect", {"limit": "-1"}), ("review_inspect", {"limit": "007"}), ("review_inspect", {"limit": 2.0}),
    ("review_assess", {"escalate": "yes"}), ("review_assess", {"cwd": "/definitely/not/here"}), ("review_assess", {"target": "base-diff", "base_ref": "no-such-ref", "committed_only": True}),
    ("review_assess", {"target": "base-diff", "base_ref": "main", "committed_only": "true"}), ("review_assess", {"target": "base-diff", "base_ref": "main", "committed_only": "yes"}),
    ("review_assess", {"projection": "staged"}), ("review_assess", {"base_ref": "x"}),
]

GOOD_READS = [
    ("review_assess", {}), ("review_inspect", {}), ("review_status", {}), ("review_status", {"detail": "concise"}), ("review_status", {"projection": "staged"}),
    ("review_start", {}), ("review_start", {"lenses": ["risk"], "lenses_reason": "only risk"}), ("review_start", {"lenses": "risk,reliability", "lenses_reason": "two"}),
    ("review_start", {"locale": "es-ES"}), ("review_start", {"target": "base-diff", "base_ref": "main"}), ("review_run", {}), ("review_run", {"model": "haiku"}),
    ("review_run", {"lineage_id": "review-0123456789abcdef"}),
]


@pytest.mark.parametrize("group", [BAD_CALLS[i::4] for i in range(4)] + [GOOD_READS], ids=["bad0", "bad1", "bad2", "bad3", "good"])
def test_diff_tool_calls_valid_invalid_and_coerced_answer_the_same_bytes(fx, group):
    data = enc([tool(i + 1, n, a) for i, (n, a) in enumerate(group)])
    assert_same(fx, data, len(group))


def test_diff_proto_and_reserved_names_in_arguments(fx):
    payloads = ['{"__proto__":{"limit":0}}', '{"constructor":{"x":1}}', '{"prototype":1}', '{"cwd":"/x","__proto__":{"cwd":"/y"}}', '{"limit":"3","__proto__":{"limit":0}}']
    names = ["review_assess", "review_inspect", "review_start", "review_status", "review_answer_consent", "review_capture", "review_capture_group", "review_acknowledge_approved", "review_complete", "review_run"]
    lines = []
    n = 0
    for name in names:
        for p in payloads:
            n += 1
            lines.append(f'{{"jsonrpc":"2.0","id":{n},"method":"tools/call","params":{{"name":"{name}","arguments":{p}}}}}')
    ack = f'"lineage_id":"review-0123456789abcdef","target_identity":"{SHA}","expected_revision":"r","token":"t"'
    for key in ("__proto__", "constructor", "prototype"):
        n += 1
        lines.append(f'{{"jsonrpc":"2.0","id":{n},"method":"tools/call","params":{{"name":"review_status","arguments":{{"acknowledgement":{{{ack},"{key}":{{"token":"x"}}}}}}}}}}')
    assert_same(fx, ("\n".join(lines) + "\n").encode(), n)


def test_diff_argument_key_order_follows_object_keys_integer_like_first(fx):
    args = '{"zzz":1,"10":2,"2":3,"aaa":4,"limit":"x"}'
    data = f'{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"review_inspect","arguments":{args}}}}}\n'.encode()
    assert_same(fx, data, 1)


def test_diff_many_validation_errors_are_capped_at_ten_in_the_same_order(fx):
    args = {f"k{i:02d}": i for i in range(30)}
    assert_same(fx, enc([tool(1, "review_start", args), tool(2, "review_status", {"acknowledgement": {f"q{i}": i for i in range(20)}})]), 2)


def test_diff_repeated_unique_id_calls_in_one_stream_are_independent(fx):
    assert_same(fx, enc([tool(1, "review_assess"), tool(1, "review_inspect")]), 2)


# ---- live: in-flight ids and cancellation against a slow fake reviewer ----


def live_review(impl: str, make_fx, tmp_path, sleep_s: float):
    """Consent granted and the forecast taken on a fresh repo; returns (stdio client, run arguments of the acknowledged call, fx)."""
    f = make_fx()
    claude = make_echo_claude(tmp_path / f"claude-{impl}", sleep_s)
    c = Stdio(impl, child_env(f.dir, f.data, claude), f.repo)
    c.initialize()
    env = c.call("review_start").body
    lineage = c.call("review_answer_consent", choice_args(env, "granted")).body["lineage_id"]
    fc = c.call("review_run", {"lineage_id": lineage}).body
    return c, {"lineage_id": lineage, "reviewer_run_acknowledged": True, "reviewer_run_binding": fc["reviewer_run_binding"]}, f


@pytest.mark.parametrize("impl", ["v9", "py"])
def test_diff_cancel_of_an_in_flight_review_run_answers_a_typed_cancelled_outcome_promptly(impl, make_fx, tmp_path):
    c, args, f = live_review(impl, make_fx, tmp_path, 3.0)
    try:
        t0 = time.time()
        rid = c.start("tools/call", {"name": "review_run", "arguments": args})
        time.sleep(0.5)
        c.send({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": rid}})
        r = c.wait(rid, 10)
        body = json.loads(r["result"]["content"][0]["text"])
        assert body["outcome"] == "cancelled", body
        assert body["lineage_id"] == args["lineage_id"]
        assert time.time() - t0 < 2.8, "answered before the 3 s reviewer would have"
        assert "isError" not in r["result"]
    finally:
        c.close()


@pytest.mark.parametrize("impl", ["v9", "py"])
def test_diff_a_duplicate_in_flight_id_is_rejected_and_a_late_cancel_is_ignored(impl, make_fx, tmp_path):
    c, args, f = live_review(impl, make_fx, tmp_path, 1.5)
    try:
        rid = c.start("tools/call", {"name": "review_run", "arguments": args})
        time.sleep(0.4)
        c.send({"jsonrpc": "2.0", "id": rid, "method": "tools/call", "params": {"name": "review_assess", "arguments": {}}})
        time.sleep(0.4)
        c.wait(rid, 30)
        deadline = time.time() + 30
        while len([m for m in c.log if m.get("id") == rid]) < 2 and time.time() < deadline:
            time.sleep(0.05)
        same = [m for m in c.log if m.get("id") == rid]
        assert len(same) == 2
        dup = next(m for m in same if "error" in m)
        assert dup["error"] == {"code": -32600, "message": "a request with this id is already in flight"}
        real = next(m for m in same if "result" in m)
        assert json.loads(real["result"]["content"][0]["text"])["outcome"] == "closed", "the first call is unaffected"
        c.send({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": rid}})  # settled: ignored
        assert c.request("ping")["result"] == {}
    finally:
        c.close()
