import json
import os
import time

import pytest

from odd_claude.lib.state import (
    STATE_SCHEMA_VERSION,
    StateOptions,
    atomic_write_file,
    data_dir_from_env,
    list_session_ids,
    log_error,
    prune_stale_session_files,
    read_plugin_state,
    read_session_state,
    resolve_data_dir,
    safe_segment,
    session_state_path,
    update_session_state,
    write_plugin_state,
    write_session_state,
)

from .conftest import FIXTURES


def test_write_then_read_round_trips_and_stamps_the_schema_version(opts):
    write_session_state("s1", {"a": 1}, opts)
    assert read_session_state("s1", opts) == {"a": 1}
    raw = json.loads(open(session_state_path("s1", opts)).read())
    assert raw["version"] == STATE_SCHEMA_VERSION == 1
    assert raw["sessionId"] == "s1"


def test_missing_state_reads_as_empty_and_creates_nothing(tmp_path):
    o = StateOptions(data_dir=str(tmp_path / "absent"))
    assert read_session_state("nope", o) == {}
    assert not (tmp_path / "absent").exists()


def test_missing_data_dir_is_created_on_write(tmp_path):
    o = StateOptions(data_dir=str(tmp_path / "x" / "y"))
    write_session_state("s1", {"ok": True}, o)
    assert read_session_state("s1", o) == {"ok": True}


def test_sessions_are_namespaced_and_do_not_overwrite_each_other(opts):
    write_session_state("a", {"v": "A"}, opts)
    write_session_state("b", {"v": "B"}, opts)
    assert read_session_state("a", opts) == {"v": "A"}
    assert read_session_state("b", opts) == {"v": "B"}
    assert session_state_path("a", opts) != session_state_path("b", opts)


def test_session_ids_cannot_escape_the_data_dir(opts):
    p = session_state_path("../../evil", opts)
    assert p.startswith(opts.data_dir + "/"), p
    assert ".." not in p


def test_atomic_write_leaves_no_temp_files_and_replaces_content(opts):
    write_session_state("s", {"n": 1}, opts)
    write_session_state("s", {"n": 2}, opts)
    assert read_session_state("s", opts) == {"n": 2}
    files = os.listdir(os.path.join(opts.data_dir, "sessions"))
    assert files == ["s.json"]


def test_corrupt_or_wrong_version_state_reads_as_empty(opts):
    p = session_state_path("s", opts)
    os.makedirs(os.path.dirname(p))
    for body in ["{not json", json.dumps({"version": 999, "sessionId": "s", "data": {"x": 1}}), "[]", "null",
                 json.dumps({"version": 1, "sessionId": "s", "data": [1]}), json.dumps({"version": True, "data": {}}),
                 '{"version": 1, "data": {"x": NaN}}']:
        open(p, "w").write(body)
        assert read_session_state("s", opts) == {}, body


def test_update_refuses_to_overwrite_a_file_of_another_schema_version(opts):
    p = session_state_path("s1", opts)
    os.makedirs(os.path.dirname(p))
    raw = json.dumps({"version": STATE_SCHEMA_VERSION + 1, "sessionId": "s1", "data": {"keep": 1}})
    open(p, "w").write(raw)
    with pytest.raises(Exception, match=r"session state has schema version 2; refusing to overwrite"):
        update_session_state("s1", lambda s: {**s, "x": 1}, opts)
    assert open(p).read() == raw
    assert not os.path.exists(p + ".lock")


def test_update_merges_via_the_updater(opts):
    write_session_state("s", {"n": 1}, opts)
    update_session_state("s", lambda d: {**d, "m": 2}, opts)
    assert read_session_state("s", opts) == {"n": 1, "m": 2}


def test_update_returning_the_same_object_skips_the_write(opts):
    write_session_state("s", {"n": 1}, opts)
    p = session_state_path("s", opts)
    os.utime(p, (1, 1))
    assert update_session_state("s", lambda d: d, opts) == {"n": 1}
    assert os.stat(p).st_mtime == 1


def test_resolve_data_dir_prefers_explicit_option_then_claude_plugin_data_else_home_default():
    assert resolve_data_dir(StateOptions(data_dir="/x", env={"CLAUDE_PLUGIN_DATA": "/y"})) == "/x"
    assert resolve_data_dir(StateOptions(env={"CLAUDE_PLUGIN_DATA": "/y"})) == "/y"
    assert resolve_data_dir(StateOptions(env={"HOME": "/hh"})) == "/hh/.odd-claude/data"


