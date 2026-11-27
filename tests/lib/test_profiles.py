import os
import re

import pytest

from odd_claude.lib.profiles import (
    PRESET_NAMES,
    PRESETS,
    PROFILE_ROLES,
    RoleRoute,
    clear_profile,
    profile_context_line,
    read_profile,
    render_preset_list,
    render_profiles,
    set_role,
    use_profile,
)
from odd_claude.lib.state import StateOptions, read_plugin_state, write_plugin_state

# S1: the user's table (all effort medium).
TABLE = {
    "review-refuter": "opus", "review-validator": "opus", "odd-jd-judge-a": "opus", "odd-jd-judge-b": "sonnet",
    "odd-jd-fix": "sonnet", "odd-explore": "haiku", "odd-verify": "opus", "odd-plan-check": "sonnet", "odd-worker": "sonnet",
    "odd-review-readability": "sonnet", "odd-review-reliability": "sonnet", "odd-review-resilience": "sonnet", "odd-review-risk": "opus",
}  # fmt: skip
BALANCED = {k: RoleRoute(model=m, effort="medium") for k, m in TABLE.items()}


@pytest.fixture
def home_opts(tmp_path):
    """No explicit data dir: resolves through the environment, isolated from the real home."""
    return StateOptions(env={"ODD_CLAUDE_HOME": str(tmp_path / "home")})


def route(model, effort=None):
    return RoleRoute(model=model, effort=effort)


def test_presets_cover_every_agent_with_a_whitelisted_model_and_effort():
    assert PRESET_NAMES == ("balanced", "economy", "max")
    assert sorted(PROFILE_ROLES) == [
        "odd-explore", "odd-jd-fix", "odd-jd-judge-a", "odd-jd-judge-b", "odd-plan-check", "odd-review-readability",
        "odd-review-reliability", "odd-review-resilience", "odd-review-risk", "odd-verify", "odd-worker",
    ]  # fmt: skip


def test_s1_balanced_preset_is_exactly_the_users_table():
    assert PRESETS["balanced"] == BALANCED
    assert PRESET_NAMES == ("balanced", "economy", "max")


def test_s1_economy_and_max_keep_routes_and_mirror_judges_for_native_roles():
    assert PRESETS["economy"]["review-refuter"] == route("sonnet", "medium")
    assert PRESETS["economy"]["review-validator"] == route("sonnet", "medium")
    assert PRESETS["max"]["review-refuter"] == route("opus", "xhigh")
    assert PRESETS["max"]["review-validator"] == route("opus", "xhigh")
    assert PRESETS["economy"]["odd-explore"] == route("haiku", "low")
    assert PRESETS["economy"]["odd-jd-judge-a"] == route("sonnet", "medium")
    assert PRESETS["max"]["odd-worker"] == route("opus", "high")
    assert PRESETS["max"]["odd-explore"] == route("haiku", "medium")


def test_every_preset_routes_explore_to_haiku():
    for name in PRESET_NAMES:
        assert PRESETS[name]["odd-explore"].model == "haiku", name


def test_s2_no_stored_profile_is_balanced_and_the_context_line_is_present(opts, home_opts):
    for o in (opts, home_opts):
        p = read_profile(o)
        assert (p.active, p.routing) == ("balanced", BALANCED)
    line = profile_context_line(opts)
    assert "Model profile: balanced" in line
    assert "odd-explore=haiku" in line
    assert "odd-review-risk=opus" in line
    assert "review-refuter" not in line and "review-validator" not in line
    assert len(re.findall(r"(?<![\w:-])odd-[a-z-]+=", line)) == len(PROFILE_ROLES)
    assert not os.path.exists(os.path.join(opts.data_dir, "profiles.json"))


def test_s2_default_routing_is_a_copy(home_opts):
    p = read_profile(home_opts)
    p.routing["odd-worker"].model = "haiku"
    assert read_profile(home_opts).routing["odd-worker"].model == "sonnet"
    assert PRESETS["balanced"]["odd-worker"].model == "sonnet"


def test_use_stores_the_preset_routing(opts):
    use_profile("economy", opts)
    eco = read_profile(opts)
    assert eco.active == "economy" and eco.routing["odd-explore"].model == "haiku"
    use_profile("max", opts)
    mx = read_profile(opts)
    assert mx.routing["odd-worker"].model == "opus" and mx.routing["odd-explore"].model == "haiku"


def test_use_rejects_unknown_names_without_touching_the_stored_profile(opts):
    use_profile("balanced", opts)
    path = os.path.join(opts.data_dir, "profiles.json")
    before = open(path).read()
    for bad in ["", "nope", "balanced; rm", "../x", "__proto__", "constructor", "custom"]:
        with pytest.raises(ValueError, match="invalid profile"):
            use_profile(bad, opts)
    assert open(path).read() == before


def test_use_error_message_is_exact(opts):
    with pytest.raises(ValueError) as e:
        use_profile("nope", opts)
    assert str(e.value) == 'invalid profile "nope"; available profiles: balanced, economy, max'


