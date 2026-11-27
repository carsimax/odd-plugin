"""Port of v9 `lib/system.spec.ts` (1 test) plus the other probes of `system`."""
import json
import os

from odd_claude.lib.system import (
    CliResult,
    env_with_data_dir,
    flag_value,
    real_exec,
    real_hook_events,
    real_hooks_installed,
    real_installed_plugins,
    real_installed_version,
    real_is_writable,
    run_main,
)


def test_s22_real_installed_plugins_reads_installed_plugins_json(tmp_path):
    (tmp_path / "plugins").mkdir()
    (tmp_path / "plugins" / "installed_plugins.json").write_text(json.dumps({"plugins": {"a@b": []}}))
    assert real_installed_plugins({"CLAUDE_CONFIG_DIR": str(tmp_path)}) == ["a@b"]


def test_installed_plugins_unreadable_or_without_plugins_is_none(tmp_path):
    env = {"CLAUDE_CONFIG_DIR": str(tmp_path)}
    assert real_installed_plugins(env) is None
    (tmp_path / "plugins").mkdir()
    (tmp_path / "plugins" / "installed_plugins.json").write_text("{}")
    assert real_installed_plugins(env) is None
    (tmp_path / "plugins" / "installed_plugins.json").write_text("not json")
    assert real_installed_plugins(env) is None


def test_installed_version_follows_current(tmp_path):
    env = {"ODD_CLAUDE_HOME": str(tmp_path)}
    assert real_installed_version(env) is None
    (tmp_path / "v1").mkdir()
    (tmp_path / "v1" / "package.json").write_text(json.dumps({"version": "9.1.2"}))
    os.symlink(tmp_path / "v1", tmp_path / "current")
    assert real_installed_version(env) == "9.1.2"
    (tmp_path / "v1" / "package.json").write_text(json.dumps({"version": 3}))
    assert real_installed_version(env) is None


def test_hook_events_lists_events_running_run_js(tmp_path):
    env = {"CLAUDE_CONFIG_DIR": str(tmp_path)}
    assert real_hook_events(env) is None
    assert real_hooks_installed(env) is None
    hooks = {
        "SessionStart": [{"hooks": [{"command": "node /x/dist/hooks/run.js SessionStart"}]}],
        "Stop": [{"hooks": [{"command": "echo other"}]}],
    }
    (tmp_path / "settings.json").write_text(json.dumps({"hooks": hooks}))
    assert real_hook_events(env) == ["SessionStart"]
    assert real_hooks_installed(env) is True
    (tmp_path / "settings.json").write_text(json.dumps({}))
    assert real_hook_events(env) == []
    assert real_hooks_installed(env) is False


def test_real_exec_returns_trimmed_output_or_none():
    assert real_exec("sh", ["-c", "echo ' hi '"]) == "hi"
    assert real_exec("sh", ["-c", "echo err 1>&2; exit 0"]) == "err"
    assert real_exec("sh", ["-c", "exit 3"]) is None
    assert real_exec("definitely-not-a-command-xyz", []) is None


def test_real_is_writable_checks_nearest_existing_ancestor(tmp_path):
    assert real_is_writable(str(tmp_path)) is True
    assert real_is_writable(str(tmp_path / "a" / "b" / "c")) is True
    ro = tmp_path / "ro"
    ro.mkdir()
    ro.chmod(0o500)
    try:
        if os.geteuid() != 0:
            assert real_is_writable(str(ro / "new")) is False
    finally:
        ro.chmod(0o700)


def test_flag_value():
    assert flag_value(["--cwd", "/x"], "--cwd") == "/x"
    assert flag_value(["--cwd"], "--cwd") is None
    assert flag_value(["--cwd", ""], "--cwd") is None
    assert flag_value(["--cwd", "--json"], "--cwd") is None
    assert flag_value(["--json"], "--cwd") is None


def test_env_with_data_dir_pins_odd_claude_data():
    env = {"ODD_CLAUDE_DATA": "/old", "A": "1"}
    assert env_with_data_dir(["--data-dir", "/new"], env) == {"ODD_CLAUDE_DATA": "/new", "A": "1"}
    assert env_with_data_dir([], env) == env
    assert env == {"ODD_CLAUDE_DATA": "/old", "A": "1"}


def test_run_main_only_runs_for_the_entry_module(capsys):
    assert run_main("pkg.mod", lambda: CliResult(stdout="x")) is None
    assert capsys.readouterr().out == ""
    assert run_main("__main__", lambda: CliResult(exit_code=2, stdout="out", stderr="err")) == 2
    cap = capsys.readouterr()
    assert (cap.out, cap.err) == ("out\n", "err\n")


def test_run_main_reports_a_thrown_action_error(capsys):
    def boom():
        raise RuntimeError("bad")

    assert run_main("__main__", boom) == 1
    assert capsys.readouterr().err == "error: bad\n"
