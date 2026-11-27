"""S2: Phase 1 fixtures for Session state, Plugin-wide state, Scratch, Logs and Data dir env."""
import os
import re

import pytest

from odd_claude.lib.scratch import create_session_scratch
from odd_claude.lib.state import (
    StateFile,
    StateOptions,
    log_error,
    read_plugin_state,
    read_session_state,
    resolve_data_dir,
    session_state_path,
    write_plugin_state,
    write_session_state,
)

from .conftest import fixture_json, fixture_text


@pytest.mark.parametrize("rel", ["session-state/session.json", "plugin-state/delegation.json", "plugin-state/review-mode.json"])
def test_state_fixtures_load_through_the_model_and_round_trip_byte_identical(tmp_path, rel):
    text = fixture_text(rel)
    env = StateFile.model_validate_json(text)
    assert env.version == 1
    o = StateOptions(data_dir=str(tmp_path))
    if rel.startswith("session-state"):
        write_session_state(env.sessionId, env.data, o)
        written = open(session_state_path(env.sessionId, o), encoding="utf-8").read()
        assert read_session_state(env.sessionId, o) == env.data
    else:
        write_plugin_state(env.sessionId, env.data, o)
        written = open(tmp_path / f"{env.sessionId}.json", encoding="utf-8").read()
        assert read_plugin_state(env.sessionId, o) == env.data
    assert written == text  # placeholders such as <TIMESTAMP> stay values


def test_scratch_listing_matches_the_fixture(tmp_path):
    create_session_scratch("sess-contract-0001", StateOptions(data_dir=str(tmp_path)))
    lines = []
    for dirpath, dirnames, _ in os.walk(tmp_path):
        for d in dirnames:
            full = os.path.join(dirpath, d)
            lines.append(f"{os.stat(full).st_mode & 0o7777:04o} d {os.path.relpath(full, tmp_path)}/\n")
    assert "".join(sorted(lines)) == fixture_text("scratch/listing.txt")


def test_a_python_log_line_matches_the_fixture_line_shape(tmp_path):
    shape = re.compile(r"^<TIMESTAMP> [A-Za-z]+: .+\n$")
    assert shape.match(fixture_text("logs/hooks.log"))
    o = StateOptions(data_dir=str(tmp_path))
    log_error("SessionStart: Cannot read session_id", o)
    line = open(tmp_path / "logs" / "hooks.log").read()
    assert re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z ", line)
    assert shape.match(re.sub(r"^\S+", "<TIMESTAMP>", line))


def test_data_dir_env_resolution_matches_every_row_of_the_fixture(tmp_path):
    rows = fixture_json("data-dir-env/table.json")
    assert len(rows) >= 7
    sub = lambda s: s.replace("<SANDBOX>", str(tmp_path))
    for row in rows:
        env = {k: sub(v) for k, v in row["env"].items()}
        env["HOME"] = str(tmp_path / "home")
        assert resolve_data_dir(StateOptions(env=env)) == sub(row["dataDir"]), row["note"]
