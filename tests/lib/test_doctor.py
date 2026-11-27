import re

from odd_claude.lib.doctor import DoctorDeps, collect_doctor, parse_version, python_satisfies, render_doctor

PRESENT = {"uv": "uv 0.13.5 (Homebrew)", "git": "git version 2.40.1", "engram": "engram 3.7.0", "codegraph": "1.6.2"}


def deps(present=None, **over) -> DoctorDeps:
    p = PRESENT if present is None else present
    d = dict(
        exec=lambda cmd, args: p.get(cmd),
        env={"CLAUDE_PLUGIN_DATA": "/data/odd"},
        python_version="3.14.1",
        version="0.1.0",
        installed_plugins=lambda: ["engram@engram"],
        installed_version=lambda: "0.1.0",
        hooks_installed=lambda: True,
        is_writable=lambda _: True,
    )
    return DoctorDeps(**{**d, **over})


def by_id(r, id):
    return next(i for i in r.items if i.id == id)


def test_parse_version_extracts_the_first_semver_and_python_satisfies_enforces_the_minimum():
    assert parse_version("git version 2.40.1 (Apple)") == "2.40.1"
    assert parse_version("no digits") is None
    assert python_satisfies("3.14.0") and python_satisfies("v3.15.2") and python_satisfies("4.0.0")
    assert not python_satisfies("3.13.9") and not python_satisfies("2.7.18") and not python_satisfies("garbage")


def test_all_present_every_item_ok_nothing_missing():
    r = collect_doctor(deps())
    assert [(i.id, i.status) for i in r.items] == [
        ("python", "ok"), ("uv", "ok"), ("git", "ok"), ("engram", "ok"), ("codegraph", "ok"), ("install", "ok"), ("hooks", "ok"), ("data-dir", "ok"),
    ]
    assert r.missing == [] and r.requiredMissing == [] and r.ok is True
    text = render_doctor(r)
    assert re.search(r"^missing: none$", text, re.M)
    assert re.search(r"git .*2\.40\.1", text)
    assert re.search(r"^odd-claude doctor \(v0\.1\.0\)$", text, re.M)


def test_s5_python_and_uv_replace_node_and_both_are_required():
    r = collect_doctor(deps())
    assert "node" not in [i.id for i in r.items] and "node" not in render_doctor(r)
    py, uv = by_id(r, "python"), by_id(r, "uv")
    assert (py.label, py.required, py.detail) == ("python", True, "3.14.1 (need >=3.14)")
    assert (uv.label, uv.required, uv.detail) == ("uv", True, "0.13.5")
    assert by_id(r, "git").required is True
    assert [i.required for i in r.items if i.id in ("engram", "codegraph", "install", "hooks", "data-dir")] == [False] * 5


def test_s5_missing_required_python_uv_git_makes_the_report_not_ok():
    r = collect_doctor(deps(present={}, python_version="3.13.0", installed_plugins=lambda: []))
    assert r.requiredMissing == ["python", "uv", "git"]
    assert r.ok is False
    assert by_id(r, "uv").detail == "not found on PATH"
    assert by_id(r, "python").detail == "3.13.0 (need >=3.14)"
    assert re.search(r"^missing: python, uv, git, engram, codegraph$", render_doctor(r), re.M)
    only_uv = collect_doctor(deps(present={k: v for k, v in PRESENT.items() if k != "uv"}))
    assert only_uv.requiredMissing == ["uv"] and only_uv.ok is False
    assert by_id(collect_doctor(deps(present={**PRESENT, "uv": "uv"})), "uv").detail == "unknown version"


def test_install_reports_the_installed_version_missing_install_or_hooks_are_optional_and_keep_ok():
    ok = collect_doctor(deps(installed_version=lambda: "6.0.0"))
    assert "6.0.0" in by_id(ok, "install").detail
    none = collect_doctor(deps(installed_version=lambda: None, hooks_installed=lambda: False))
    assert [by_id(none, "install").status, by_id(none, "install").required, by_id(none, "hooks").status, by_id(none, "hooks").required] == ["missing", False, "missing", False]
    assert "odd-claude install" in by_id(none, "install").detail
    assert none.missing == ["install", "hooks"] and none.ok is True
    assert by_id(collect_doctor(deps(hooks_installed=lambda: None)), "hooks").status == "missing"


def test_missing_optional_engram_codegraph_listed_but_report_stays_ok():
    r = collect_doctor(deps(present={"git": "git version 2.40.1", "uv": "uv 0.13.5"}, installed_plugins=lambda: []))
    assert r.missing == ["engram", "codegraph"] and r.requiredMissing == [] and r.ok is True
    assert re.search(r"^missing: engram, codegraph$", render_doctor(r), re.M)


def test_engram_counts_as_present_with_only_the_plugin_or_only_the_binary():
    only_plugin = collect_doctor(deps(present={"git": "git version 2", "uv": "uv 1.0.0"}))
    assert by_id(only_plugin, "engram").status == "ok" and by_id(only_plugin, "engram").detail == "plugin engram@engram"
    only_bin = collect_doctor(deps(installed_plugins=lambda: None))
    assert by_id(only_bin, "engram").status == "ok" and by_id(only_bin, "engram").detail == "binary 3.7.0"


def test_data_dir_resolved_through_the_shared_order_and_non_writable_is_optional():
    unset = collect_doctor(deps(env={"ODD_CLAUDE_HOME": "/h/odd"}))
    assert by_id(unset, "data-dir").status == "ok" and "/h/odd/data" in by_id(unset, "data-dir").detail
    via_env = collect_doctor(deps(env={"ODD_CLAUDE_DATA": "/x/d", "CLAUDE_PLUGIN_DATA": "/y/d"}))
    assert "/x/d" in by_id(via_env, "data-dir").detail
    ro = collect_doctor(deps(is_writable=lambda _: False))
    assert by_id(ro, "data-dir").status == "missing" and by_id(ro, "data-dir").detail == "/data/odd (not writable)"
    assert ro.ok is True


def test_json_shape_matches_v9_output_schema_1():
    j = collect_doctor(deps(present={"git": "git version 2", "uv": "uv 0.13.5"}, installed_plugins=lambda: [])).to_json_dict()
    assert sorted(j) == ["items", "missing", "ok", "requiredMissing", "schema", "version"]
    assert j["schema"] == 1 and j["missing"] == ["engram", "codegraph"]
    assert sorted(j["items"][0]) == ["detail", "id", "label", "required", "status"]


def test_exit_status_rule_required_missing_decides_and_the_list_is_never_hidden():
    # lib-level equivalent of v9's doctorCli exit-code tests (the CLI is ported in Phase 5)
    bad = collect_doctor(deps(present={}, installed_plugins=lambda: []))
    assert bad.ok is False
    assert re.search(r"^missing: uv, git, engram, codegraph$", render_doctor(bad), re.M)
    assert collect_doctor(deps()).ok is True


def test_data_dir_probe_receives_the_resolved_dir():
    seen: list[str] = []
    collect_doctor(deps(env={"ODD_CLAUDE_DATA": "/x/y"}, is_writable=lambda d: (seen.append(d), True)[1]))
    assert seen == ["/x/y"]
