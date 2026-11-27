"""S7: differential tests of `odd_claude.lib.system` against the compiled v9 `dist/lib/system.js`.

`run_main` is process-identity based in v9 (meta-url vs argv[1]) and `__name__ == "__main__"` in Python: only the observable
contract (output, exit code, nothing happens on import) is compared.
"""
import json
import os
import subprocess
import sys

import pytest

from odd_claude.lib import system as py
from .conftest import SRC
from .v9_oracle import DIST_LIB, needs_v9, v9, v9_many

pytestmark = needs_v9


def _sh(script: str) -> list:
    return ["sh", "-c", script]


EXEC_CASES = [
    ("echo", ["hi"]),
    ("sh", _sh("printf 'a\\r\\nb  \\n\\n'")),
    ("sh", _sh("printf out; printf err >&2")),
    ("sh", _sh("printf 'only-err' >&2")),
    ("sh", _sh("printf out; exit 3")),
    ("sh", _sh("kill -9 $$")),
    ("definitely-not-a-command-xyz", []),
    ("sh", _sh("printf '\\302\\240x\\302\\240'")),  # NBSP trims in JS
    ("sh", _sh("printf '\\357\\273\\277x\\357\\273\\277'")),  # BOM trims in JS
    ("sh", _sh("printf '\\342\\200\\250x\\342\\200\\251'")),  # U+2028/2029 trim
    ("sh", _sh("printf '\\343\\200\\200x\\343\\200\\200'")),  # U+3000 trims
    ("sh", _sh("printf '\\037x\\037'")),  # \x1f does not trim in JS
    ("sh", _sh("printf '\\302\\205x\\302\\205'")),  # \x85 does not trim in JS
    ("sh", _sh("printf '\\013x\\014'")),
    ("sh", _sh("printf 'x\\377y'")),  # invalid UTF-8
    ("sh", _sh("printf 'x\\342\\202y'")),  # truncated sequence
    ("sh", _sh("printf '\\360\\237\\230\\200 \\303\\251\\321\\204'")),  # astral, e-acute, Cyrillic
    ("sh", _sh("printf ''")),
    ("sh", _sh("head -c 1048576 /dev/zero | tr '\\0' a")),  # maxBuffer boundary
    ("sh", _sh("head -c 1048577 /dev/zero | tr '\\0' a")),
    ("sh", _sh("head -c 1048577 /dev/zero | tr '\\0' a >&2")),
    ("sh", _sh("head -c 600000 /dev/zero | tr '\\0' a; head -c 600000 /dev/zero | tr '\\0' b >&2")),
    ("sh", _sh("cat")),  # stdin is closed
]


def test_real_exec_matches_v9():
    assert v9_many("system", "realExec", [[c, a] for c, a in EXEC_CASES]) == [py.real_exec(c, a) for c, a in EXEC_CASES]


def test_real_exec_timeout_matches_v9():
    assert v9("system", "realExec", "sleep", ["7"]) is None
    assert py.real_exec("sleep", ["7"]) is None


def test_real_is_writable_matches_v9(tmp_path):
    ro = tmp_path / "ro"
    ro.mkdir()
    ro.chmod(0o500)
    f = tmp_path / "file"
    f.write_text("x")
    link = tmp_path / "link"
    link.symlink_to(tmp_path / "missing")
    dirs = [
        str(tmp_path), str(tmp_path / "new" / "deep" / "er"), str(ro), str(ro / "new"), str(f), str(f / "x"), "/", "/nonexistent-zz/a/b",
        str(link), str(link / "x"), str(tmp_path) + "/", str(tmp_path / "é ñ" / "\U0001f600"), "", "relative/dir", ".", "/etc", "/etc/passwd/x",
    ]
    try:
        assert v9_many("system", "realIsWritable", [[d] for d in dirs]) == [py.real_is_writable(d) for d in dirs]
    finally:
        ro.chmod(0o700)


def _write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


