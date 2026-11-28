"""S3: `tools/list` and `initialize` of the Python server are identical to the v9 server's (names, descriptions, input schemas, annotations,
order). Both run as real stdio children from the same working directory and environment; the comparison is on the raw reply lines
(byte for byte), then on the decoded JSON with key order."""
import json

import pytest
from mcp.conftest import child_env, needs_v9_server, norm, run_raw

pytestmark = needs_v9_server


def lines(*messages):
    return ("\n".join(json.dumps(m) for m in messages) + "\n").encode()


def both(data: bytes, tmp_path):
    env = child_env(str(tmp_path), str(tmp_path / "data"))
    v9, rc9 = run_raw("v9", data, env, str(tmp_path))
    py, rcp = run_raw("py", data, env, str(tmp_path))
    assert rc9 == rcp == 0
    return v9, py


def test_s3_tools_list_is_byte_identical_to_v9(tmp_path):
    v9, py = both(lines({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}), tmp_path)
    assert py == v9
    tools = json.loads(py)["result"]["tools"]
    assert [t["name"] for t in tools] == [
        "review_assess", "review_inspect", "review_start", "review_status", "review_answer_consent", "review_capture", "review_capture_group",
        "review_acknowledge_approved", "review_complete", "review_run",
    ]


def test_s3_tools_list_json_is_identical_including_key_order(tmp_path):
    v9, py = both(lines({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}), tmp_path)
    a, b = json.loads(v9), json.loads(py)
    assert a == b
    assert json.dumps(a) == json.dumps(b), "the same keys in the same order, at every depth"
    for x, y in zip(a["result"]["tools"], b["result"]["tools"]):
        assert (x["name"], x["description"], x["inputSchema"], x["annotations"]) == (y["name"], y["description"], y["inputSchema"], y["annotations"])


@pytest.mark.parametrize("params", [
    {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}},
    {"protocolVersion": "2025-03-26"},
    {"protocolVersion": "2024-11-05"},
    {"protocolVersion": "1999-01-01"},
    {"protocolVersion": 5},
    {},
    None,
    [],
])
def test_s3_initialize_result_is_identical_to_v9(tmp_path, params):
    msg = {"jsonrpc": "2.0", "id": "i", "method": "initialize", **({} if params is None else {"params": params})}
    v9, py = both(lines(msg), tmp_path)
    assert py == v9
    r = json.loads(py)["result"]
    assert r["serverInfo"] == {"name": "odd-review", "version": "9.2.0"}
    assert r["capabilities"] == {"tools": {"listChanged": False}}


def test_s3_a_session_initialize_initialized_ping_list_answers_identically(tmp_path):
    data = lines(
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "ping"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/list"},
    )
    v9, py = both(data, tmp_path)
    assert norm(py) == norm(v9)
    assert len(norm(py)) == 3
