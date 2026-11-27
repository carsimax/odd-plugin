import json
import os

import pytest

from odd_claude.lib.background_subagents import (
    BackgroundResolution,
    background_subagents_line,
    read_background_subagents,
    resolve_background_subagents,
    write_background_subagents,
)
from odd_claude.lib.state import StateOptions, read_plugin_state, write_plugin_state

ENV = "ODD_CLAUDE_BACKGROUND_SUBAGENTS"


def o(opts, env):
    return StateOptions(data_dir=opts.data_dir, env=env)


def test_default_is_off_source_default(opts, tmp_path):
    assert resolve_background_subagents(o(opts, {})) == BackgroundResolution("off", "default", False)
    assert read_background_subagents(StateOptions(env={"ODD_CLAUDE_HOME": str(tmp_path / "nohome")})) == "off"


def test_set_on_off_round_trips_through_plugin_state_and_wins_over_the_environment(opts):
    assert write_background_subagents("on", opts) == "on"
    assert resolve_background_subagents(o(opts, {ENV: "off"})) == BackgroundResolution("on", "state", False)
    write_background_subagents("off", opts)
    assert read_background_subagents(o(opts, {})) == "off"
    assert read_plugin_state("background-subagents", opts) == {"policy": "off"}


def test_environment_applies_when_no_state_exists_and_unknown_values_are_inert(opts):
    assert resolve_background_subagents(o(opts, {ENV: "on"})) == BackgroundResolution("on", "environment", False)
    assert resolve_background_subagents(o(opts, {ENV: "yes"})).source == "default"


def test_invalid_policy_raises_and_leaves_the_stored_value_untouched(opts):
    write_background_subagents("on", opts)
    path = os.path.join(opts.data_dir, "background-subagents.json")
    before = open(path).read()
    with pytest.raises(ValueError) as e:
        write_background_subagents("maybe", opts)
    assert str(e.value) == 'invalid policy "maybe"; available policies: on, off'
    assert open(path).read() == before
    assert read_background_subagents(o(opts, {})) == "on"


def test_a_malformed_state_file_fails_closed_to_off_and_is_reported(opts):
    write_plugin_state("background-subagents", {"policy": "sure"}, opts)
    assert resolve_background_subagents(o(opts, {ENV: "on"})) == BackgroundResolution("off", "state", True)
    open(os.path.join(opts.data_dir, "background-subagents.json"), "w").write("{corrupt")
    assert resolve_background_subagents(o(opts, {ENV: "on"})) == BackgroundResolution("off", "state", True)


def test_a_relative_data_dir_falls_through_to_environment_then_default():
    rel = StateOptions(data_dir="relative", env={ENV: "on"})
    assert resolve_background_subagents(rel) == BackgroundResolution("on", "environment", False)
    assert resolve_background_subagents(StateOptions(data_dir="relative", env={})).source == "default"


def test_context_line_states_the_policy_and_the_run_in_background_consequence():
    assert background_subagents_line("on").startswith("Background subagents: on")
    assert "run_in_background" in background_subagents_line("on")
    assert background_subagents_line("off").startswith("Background subagents: off")
    assert "foreground" in background_subagents_line("off")


def test_stored_file_is_the_state_envelope(opts):
    # lib-level equivalent of v9's CLI test: enable/disable persist {policy} under the plugin-state envelope
    write_background_subagents("on", opts)
    raw = json.load(open(os.path.join(opts.data_dir, "background-subagents.json")))
    assert raw["data"]["policy"] == "on" and raw["version"] == 1
    assert resolve_background_subagents(o(opts, {})).source == "state"