PLUGINS_FILES = [
    None,  # absent
    "",
    "not json",
    "null",
    "[]",
    "5",
    '"str"',
    "{}",
    '{"plugins": null}',
    '{"plugins": {}}',
    '{"plugins": {"a@m": 1, "b@m": {"x": 1}}}',
    '{"plugins": {"b": 1, "2": 1, "a": 1, "1": 1, "01": 1, "4294967294": 1, "4294967295": 1, "-1": 1, "1.5": 1}}',
    '{"plugins": {"a": 1, "a": 2, "0": 1, "a": 3}}',
    '{"plugins": {"__proto__": 1, "constructor": 2}}',
    '{"plugins": []}',
    '{"plugins": ["x", "y"]}',
    '{"plugins": "ab"}',
    '{"plugins": "\\ud83d\\ude00"}',
    '{"plugins": ""}',
    '{"plugins": 0}',
    '{"plugins": 5}',
    '{"plugins": true}',
    '{"plugins": false}',
    '{"plugins": {"\\u00e9": 1, "\\ud83d\\ude00": 2, "\\u00f1": 3}}',
    '\ufeff{"plugins": {"a": 1}}',
    '{"plugins": {"a": NaN}}',
    '{"plugins": {"a": 1}} trailing',
    '{"plugins": {"a": 1},}',
    "  \n\t\r{\"plugins\": {\"a\": 1}}\n",
    "\u00a0{\"plugins\": {\"a\": 1}}",
    '{"plugins": {"a": 1e999}}',
    "{'plugins': {}}",
    '{"plugins": {"a": "\\ud800"}}',
]


def _cfg_env(tmp_path, name, **extra):
    return {"HOME": str(tmp_path / "home"), **extra}


def _env_read(tmp_path, monkeypatch, fn_js, fn_py, files, rel, extra_env=None):
    """Writes each file variant under its own config dir and compares both sides."""
    cases = []
    for i, content in enumerate(files):
        cfg = tmp_path / f"cfg{i}"
        cfg.mkdir()
        if content is not None:
            _write(cfg / rel, content)
        cases.append({"CLAUDE_CONFIG_DIR": str(cfg)})
    got = v9_many("system", fn_js, [[e] for e in cases], env={"HOME": str(tmp_path / "home")})
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    want = [fn_py(e) for e in cases]
    assert got == want


def test_real_installed_plugins_matches_v9(tmp_path, monkeypatch):
    _env_read(tmp_path, monkeypatch, "realInstalledPlugins", py.real_installed_plugins, PLUGINS_FILES, "plugins/installed_plugins.json")


def test_real_installed_plugins_config_dir_resolution(tmp_path, monkeypatch):
    home = tmp_path / "home"
    _write(home / ".claude" / "plugins" / "installed_plugins.json", '{"plugins": {"home@m": 1}}')
    cfg = tmp_path / "cfg"
    _write(cfg / "plugins" / "installed_plugins.json", '{"plugins": {"cfg@m": 1}}')
    envs = [{}, {"CLAUDE_CONFIG_DIR": ""}, {"CLAUDE_CONFIG_DIR": str(cfg)}, {"CLAUDE_CONFIG_DIR": str(tmp_path / "none")}]
    got = v9_many("system", "realInstalledPlugins", [[e] for e in envs], env={"HOME": str(home)})
    monkeypatch.setenv("HOME", str(home))
    assert got == [py.real_installed_plugins(e) for e in envs]
    # default env argument: process.env / os.environ
    got = v9_many("system", "realInstalledPlugins", [[]], env={"HOME": str(home), "CLAUDE_CONFIG_DIR": str(cfg)})
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(cfg))
    assert got == [py.real_installed_plugins()]


def test_home_resolution_matches_v9(tmp_path, monkeypatch):
    for home in ["", str(tmp_path / "h") + "/", "relative-home", str(tmp_path / "é ñ")]:
        _write(__import__("pathlib").Path(home or ".") / ".claude" / "plugins" / "installed_plugins.json", '{"plugins": {"a": 1}}') if home and not home.startswith("relative") else None
    cwd = tmp_path / "cwd"
    _write(cwd / ".claude" / "plugins" / "installed_plugins.json", '{"plugins": {"rel": 1}}')
    _write(cwd / "relative-home" / ".claude" / "plugins" / "installed_plugins.json", '{"plugins": {"rel2": 1}}')
    for home in ["", str(tmp_path / "h") + "/", "relative-home", str(tmp_path / "é ñ")]:
        (tmp_path / "h").mkdir(exist_ok=True)
        _write(tmp_path / "h" / ".claude" / "plugins" / "installed_plugins.json", '{"plugins": {"h": 1}}')
        _write(tmp_path / "é ñ" / ".claude" / "plugins" / "installed_plugins.json", '{"plugins": {"u": 1}}')
        got = v9("system", "realInstalledPlugins", {}, env={"HOME": home, "CLAUDE_CONFIG_DIR": ""}, cwd=str(cwd))
        monkeypatch.setenv("HOME", home)
        monkeypatch.chdir(cwd)
        assert py.real_installed_plugins({}) == got, home