def test_resolve_data_dir_refuses_a_relative_data_dir_option_or_env():
    for bad in [".", "rel/dir", "../x"]:
        with pytest.raises(Exception, match="data dir must be an absolute path"):
            resolve_data_dir(StateOptions(data_dir=bad))
        with pytest.raises(Exception, match="absolute"):
            resolve_data_dir(StateOptions(env={"CLAUDE_PLUGIN_DATA": bad}))


def test_log_error_appends_a_line_to_logs_hooks_log(opts):
    log_error("boom", opts)
    log_error("again\nsecond", opts)
    lines = open(os.path.join(opts.data_dir, "logs", "hooks.log")).read().split("\n")
    assert lines[-1] == "" and len(lines) == 3
    assert lines[0].endswith(" boom")
    assert lines[1].endswith(" again second")


def test_log_error_never_throws(tmp_path):
    (tmp_path / "f").write_text("x")
    log_error("x", StateOptions(data_dir=str(tmp_path / "f")))  # logs/ cannot be created under a file
    log_error("x", StateOptions(data_dir="relative"))


def test_update_an_empty_fresh_lock_is_held_so_it_times_out_without_calling_the_callback(opts):
    lock = session_state_path("st", opts) + ".lock"
    os.makedirs(os.path.dirname(lock))
    open(lock, "w").close()
    called = []
    t0 = time.time()
    with pytest.raises(Exception, match="session state lock timeout"):
        update_session_state("st", lambda s: (called.append(1), s)[1], opts)
    assert time.time() - t0 <= 1.5
    assert called == []
    assert open(lock).read() == ""
    assert os.listdir(os.path.dirname(lock)) == ["st.json.lock"]


def test_update_a_lock_older_than_2s_even_empty_is_stale_and_nothing_is_left_behind(opts):
    lock = session_state_path("st", opts) + ".lock"
    os.makedirs(os.path.dirname(lock))
    open(lock, "w").close()
    old = time.time() - 3
    os.utime(lock, (old, old))
    update_session_state("st", lambda s: {**s, "a": 1}, opts)
    assert read_session_state("st", opts) == {"a": 1}
    assert os.listdir(os.path.dirname(lock)) == ["st.json"]


def test_data_dir_order_explicit_then_odd_claude_data_then_plugin_data_then_odd_claude_home():
    env = {"ODD_CLAUDE_DATA": "/odd/data", "CLAUDE_PLUGIN_DATA": "/plug/data", "ODD_CLAUDE_HOME": "/odd/home", "HOME": "/h"}
    assert resolve_data_dir(StateOptions(data_dir="/explicit", env=env)) == "/explicit"
    assert resolve_data_dir(StateOptions(env=env)) == "/odd/data"
    assert resolve_data_dir(StateOptions(env={**env, "ODD_CLAUDE_DATA": None})) == "/plug/data"
    assert resolve_data_dir(StateOptions(env={**env, "ODD_CLAUDE_DATA": "", "CLAUDE_PLUGIN_DATA": ""})) == "/odd/home/data"
    assert resolve_data_dir(StateOptions(env={"HOME": "/h"})) == "/h/.odd-claude/data"
    assert data_dir_from_env({"ODD_CLAUDE_HOME": "/odd/home"}) == "/odd/home/data"


def test_without_any_data_env_the_helpers_use_the_home_default(tmp_path):
    o = StateOptions(env={"ODD_CLAUDE_HOME": str(tmp_path)})
    write_session_state("s1", {"a": 1}, o)
    assert read_session_state("s1", o) == {"a": 1}
    assert (tmp_path / "data" / "sessions" / "s1.json").exists()


def test_a_relative_data_dir_from_any_source_is_still_rejected():
    for o in [StateOptions(env={"ODD_CLAUDE_DATA": "rel"}), StateOptions(env={"CLAUDE_PLUGIN_DATA": "rel"}), StateOptions(data_dir="rel")]:
        with pytest.raises(Exception, match="absolute"):
            resolve_data_dir(o)


# --- cases v9 covers only indirectly or the port adds ---


