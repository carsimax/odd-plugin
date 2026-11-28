"""Port of v9 mcp/concise.spec.ts (6 `test(` calls) plus one differential case: review_status `detail` concise|full."""
import json

import pytest
from mcp.conftest import Called, Fx, child_env, choice_args, good, make_server, needs_v9_server, norm, run_raw  # noqa: F401
from odd_claude.mcp.tools import TOOL_BY_NAME


def server_for(f: Fx):
    return make_server(f, "high")


def test_review_status_the_input_schema_and_description_declare_detail_concise_full():
    t = TOOL_BY_NAME["review_status"]
    d = t.input_schema["properties"]["detail"]
    assert d["enum"] == ["concise", "full"]
    assert t.input_schema["additionalProperties"] is False
    assert "detail" in t.description
    assert "concise" in t.description
    assert len(t.description) < 2000


def test_review_status_detail_full_and_the_omitted_argument_are_byte_identical_fresh_and_reviewing_states(make_fx):
    call = server_for(make_fx())
    none = call("review_status")
    assert none.is_error is False
    full = call("review_status", {"detail": "full"})
    assert json.dumps(full.body) == json.dumps(none.body)
    env = call("review_start").body
    assert call("review_answer_consent", choice_args(env, "granted")).is_error is False
    none2 = call("review_status")
    full2 = call("review_status", {"detail": "full"})
    assert none2.body["next_transition"]["kind"] == "collect"
    assert json.dumps(full2.body) == json.dumps(none2.body)


def test_review_status_concise_is_smaller_and_keeps_every_next_call_field_fresh_state(make_fx):
    call = server_for(make_fx())
    full = call("review_status").body
    c = call("review_status", {"detail": "concise"})
    assert c.is_error is False
    assert len(json.dumps(c.body)) < len(json.dumps(full))
    assert full.get("forecast") is not None and full.get("repair") is not None, "the full status carries forecast and repair"
    for k in ["schema", "contract", "operation", "action", "target_identity", "next_transition", "consumed", "forecast", "repair"]:
        assert c.body.get(k) == full.get(k), k
    assert c.body["next_transition"] == full["next_transition"]


def test_review_status_concise_keeps_every_collect_inputs_command_arguments_binding_and_the_authority(make_fx):
    call = server_for(make_fx())
    env = call("review_start").body
    call("review_answer_consent", choice_args(env, "granted"))
    full = call("review_status").body
    c = call("review_status", {"detail": "concise"})
    assert c.is_error is False
    assert len(json.dumps(c.body)) < len(json.dumps(full)) - 1500, "high-risk collect shrinks by at least 1.5 KB"
    assert c.body["authority"] == full["authority"]
    assert full["forecast"] is not None and full["repair"] is not None
    assert c.body["forecast"] == full["forecast"]
    assert c.body["repair"] == full["repair"]
    assert "projection" not in c.body, "projection is the only dropped top-level field"
    assert c.body["target_identity"] == full["target_identity"]
    nt = c.body["next_transition"]
    assert nt["kind"] == full["next_transition"]["kind"]
    assert nt["reason_code"] == full["next_transition"]["reason_code"]
    assert nt["collect"]["command"] == full["next_transition"]["collect"]["command"]
    assert nt["collect"]["arguments"] == full["next_transition"]["collect"]["arguments"]
    assert len(nt["collect"]["inputs"]) == len(full["next_transition"]["collect"]["inputs"])
    for n, i in enumerate(nt["collect"]["inputs"]):
        f = full["next_transition"]["collect"]["inputs"][n]
        for k in ("name", "command", "arguments"):
            assert i[k] == f[k], f"{f['name']}.{k}"
        assert any(a["name"] == "binding" and a["value"].startswith("odd1.") for a in i["arguments"])
        for dropped in ("schema", "capture_operation", "artifact_subject", "base_tree", "candidate_tree"):
            assert dropped not in i


@pytest.mark.parametrize("detail", ["verbose", "", "FULL", 1, None, True])
def test_review_status_an_invalid_detail_is_rejected_by_schema_validation_and_nothing_runs(make_fx, detail):
    f = make_fx()
    call = server_for(f)
    r = call("review_status", {"detail": detail})
    assert r.is_error is True, json.dumps(detail)
    assert r.body["error"]["code"] == "invalid_input"
    assert len(r.body["error"]["errors"]) > 0


def test_the_transition_arguments_note_is_stated_once_on_review_status_only():
    marker = "The `arguments` of a review_status transition"
    assert [t.name for t in TOOL_BY_NAME.values() if marker in t.description] == ["review_status"]


@needs_v9_server
def test_diff_review_status_detail_matches_v9_byte_for_byte(make_fx, tmp_path):
    """Same repo, same data dir, both servers over stdio: every detail value (valid and invalid) answers the same bytes."""
    f = make_fx()
    env = child_env(f.dir, f.data)
    lines = []
    for i, detail in enumerate(["concise", "full", None, "verbose", 1]):
        args = {} if detail is None else {"detail": detail}
        lines.append(json.dumps({"jsonrpc": "2.0", "id": i + 1, "method": "tools/call", "params": {"name": "review_status", "arguments": args}}))
    data = ("\n".join(lines) + "\n").encode()
    v9, py = run_raw("v9", data, env, f.repo), run_raw("py", data, env, f.repo)
    assert norm(py[0]) == norm(v9[0]) and py[1] == v9[1] == 0
    assert len(norm(py[0])) == 5
