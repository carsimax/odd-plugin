"""Port of v9 cli/review-mode.spec.ts (3 `test(` calls) plus differential cases: the Python CLI (`python -m odd_claude.cli.review_mode`)
against `node dist/cli/review-mode.js` on the same argv sequence (exit code, stdout, stderr and the files written). Real temp git repos under
tmp_path; HOME and the data dir are sandboxed."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from odd_claude.cli.review_mode import USAGE, review_mode_cli

from review.conftest import REPO_ROOT

V9_CLI = REPO_ROOT / "plugins" / "odd-claude" / "dist" / "cli" / "review-mode.js"
needs_v9_cli = pytest.mark.skipif(shutil.which("node") is None or not V9_CLI.is_file(), reason="node or plugins/odd-claude/dist/cli/review-mode.js missing")


def clean_env() -> dict:
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_") and k not in ("CLAUDE_PLUGIN_DATA", "ODD_CLAUDE_DATA", "ODD_CLAUDE_HOME", "CLAUDE_PLUGIN_ROOT")}
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    return env


class Fx:
    def __init__(self, base: Path):
        self.dir = os.path.realpath(base)
        self.repo = os.path.join(self.dir, "repo")
        os.mkdir(self.repo)
        self.data = os.path.join(self.dir, "data")
        assert subprocess.run(["git", "-C", self.repo, "init", "-q", "-b", "main"], env=clean_env()).returncode == 0


@pytest.fixture
def fx(tmp_path):
    return Fx(tmp_path)


@pytest.fixture(autouse=True)
def sandbox_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    for k in ("CLAUDE_PLUGIN_DATA", "ODD_CLAUDE_DATA", "ODD_CLAUDE_HOME"):
        monkeypatch.delenv(k, raising=False)


def cli(argv, env=None, cwd=None):
    return review_mode_cli(argv, {} if env is None else env, cwd)


def test_status_defaults_to_off_is_read_only_and_names_both_sources(fx):
    r = cli(["status", "--cwd", fx.repo, "--data-dir", fx.data])
    assert r.exit_code == 0
    assert r.stderr == ""
    assert "review-driven development: off (decided by default)" in r.stdout
    import re

    assert re.search(r"global:\s+unset", r.stdout)
    assert re.search(r"clone-local:\s+unset", r.stdout)
    assert not os.path.exists(fx.data)
    assert cli([], {"CLAUDE_PLUGIN_DATA": fx.data}).exit_code == 2  # a verb is required


def test_enable_disable_per_scope_json_and_the_clone_note_when_the_global_switch_decides(fx):
    on = cli(["enable", "--cwd", fx.repo, "--data-dir", fx.data])
    assert on.exit_code == 0
    assert "review-driven development: on (decided by global)" in on.stdout
    clone_off = cli(["disable", "--scope", "clone", "--cwd", fx.repo, "--data-dir", fx.data])
    assert "off (decided by clone-local)" in clone_off.stdout
    j = cli(["status", "--json", "--cwd", fx.repo, "--data-dir", fx.data])
    assert json.loads(j.stdout) == {
        "schema": "odd-claude.review-mode/v1", "operation": "status", "scope": "both",
        "status": {"effective": "off", "source": "clone-local", "global": "on", "cloneLocal": "off", "problems": []},
    }
    assert j.stdout == '{"schema":"odd-claude.review-mode/v1","operation":"status","scope":"both","status":{"global":"on","cloneLocal":"off","problems":[],"effective":"off","source":"clone-local"}}'
    cleared = cli(["enable", "--scope", "clone", "--cwd", fx.repo, "--data-dir", fx.data])
    assert "on (decided by global)" in cleared.stdout
    cli(["disable", "--data-dir", fx.data])
    note = cli(["enable", "--scope", "clone", "--cwd", fx.repo, "--data-dir", fx.data])
    assert "off (decided by global)" in note.stdout
    assert "can only disable" in note.stdout


@pytest.mark.parametrize("argv", [["bogus"], ["enable", "--scope", "weird"], ["enable", "--scope"], ["enable", "--nope"], ["enable", "extra", "more"]])
def test_usage_errors_exit_2_and_write_nothing(fx, argv):
    r = cli([*argv, "--data-dir", fx.data])
    assert r.exit_code == 2, " ".join(argv)
    assert r.stdout == ""
    assert "usage" in r.stderr
    assert r.stderr.endswith(USAGE)
    assert r.stderr.startswith("error: ")
    assert not os.path.exists(fx.data)


def test_a_failing_write_exits_1(fx):
    no_repo = cli(["disable", "--scope", "clone", "--cwd", os.path.join(fx.repo, "..", "nowhere"), "--data-dir", fx.data])
    assert no_repo.exit_code == 1
    assert no_repo.stdout == ""
    assert no_repo.stderr.startswith("error: clone scope needs a git repository: ")
    assert not os.path.exists(fx.data)


def test_usage_messages_are_exact(fx):
    assert cli([]).stderr == f"error: a verb is required\n{USAGE}"
    assert cli(["bogus"]).stderr == f'error: unknown verb "bogus"\n{USAGE}'
    assert cli(["enable", "--scope", "weird"]).stderr == f'error: unknown scope "weird"\n{USAGE}'
    assert cli(["enable", "--scope"]).stderr == f"error: --scope needs a value\n{USAGE}"
    assert cli(["enable", "--cwd", "--json"]).stderr == f"error: --cwd needs a value\n{USAGE}"
    assert cli(["enable", "--data-dir", ""]).stderr == f"error: --data-dir needs a value\n{USAGE}"
    assert cli(["enable", "--nope"]).stderr == f"error: unknown argument --nope\n{USAGE}"
    assert cli(["enable", "a", "b"]).stderr == f"error: unexpected argument a\n{USAGE}"
    assert cli(["status", "--scope", "global"]).stderr == f"error: status reads both scopes; do not pass --scope\n{USAGE}"
    assert USAGE == "usage: review-mode.js <enable|disable|status> [--scope global|clone] [--cwd <repo>] [--data-dir <dir>] [--json]"


def test_the_working_directory_defaults_to_the_process_cwd_and_env_data_dir_is_honoured(fx, monkeypatch):
    monkeypatch.chdir(fx.repo)
    r = cli(["enable"], {"ODD_CLAUDE_DATA": fx.data})
    assert r.exit_code == 0 and "on (decided by global)" in r.stdout
    assert cli(["status"], {"ODD_CLAUDE_DATA": fx.data}).stdout.startswith("review-driven development: on (decided by global)")
    assert cli(["status", "--cwd", fx.repo], {"ODD_CLAUDE_DATA": fx.dir + "/other"}).stdout.startswith("review-driven development: off")


# ---- differential against v9 ----


def run_cli(impl, argv, env):
    cmd = ["node", str(V9_CLI)] if impl == "v9" else [sys.executable, "-m", "odd_claude.cli.review_mode"]
    r = subprocess.run([*cmd, *argv], capture_output=True, text=True, env=env, timeout=60)
    return r.returncode, r.stdout, r.stderr


def tree(root: Path) -> dict:
    out = {}
    for p in sorted(Path(root).rglob("*")):
        if p.is_file() and ".git/" not in str(p) or p.name == "review-mode.json":
            out[str(p.relative_to(root))] = p.read_text()
    return out


SEQUENCES = {
    "status-fresh": [["status"], ["status", "--json"]],
    "global-on-off": [["enable"], ["status"], ["disable"], ["status", "--json"], ["enable", "--json"]],
    "clone-cycle": [["disable", "--scope", "clone"], ["status"], ["enable", "--scope", "clone", "--json"], ["enable"], ["disable", "--scope", "clone"], ["status", "--json"], ["enable", "--scope", "clone"], ["disable"], ["enable", "--scope", "clone"]],
    "usage": [[], ["bogus"], ["enable", "--scope"], ["enable", "--scope", "weird"], ["enable", "--nope"], ["enable", "a", "b"], ["status", "--scope", "clone"], ["--json"], ["enable", "--cwd", "--json"], ["enable", "--data-dir"]],
    "not-a-repo": [["disable", "--scope", "clone", "--cwd", "@NOWHERE@"], ["status", "--cwd", "@NOWHERE@"], ["enable", "--scope", "clone", "--cwd", "@NOWHERE@"]],
}


@needs_v9_cli
@pytest.mark.parametrize("name", list(SEQUENCES))
def test_diff_the_same_argv_sequence_gives_the_same_exit_stdout_stderr_and_files(name, tmp_path):
    results = {}
    for impl in ("v9", "py"):
        base = tmp_path / impl
        base.mkdir()
        f = Fx(base)
        home = base / "home"
        home.mkdir()
        env = {**clean_env(), "HOME": str(home), "ODD_CLAUDE_DATA": f.data}
        steps = []
        for argv in SEQUENCES[name]:
            a = [x.replace("@NOWHERE@", os.path.join(f.dir, "nowhere")) for x in argv]
            if "--cwd" not in a:
                a += ["--cwd", f.repo]
            code, out, err = run_cli(impl, a, env)
            steps.append((a, code, out.replace(f.dir, "<S>"), err.replace(f.dir, "<S>")))
        results[impl] = (steps, tree(Path(f.data)), tree(Path(f.repo) / ".git" / "odd-plugin") if (Path(f.repo) / ".git" / "odd-plugin").exists() else {})
    norm = lambda r: ([(" ".join(a).replace(str(tmp_path / "v9"), "").replace(str(tmp_path / "py"), ""), c, o, e) for a, c, o, e in r[0]], r[1], r[2])  # noqa: E731
    assert norm(results["py"]) == norm(results["v9"])


@needs_v9_cli
def test_diff_a_failing_global_write_exits_1_with_the_same_prefix_the_os_error_text_follows_the_runtime(tmp_path):
    """`ReviewModeError` wraps the OS error: both CLIs exit 1 with `error: cannot write the global review mode: ` and then the runtime's own
    text (node: `EEXIST...`/`ENOTDIR...`; Python: `[Errno 17] ...`). No contract test asserts that tail (grep of contract/*.spec.ts), so the
    prefix is the contract; the tail is documented as a runtime-specific divergence."""
    results = {}
    for impl in ("v9", "py"):
        base = tmp_path / impl
        base.mkdir()
        f = Fx(base)
        Path(f.data).write_text("a regular file where the data dir should be")
        env = {**clean_env(), "HOME": str(base), "ODD_CLAUDE_DATA": f.data}
        results[impl] = run_cli(impl, ["enable", "--cwd", f.repo], env)
    for impl, (code, out, err) in results.items():
        assert code == 1 and out == "", impl
        assert err.startswith("error: cannot write the global review mode: "), (impl, err)