def test_unknown_data_keys_are_preserved_and_the_file_is_2_space_json_with_newline(opts):
    data = {"known": 1, "unknown": {"nested": [1, "ü", None]}, "z": False}
    write_session_state("s", data, opts)
    assert read_session_state("s", opts) == data
    text = open(session_state_path("s", opts), encoding="utf-8").read()
    assert text == json.dumps({"version": 1, "sessionId": "s", "data": data}, indent=2, ensure_ascii=False) + "\n"


def test_safe_segment():
    assert safe_segment("a/b..c d") == "a_b__c_d"
    assert safe_segment("") == "_"
    assert safe_segment("x" * 200) == "x" * 128


def test_plugin_state_round_trips_with_name_as_session_id_and_rejects_other_versions(opts):
    write_plugin_state("delegation", {"mode": "full"}, opts)
    p = os.path.join(opts.data_dir, "delegation.json")
    assert json.load(open(p)) == {"version": 1, "sessionId": "delegation", "data": {"mode": "full"}}
    assert read_plugin_state("delegation", opts) == {"mode": "full"}
    assert read_plugin_state("missing", opts) == {}
    open(p, "w").write(json.dumps({"version": 2, "sessionId": "delegation", "data": {"mode": "full"}}))
    assert read_plugin_state("delegation", opts) == {}


def test_atomic_write_file_applies_mode_regardless_of_umask_and_cleans_up_on_failure(tmp_path):
    p = str(tmp_path / "d" / "f")
    old = os.umask(0)
    try:
        atomic_write_file(p, b"x", 0o600)
    finally:
        os.umask(old)
    assert os.stat(p).st_mode & 0o777 == 0o600
    assert open(p, "rb").read() == b"x"
    with pytest.raises(OSError):
        atomic_write_file(str(tmp_path / "d" / "f" / "g"), "x")  # parent is a file
    assert os.listdir(tmp_path / "d") == ["f"]


def test_prune_deletes_only_old_unlocked_json_in_sessions_and_status_and_never_keep_id(opts):
    now = 10 * 86_400.0
    for sub in ["sessions", "status"]:
        os.makedirs(os.path.join(opts.data_dir, sub))
    files = {"sessions/old.json": 0, "sessions/keep.json": 0, "sessions/locked.json": 0, "sessions/new.json": now - 60,
             "sessions/old.txt": 0, "status/old.json": 0}
    for rel, mt in files.items():
        p = os.path.join(opts.data_dir, rel)
        open(p, "w").close()
        os.utime(p, (mt, mt))
    open(os.path.join(opts.data_dir, "sessions/locked.json.lock"), "w").close()
    prune_stale_session_files("keep", opts, now * 1000)
    assert sorted(os.listdir(os.path.join(opts.data_dir, "sessions"))) == ["keep.json", "locked.json", "locked.json.lock", "new.json", "old.txt"]
    assert os.listdir(os.path.join(opts.data_dir, "status")) == []
    prune_stale_session_files("keep", StateOptions(data_dir=os.path.join(opts.data_dir, "nope")))  # missing dir: no throw


def test_list_session_ids_newest_first_and_empty_when_missing(opts):
    assert list_session_ids(opts) == []
    for i, name in enumerate(["a", "b", "c", "d"]):
        write_session_state(name, {}, opts)
        t = 1000 + (i if name != "d" else 1)
        os.utime(session_state_path(name, opts), (t, t))
    assert list_session_ids(opts) == ["c", "b", "d", "a"]


# --- S4: version mismatch is rejected the same way as v9 ---


@pytest.mark.parametrize("rel,kind", [("session-state/session.json", "session"), ("plugin-state/delegation.json", "plugin")])
def test_s4_version_2_copy_of_a_fixture_reads_as_empty_without_exception(opts, rel, kind):
    body = json.loads((FIXTURES / rel).read_text())
    ident = body["sessionId"]
    assert read_back(kind, ident, body, opts) == body["data"]  # control: version 1 loads
    body["version"] = 2
    assert read_back(kind, ident, body, opts) == {}


def read_back(kind, ident, body, opts):
    if kind == "session":
        p = session_state_path(ident, opts)
        reader = read_session_state
    else:
        p = os.path.join(opts.data_dir, f"{ident}.json")
        reader = read_plugin_state
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write(json.dumps(body, indent=2) + "\n")
    return reader(ident, opts)