def test_set_edits_one_role_marks_custom_and_validates(opts):
    use_profile("balanced", opts)
    set_role("odd-worker", "opus", "high", opts)
    p = read_profile(opts)
    assert p.active == "custom"
    assert p.routing["odd-worker"] == route("opus", "high")
    assert p.routing["odd-explore"].model == "haiku"
    path = os.path.join(opts.data_dir, "profiles.json")
    before = open(path).read()
    with pytest.raises(ValueError, match="invalid role"):
        set_role("odd-evil", "opus", None, opts)
    with pytest.raises(ValueError, match="invalid model"):
        set_role("odd-worker", "gpt-9", None, opts)
    with pytest.raises(ValueError, match="invalid effort"):
        set_role("odd-worker", "opus", "turbo", opts)
    with pytest.raises(ValueError, match="invalid role"):
        set_role("constructor", "opus", None, opts)
    assert open(path).read() == before


def test_s2_clear_returns_to_the_default_balanced_profile(opts):
    use_profile("max", opts)
    clear_profile(opts)
    assert read_profile(opts).routing == BALANCED and read_profile(opts).active == "balanced"
    assert read_plugin_state("profiles", opts) == {}


def test_s2_corrupt_or_unknown_state_reads_as_balanced_and_invalid_custom_entries_fall_back(opts):
    path = os.path.join(opts.data_dir, "profiles.json")
    os.makedirs(opts.data_dir)
    for raw in ["{{{", "", "null", "[]"]:
        open(path, "w").write(raw)
        assert read_profile(opts).routing == BALANCED
    for data in [{}, {"active": "turbo", "routing": {"odd-worker": {"model": "opus"}}}, {"active": 5, "routing": "x"}, {"active": None}]:
        write_plugin_state("profiles", data, opts)
        p = read_profile(opts)
        assert (p.active, p.routing) == ("balanced", BALANCED)
    write_plugin_state(
        "profiles",
        {"active": "custom", "routing": {"odd-worker": {"model": "opus", "effort": "zzz"}, "odd-x": {"model": "opus"}, "odd-verify": {"model": "evil\nmodel"}}},
        opts,
    )
    p = read_profile(opts)
    assert p.active == "custom"
    assert p.routing["odd-worker"] == route("opus")
    assert p.routing["odd-verify"] == BALANCED["odd-verify"]
    assert "odd-x" not in p.routing


def test_explicitly_stored_economy_max_custom_still_wins(opts):
    use_profile("economy", opts)
    assert read_profile(opts).active == "economy"
    assert read_profile(opts).routing["review-refuter"].model == "sonnet"
    set_role("odd-worker", "opus", None, opts)
    p = read_profile(opts)
    assert p.active == "custom"
    assert p.routing["odd-jd-judge-a"].model == "sonnet"
    assert p.routing["odd-worker"] == route("opus")


def test_s2_set_on_the_default_profile_starts_from_balanced(opts):
    set_role("odd-worker", "opus", "high", opts)
    p = read_profile(opts)
    assert p.active == "custom"
    assert p.routing["odd-worker"] == route("opus", "high")
    assert p.routing["odd-explore"] == BALANCED["odd-explore"]


def test_stored_routing_omits_an_absent_effort_and_keeps_preset_order(opts):
    set_role("odd-worker", "opus", None, opts)
    stored = read_plugin_state("profiles", opts)
    assert stored["active"] == "custom"
    assert stored["routing"]["odd-worker"] == {"model": "opus"}
    assert list(stored["routing"])[:3] == ["odd-explore", "odd-worker", "odd-verify"]


def test_render_profiles_shows_the_whole_balanced_table(home_opts):
    text = render_profiles(read_profile(home_opts))
    assert text.startswith("active: balanced")
    for role, model in TABLE.items():
        assert re.search(rf"{role}\s+{model}\s+medium", text)


def test_context_line_lists_the_active_profile_and_tells_the_orchestrator_to_pass_model(opts):
    use_profile("economy", opts)
    line = profile_context_line(opts)
    assert "Model profile: economy" in line and "`model`" in line and "odd-explore=haiku" in line
    assert line.endswith("`/odd-profiles` shows or changes it.")


def test_s2_default_context_line_marks_default(opts):
    assert profile_context_line(opts).startswith("Model profile: balanced (default). When you call the Agent tool")


def test_use_set_clear_show_sequence_through_the_lib(opts):
    # lib-level equivalent of v9's profilesCli test (the CLI itself is ported in Phase 5)
    assert "balanced" in render_preset_list("balanced") and "economy" in render_preset_list("balanced")
    assert re.search(r"active: balanced[\s\S]*review-refuter\s+opus\s+medium", render_profiles(read_profile(opts)))
    use_profile("economy", opts)
    assert re.search(r"active: economy[\s\S]*odd-explore\s+haiku", render_profiles(read_profile(opts)))
    set_role("odd-worker", "opus", "high", opts)
    assert "active: custom" in render_profiles(read_profile(opts))
    clear_profile(opts)
    assert "active: balanced" in render_profiles(read_profile(opts))
    assert render_preset_list("custom").endswith("\n* custom")


def test_a3_preset_list_shows_both_judges():
    lines = render_preset_list("balanced").split("\n")
    assert "judges=opus/sonnet (default)" in lines[0] and lines[0].startswith("* balanced ")
    assert "judges=sonnet/sonnet" in lines[1] and lines[1].startswith("  economy   ")
    assert "judges=opus/opus" in lines[2]
