from odd_claude.lib.state import StateOptions, read_session_state, update_session_state
from odd_claude.lib.subagents import MAX_SUBAGENTS, format_duration, read_subagents, record_subagent_start, record_subagent_stop


def test_start_then_stop_records_one_entry_with_type_start_end(opts):
    record_subagent_start({"session_id": "s1", "agent_id": "a1", "agent_type": "odd-claude:odd-explore"}, opts, 1_000)
    assert read_subagents("s1", opts) == [{"id": "a1", "type": "odd-claude:odd-explore", "startedAt": 1_000}]
    record_subagent_stop({"session_id": "s1", "agent_id": "a1", "agent_type": "odd-claude:odd-explore"}, opts, 4_500)
    assert read_subagents("s1", opts) == [{"id": "a1", "type": "odd-claude:odd-explore", "startedAt": 1_000, "endedAt": 4_500}]


def test_a_late_start_keeps_the_ended_at_of_an_already_stopped_record(opts):
    record_subagent_stop({"session_id": "s1", "agent_id": "a1", "agent_type": "t"}, opts, 5_000)
    record_subagent_start({"session_id": "s1", "agent_id": "a1", "agent_type": "t"}, opts, 1_000)
    assert read_subagents("s1", opts) == [{"id": "a1", "type": "t", "startedAt": 1_000, "endedAt": 5_000}]


def test_stop_without_a_recorded_start_adds_an_ended_entry_other_state_keys_survive(opts):
    update_session_state("s1", lambda s: {**s, "keep": 7}, opts)
    record_subagent_stop({"session_id": "s1", "agent_id": "zz", "agent_type": "general-purpose"}, opts, 9_000)
    assert read_subagents("s1", opts) == [{"id": "zz", "type": "general-purpose", "endedAt": 9_000}]
    assert read_session_state("s1", opts)["keep"] == 7


def test_missing_session_id_missing_data_dir_or_garbage_input_never_raise_and_write_nothing(tmp_path, opts):
    record_subagent_start({}, opts)
    record_subagent_start({"session_id": "s1", "agent_id": 5}, opts)
    record_subagent_start("garbage", opts)
    home = StateOptions(env={"ODD_CLAUDE_HOME": str(tmp_path / "home")})
    record_subagent_start({"session_id": "s1", "agent_id": "a"}, home)  # no data dir env: the home default
    assert read_subagents("s1", opts) == []
    assert len(read_subagents("s1", home)) == 1
    assert read_subagents("nope", home) == []
    record_subagent_start({"session_id": "s1", "agent_id": "a"}, StateOptions(data_dir="relative"))  # logged, never raised


def test_the_list_is_capped_to_the_newest_max_subagents_entries(opts):
    for i in range(MAX_SUBAGENTS + 5):
        record_subagent_start({"session_id": "s1", "agent_id": f"a{i}", "agent_type": "t"}, opts, i)
    lst = read_subagents("s1", opts)
    assert len(lst) == MAX_SUBAGENTS
    assert lst[0]["id"] == "a5"
    assert lst[-1]["id"] == f"a{MAX_SUBAGENTS + 4}"


def test_format_duration():
    assert format_duration(0) == "0s"
    assert format_duration(3_400) == "3s"
    assert format_duration(65_000) == "1m05s"
    assert format_duration(3_725_000) == "1h02m05s"
    assert format_duration(-5) == "0s"


def test_missing_agent_type_is_unknown_and_non_record_entries_are_dropped(opts):
    update_session_state("s1", lambda s: {**s, "subagents": [{"id": "ok", "type": "t"}, {"id": 1}, "x", None]}, opts)
    assert read_subagents("s1", opts) == [{"id": "ok", "type": "t"}]
    record_subagent_start({"session_id": "s1", "agent_id": "n", "agent_type": ""}, opts, 3)
    assert read_subagents("s1", opts) == [{"id": "ok", "type": "t"}, {"id": "n", "type": "unknown", "startedAt": 3}]
    update_session_state("s2", lambda s: {**s, "subagents": "nope"}, opts)
    assert read_subagents("s2", opts) == []


def test_default_now_is_epoch_ms(opts):
    record_subagent_start({"session_id": "s1", "agent_id": "a"}, opts)
    assert read_subagents("s1", opts)[0]["startedAt"] > 1_700_000_000_000