def _install(tmp_path, i, pkg, link=True, target_name="real"):
    home = tmp_path / f"odd{i}"
    target = home / target_name
    target.mkdir(parents=True)
    if pkg is not None:
        (target / "package.json").write_text(pkg, encoding="utf-8")
    if link:
        (home / "current").symlink_to(target)
    return {"ODD_CLAUDE_HOME": str(home)}


VERSION_PKGS = [
    '{"version": "1.2.3"}', '{"version": ""}', '{"version": 5}', '{"version": null}', "{}", "null", "[]", '"s"', "5", "not json", "",
    '{"version": "\\ud83d\\ude00é"}', '\ufeff{"version": "1"}', '{"version": ["1"]}', '{"version": "1", "version": "2"}', None,
]


def test_real_installed_version_matches_v9(tmp_path, monkeypatch):
    envs = [_install(tmp_path, i, p) for i, p in enumerate(VERSION_PKGS)]
    envs.append(_install(tmp_path, 99, '{"version": "9"}', link=False))  # `current` absent
    dangling = _install(tmp_path, 100, '{"version": "9"}')
    os.unlink(os.path.join(dangling["ODD_CLAUDE_HOME"], "current"))
    os.symlink(os.path.join(dangling["ODD_CLAUDE_HOME"], "gone"), os.path.join(dangling["ODD_CLAUDE_HOME"], "current"))
    envs += [dangling, {"ODD_CLAUDE_HOME": str(tmp_path / "missing")}, {"ODD_CLAUDE_HOME": ""}]
    got = v9_many("system", "realInstalledVersion", [[e] for e in envs], env={"HOME": str(tmp_path / "nohome")})
    monkeypatch.setenv("HOME", str(tmp_path / "nohome"))
    assert got == [py.real_installed_version(e) for e in envs]


HOOK_SETTINGS = [
    None, "", "not json", "null", "[]", "5", '"s"', "{}", '{"hooks": null}', '{"hooks": {}}',
    '{"hooks": {"Stop": [{"hooks": [{"command": "node /x/dist/hooks/run.js stop"}]}], "Other": [{"command": "echo"}]}}',
    '{"hooks": {"B": "/dist/hooks/run.js", "A": "/dist/hooks/run.jsx", "C": "/dist/hooks/runXjs", "2": "/dist/hooks/run.js", "1": "/dist/hooks/run.js"}}',
    '{"hooks": {"E": ["a/dist/hooks/run.js"], "F": {"command": "C:\\\\dist\\\\hooks\\\\run.js"}, "G": 5, "H": null, "I": true}}',
    '{"hooks": ["x/dist/hooks/run.js", "y"]}',
    '{"hooks": "ab/dist/hooks/run.js"}',
    '{"hooks": ""}', '{"hooks": 0}', '{"hooks": false}', '{"hooks": 5}', '{"hooks": true}', '{"hooks": []}',
    '{"hooks": {"\\u00e9": "/dist/hooks/run.js", "\\ud83d\\ude00": ["/dist/hooks/run.js"], "x": "\\u00e9/dist/hooks/run.js\\ud800"}}',
    '{"hooks": {"S": [{"c": "/dist/hooks/run.js"}], "T": [], "U": {}}}',
    '\ufeff{"hooks": {"S": "/dist/hooks/run.js"}}',
    '{"hooks": {"S": "\\n/dist/hooks/run.js\\t\\u0001"}}',
]


def test_real_hook_events_and_installed_match_v9(tmp_path, monkeypatch):
    cases = []
    for i, content in enumerate(HOOK_SETTINGS):
        cfg = tmp_path / f"cfg{i}"
        cfg.mkdir()
        if content is not None:
            _write(cfg / "settings.json", content)
        cases.append({"CLAUDE_CONFIG_DIR": str(cfg)})
    home = {"HOME": str(tmp_path / "home")}
    ev = v9_many("system", "realHookEvents", [[e] for e in cases], env=home)
    inst = v9_many("system", "realHooksInstalled", [[e] for e in cases], env=home)
    monkeypatch.setenv("HOME", home["HOME"])
    assert ev == [py.real_hook_events(e) for e in cases]
    assert inst == [py.real_hooks_installed(e) for e in cases]


