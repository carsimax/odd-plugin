import json
import os
import re

import pytest

from odd_claude.lib.context import (
    SessionContextInput,
    build_prompt_anchor,
    build_session_context,
    read_delegation_mode,
    write_delegation_mode,
)
from odd_claude.lib.state import StateOptions, write_plugin_state


def ctx(mode="organic", **kw):
    return build_session_context(SessionContextInput(delegation_mode=mode, **kw))


def test_session_context_keeps_only_dynamic_lines():
    text = ctx()
    assert text.startswith("# odd-claude session context")
    assert "Coordinator mode: OFF" in text and "Background subagents: off" in text
    assert text.count("Coordinator mode:") == 1
    assert "Delegation mode:" not in text


def test_session_context_no_longer_repeats_static_text():
    for mode in ("organic", "full"):
        text = ctx(mode)
        for pat in [r"Cards directory:", r"Persona mode", r"voseo|senior architect|Do not use slang", r"same language the user writes in", r"Only a message written by the human"]:
            assert not re.search(pat, text, re.I if "voseo" in pat else 0), pat
        assert len(text) < 1500


def test_session_context_mentions_no_mentor_mode():
    assert not re.search("mentor", ctx(), re.I)


def test_full_delegation_changes_the_text():
    assert "Coordinator mode: ON (full delegation)" in ctx("full")
    assert not re.search(r"full delegation\)", ctx(), re.I)


def test_context_stays_small_and_has_no_forbidden_identifiers():
    for mode in ("organic", "full"):
        text = ctx(mode)
        assert len(text) < 10000
        assert not re.search(r"gentle|tele\w+try", text, re.I)  # odd-check: allow


def test_full_delegation_context_names_odd_worker_without_the_plugin_namespace():
    c = ctx("full")
    assert "bounded `odd-worker` writer" in c
    assert "odd-claude:" not in c


def test_prompt_anchor_quotes_the_start_of_a_human_prompt_bounded():
    a = build_prompt_anchor("  hola\n\ncómo   estás  ")
    assert a == 'Reply-language anchor: the human\'s latest message begins "hola cómo estás". Reply in the language of that message.'
    long = build_prompt_anchor("x" * 500)
    assert len(long) < 400 and "…" in long
    assert f'begins "{"x" * 100}…"' in long


def test_prompt_anchor_is_skipped_for_empty_slash_and_shell_prompts():
    for p in ["", "   ", "/odd-claude:status", "!ls", None, 42]:
        assert build_prompt_anchor(p) is None


def test_prompt_anchor_counts_utf16_units_like_v9():
    # 50 astral characters = 100 UTF-16 units: not truncated; 51 are
    assert "…" not in build_prompt_anchor("\U0001f600" * 50)
    assert build_prompt_anchor("\U0001f600" * 51).count("\U0001f600") == 50


def test_session_context_carries_background_policy_and_extra_lines():
    assert "Background subagents: off" in ctx()
    on = ctx(background_subagents="on", extra_lines=["Skill registry: /p/.atl/skill-registry.md (3 skills)"])
    assert "Background subagents: on" in on and "run_in_background" in on
    assert "Skill registry: /p/.atl/skill-registry.md (3 skills)" in on
    assert len(on) < 10000


def test_coordinator_mode_defaults_to_full_when_nothing_stored_corrupt_unknown_or_no_dir(opts, tmp_path):
    assert read_delegation_mode(opts) == "full"
    os.makedirs(opts.data_dir)
    path = os.path.join(opts.data_dir, "delegation.json")
    open(path, "w").write("{not json")
    assert read_delegation_mode(opts) == "full"
    write_plugin_state("delegation", {"mode": "bogus"}, opts)
    assert read_delegation_mode(opts) == "full"
    assert read_delegation_mode(StateOptions(env={"ODD_CLAUDE_HOME": str(tmp_path / "h")})) == "full"
    assert read_delegation_mode(StateOptions(data_dir="relative/dir")) == "full"


def test_write_delegation_mode_stores_and_an_invalid_mode_keeps_the_stored_value(opts):
    assert write_delegation_mode("organic", opts) == "organic"
    assert read_delegation_mode(opts) == "organic"
    assert write_delegation_mode("full", opts) == "full"
    assert read_delegation_mode(opts) == "full"
    write_delegation_mode("organic", opts)
    path = os.path.join(opts.data_dir, "delegation.json")
    before = open(path).read()
    with pytest.raises(ValueError) as e:
        write_delegation_mode("sometimes", opts)
    assert str(e.value) == 'invalid delegation mode "sometimes"; available modes: organic, full'
    assert open(path).read() == before
    assert json.loads(before) == {"version": 1, "sessionId": "delegation", "data": {"mode": "organic"}}


def test_context_states_the_active_mode_and_the_rule_wording():
    on = ctx("full")
    assert "Coordinator mode: ON" in on and "always-loaded rule `odd-delegation`" in on
    assert not re.search(r"cards|\.md", on)
    assert "rule you follow; no hook blocks edits" in on
    assert not re.search(r"denies|blocked by the harness|enforced by", on, re.I)
    off = ctx()
    assert "Coordinator mode: OFF" in off and "odd-delegation" not in off