ARGV_CASES = [
    ([], "--data-dir"), (["--data-dir"], "--data-dir"), (["--data-dir", ""], "--data-dir"), (["--data-dir", "x"], "--data-dir"),
    (["--data-dir", "--other"], "--data-dir"), (["--data-dir", "-x"], "--data-dir"), (["a", "--data-dir", "/p", "--data-dir", "/q"], "--data-dir"),
    (["--data-dir", "--data-dir", "z"], "--data-dir"), (["--data-dir", "é\U0001f600"], "--data-dir"), (["--data-dir", " "], "--data-dir"),
    (["--x", "1"], "--x"), (["--x", "1"], "--y"), (["--data-dir=x"], "--data-dir"), (["x"], ""), ([""], ""), (["--"], "--"), (["--", "a"], "--"),
]


def test_flag_value_matches_v9():
    assert v9_many("system", "flagValue", [[a, n] for a, n in ARGV_CASES]) == [py.flag_value(a, n) for a, n in ARGV_CASES]


ENV_CASES = [
    ([], {}), (["--data-dir", "/d"], {}), (["--data-dir", "/d"], {"ODD_CLAUDE_DATA": "/old", "A": "1"}), (["--data-dir"], {"ODD_CLAUDE_DATA": "/old"}),
    (["--data-dir", ""], {"A": "1"}), (["--data-dir", "--x"], {"A": "1"}), (["--data-dir", "é"], {"ODD_CLAUDE_DATA": None}), ([], {"A": None}),
]


def test_env_with_data_dir_matches_v9():
    assert v9_many("system", "envWithDataDir", [[a, e] for a, e in ENV_CASES]) == [py.env_with_data_dir(a, e) for a, e in ENV_CASES]


def test_env_with_data_dir_does_not_mutate_input():
    env = {"A": "1"}
    out = py.env_with_data_dir(["--data-dir", "/d"], env)
    assert env == {"A": "1"} and out is not env


def test_run_main_is_inert_when_not_the_entry():
    called = []

    def fn():
        called.append(1)
        return py.CliResult(stdout="x")

    # v9: the oracle process has no entry script, so the meta-url check fails and `fn` never runs.
    assert v9("system", "runMain", "file:///nonexistent/mod.js", None) is None
    assert py.run_main("some.module", fn) is None and called == []


RUN_CASES = [
    "CliResult(stdout='out')", "CliResult(stderr='err')", "CliResult(stdout='o', stderr='e', exit_code=2)", "CliResult()",
    "CliResult(stdout='', stderr='', exit_code=5)", "CliResult(stdout='é😀\\r\\n')", "boom('plain')", "boom('')",
]


def _py_runner(case: str) -> list:
    code = (
        "import sys\nfrom odd_claude.lib.system import CliResult, run_main\n"
        "def boom(m):\n    def f():\n        raise Exception(m)\n    return f\n"
        f"c = {case}\nsys.exit(run_main('__main__', c if callable(c) else (lambda: c)) or 0)\n"
    )
    return [sys.executable, "-c", code]


def _js_runner(case: str, tmp_path) -> list:
    js = {"CliResult(": "(", "exit_code": "exitCode"}
    expr = case
    for k, v in js.items():
        expr = expr.replace(k, v)
    expr = expr.replace("'", '"')
    if expr.startswith("boom("):
        arg = expr[5:-1]
        body = f"() => {{ throw new Error({arg}); }}"
    else:
        body = f"() => ({{{expr[1:-1].replace('=', ':')}}})"
    script = tmp_path / "run.mjs"
    script.write_text(
        f'import {{ runMain }} from {json.dumps((DIST_LIB / "system.js").as_uri())};\nrunMain(import.meta.url, {body});\n', encoding="utf-8"
    )
    return ["node", str(script)]


@pytest.mark.parametrize("case", RUN_CASES)
def test_run_main_entry_contract_matches_v9(case, tmp_path):
    env = {**os.environ, "PYTHONPATH": str(SRC)}
    a = subprocess.run(_js_runner(case, tmp_path), capture_output=True, env=env)
    b = subprocess.run(_py_runner(case), capture_output=True, env=env)
    assert (b.returncode, b.stdout, b.stderr) == (a.returncode, a.stdout, a.stderr)
