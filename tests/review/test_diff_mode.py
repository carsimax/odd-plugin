"""Differential: review/mode against v9 dist/review/mode.js through the oracle, on real temp git repos and data dirs shared by both
sides for reads (same paths in every message) and on twin trees for writes (results and every file compared byte for byte, with
modes). Every exported function is compared: cloneModePath, isGlobalModeOn, readReviewMode, setReviewMode."""
import json
import os
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

import pytest

from lib.v9_oracle import DIST, needs_v9, v9, v9_many
from odd_claude.review import mode as M
from review.conftest import diff_cases, py_oracle_err
from review.test_mode import GIT_ENV, Fx, _fake_git

pytestmark = needs_v9
MOD = "review/mode"
ENVELOPE = lambda data, version=1: json.dumps({"version": version, "sessionId": "review-mode", "data": data})  # noqa: E731
OVERRIDE_OFF = json.dumps({"schema": M.CLONE_MODE_SCHEMA, "mode": "off"}) + "\n"


def opts_py(o: dict) -> M.ModeOptions:
    return M.ModeOptions(data_dir=o.get("dataDir"), env=o.get("env"), git_timeout_ms=o.get("gitTimeoutMs"))


def py_read(cwd, o=None):
    return M.read_review_mode(cwd, opts_py(o or {}))


def py_set(op, scope, cwd, o=None):
    return M.set_review_mode(op, scope, cwd, opts_py(o or {}))


def py_global(o=None):
    return M.is_global_mode_on(opts_py(o or {}))


@pytest.fixture
def fx(tmp_path):
    return Fx(tmp_path)


def test_constants_and_clone_mode_path_equal_v9():
    js = f'import * as m from {json.dumps((DIST / "review" / "mode.js").as_uri())}; process.stdout.write(JSON.stringify([m.MODE_STATE_NAME, m.MODE_SCHEMA, m.CLONE_MODE_SCHEMA]))'
    assert json.loads(subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True, check=True).stdout) == [M.MODE_STATE_NAME, M.MODE_SCHEMA, M.CLONE_MODE_SCHEMA]
    diff_cases(MOD, "cloneModePath", M.clone_mode_path, [["/c/.git"], ["/c//.git/"], ["rel"], [""], ["/"]])


GLOBAL_BODIES = [None, ENVELOPE({"mode": "on"}), ENVELOPE({"mode": "off"}), ENVELOPE({"mode": "maybe"}), ENVELOPE({"mode": True}), ENVELOPE(None), ENVELOPE([]), ENVELOPE({"mode": "on"}, 2), ENVELOPE({"mode": "on"}, 1.0),
                 "{nope", "", "[]", "null", "\ud800" if False else "�", '{"version":1,"data":{"mode":"on"}}']


def test_is_global_mode_on_and_global_reads_equal_v9(tmp_path):
    for i, body in enumerate(GLOBAL_BODIES):
        d = tmp_path / f"g{i}"
        d.mkdir()
        if body is not None:
            (d / "review-mode.json").write_text(body)
        o = {"dataDir": str(d)}
        assert py_global(o) == v9(MOD, "isGlobalModeOn", o), body
        assert py_read(str(tmp_path), o) == v9(MOD, "readReviewMode", str(tmp_path), o), body
    d = tmp_path / "dir"
    (d / "review-mode.json").mkdir(parents=True)
    assert py_global({"dataDir": str(d)}) == v9(MOD, "isGlobalModeOn", {"dataDir": str(d)}) is False
    for o in ({"dataDir": "relative"}, {"env": {"ODD_CLAUDE_HOME": str(tmp_path / "nohome")}}, {"env": {"ODD_CLAUDE_DATA": str(tmp_path / "x")}}, {}):
        assert py_global(o) == v9(MOD, "isGlobalModeOn", o), o


def _states(fx: Fx):
    """Named mutations of the clone-local override and plugin dir; each starts from a fresh repo."""
    plug = os.path.join(fx.common, "odd-plugin")
    file = os.path.join(plug, "review-mode.json")

    def w(body):
        os.makedirs(plug, exist_ok=True)
        Path(file).write_text(body)

    ext = os.path.join(fx.plain, "ext")
    return {
        "none": lambda: None,
        "off": lambda: w(OVERRIDE_OFF),
        "off-no-newline": lambda: w(json.dumps({"schema": M.CLONE_MODE_SCHEMA, "mode": "off"})),
        "on": lambda: w(json.dumps({"schema": M.CLONE_MODE_SCHEMA, "mode": "on"})),
        "other-schema": lambda: w(json.dumps({"schema": "x", "mode": "off"})),
        "garbage": lambda: w("{nope"),
        "array": lambda: w("[]"),
        "null": lambda: w("null"),
        "empty": lambda: w(""),
        "oversize": lambda: w(OVERRIDE_OFF + " " * 5000),
        "exactly-4096": lambda: w(OVERRIDE_OFF + " " * (4096 - len(OVERRIDE_OFF))),
        "deep": lambda: w("[" * 2000 + "]" * 2000),
        "bad-utf8": lambda: (os.makedirs(plug, exist_ok=True), Path(file).write_bytes(b'\xff{"schema":"x"}')),
        "empty-plugin-dir": lambda: os.makedirs(plug),
        "file-is-dir": lambda: os.makedirs(file),
        "file-is-symlink": lambda: (os.makedirs(plug), os.symlink(fx.plain, file)),
        "file-is-fifo": lambda: (os.makedirs(plug), os.mkfifo(file)),
        "plugin-is-file": lambda: Path(plug).write_text("x"),
        "plugin-is-symlink": lambda: (os.makedirs(ext), Path(ext, "review-mode.json").write_text(OVERRIDE_OFF), os.symlink(ext, plug)),
        "plugin-is-dangling-symlink": lambda: os.symlink(os.path.join(fx.plain, "nowhere"), plug),
    }


def _cwds(fx: Fx):
    sub = os.path.join(fx.repo, "a", "b")
    os.makedirs(sub, exist_ok=True)
    return [fx.repo, sub, os.path.join(fx.repo, ".git"), fx.plain, os.path.join(fx.plain, "missing"), "", fx.repo + "/", os.path.relpath(fx.repo)]


def test_read_review_mode_equals_v9_for_every_clone_state_global_state_and_cwd(tmp_path):
    n = 0
    for name in _states(Fx(tmp_path / "probe") if (tmp_path / "probe").mkdir() is None else None):
        for g in (None, ENVELOPE({"mode": "on"}), ENVELOPE({"mode": "off"})):
            root = tmp_path / f"s{n}"
            n += 1
            root.mkdir()
            f = Fx(root)
            _states(f)[name]()
            if g is not None:
                os.makedirs(f.data)
                Path(f.data, "review-mode.json").write_text(g)
            o = {"dataDir": f.data, "gitTimeoutMs": 5000}
            cwds = _cwds(f)
            want = v9_many(MOD, "readReviewMode", [[c, o] for c in cwds])
            for c, w in zip(cwds, want):
                assert py_oracle_err(py_read, c, o) == w, (name, g, c)


def _read_both(cwd, o, env=None, monkeypatch=None):
    want = v9(MOD, "readReviewMode", cwd, o, env=env)
    if env:
        for k, v in env.items():
            monkeypatch.setenv(k, v)
    return py_oracle_err(py_read, cwd, o), want


def test_read_with_git_failing_slow_or_distrusting_equals_v9(fx, monkeypatch):
    M.set_review_mode("enable", "global", fx.repo, fx.opts)
    sub = os.path.join(fx.repo, "a", "b")
    os.makedirs(sub)
    o = {"dataDir": fx.data, "gitTimeoutMs": 500}
    path = os.environ["PATH"]
    fake = {
        "fail-common": _fake_git(os.path.join(fx.plain, "b1"), "--git-common-dir", 'echo "fatal: boom" >&2; exit 128'),
        "slow": _fake_git(os.path.join(fx.plain, "b2"), "--show-toplevel", "exec sleep 3"),
        "dubious": _fake_git(os.path.join(fx.plain, "b3"), "--show-toplevel", "printf '%s\\n' \"fatal: detected dubious ownership in repository at 'x'\" >&2; exit 128"),
        "dubious-warning": _fake_git(os.path.join(fx.plain, "b4"), "--show-toplevel", "printf '%s\\n' \"warning: detected dubious ownership in repository at 'x'\" \"\tgit config --global --add safe.directory x\" >&2; exit 128"),
        "missing": os.path.join(fx.plain, "empty-bin"),
    }
    os.mkdir(fake["missing"])
    os.symlink(shutil.which("node"), os.path.join(fake["missing"], "node"))  # PATH holds node only: git is unavailable
    wt = os.path.join(fx.plain, "wt")
    os.mkdir(wt)
    Path(wt, ".git").write_text("gitdir: /nowhere\n")
    for override in ("none", "off", "garbage"):
        shutil.rmtree(os.path.join(fx.common, "odd-plugin"), ignore_errors=True)
        _states(fx)[override]()
        for name, b in fake.items():
            env = {"PATH": b if name == "missing" else f"{b}:{path}"}
            for cwd in (fx.repo, sub, wt, fx.plain):
                monkeypatch.setenv("PATH", path)
                got, want = _read_both(cwd, o, env, monkeypatch)
                assert got == want, (override, name, cwd)
    monkeypatch.setenv("PATH", path)


def _git_file_layouts(fx: Fx):
    root = os.path.join(fx.plain, "layouts")
    os.mkdir(root)
    spaced = os.path.join(root, "my main repo")
    os.mkdir(spaced)
    assert subprocess.run(["git", "-C", spaced, "init", "-q", "-b", "main"], env=GIT_ENV).returncode == 0
    M.set_review_mode("disable", "clone", spaced, fx.opts)
    M.set_review_mode("disable", "clone", fx.repo, fx.opts)
    spaced_common = os.path.realpath(os.path.join(spaced, ".git"))
    out = []

    def layout(name, git_file, setup=None):
        wt, gd = os.path.join(root, name), os.path.join(root, f"{name}-gitdir")
        os.mkdir(wt)
        os.mkdir(gd)
        Path(wt, ".git").write_text(git_file(gd, wt))
        if setup:
            setup(gd)
        out.append(wt)

    rel = os.path.relpath
    layout("crlf", lambda g, w: f"gitdir: {rel(g, w)}\r\n", lambda g: Path(g, "commondir").write_text(f"{rel(fx.common, g)}\r\n"))
    layout("sp ace", lambda g, w: f"gitdir: {g}\n", lambda g: Path(g, "commondir").write_text(f"{spaced_common}\n"))
    layout("link", lambda g, w: f"gitdir: {g}\n", lambda g: os.symlink(fx.common, os.path.join(g, "commondir")))
    layout("fifo", lambda g, w: f"gitdir: {g}\n", lambda g: os.mkfifo(os.path.join(g, "commondir")))
    layout("submodule", lambda g, w: f"gitdir: {g}\n", lambda g: (os.makedirs(os.path.join(g, "odd-plugin")), Path(g, "odd-plugin", "review-mode.json").write_text(OVERRIDE_OFF)))
    layout("nocommondir-plain", lambda g, w: f"gitdir: {g}\n")
    layout("empty-commondir", lambda g, w: f"gitdir: {g}\n", lambda g: Path(g, "commondir").write_text("  \n"))
    layout("commondir-missing-dir", lambda g, w: f"gitdir: {g}\n", lambda g: Path(g, "commondir").write_text("/nowhere\n"))
    layout("no-gitdir-prefix", lambda g, w: f"{g}\n")
    layout("gitdir-trailing-spaces", lambda g, w: f"gitdir: {g}  \n", lambda g: Path(g, "commondir").write_text(f"{fx.common}"))
    layout("gitdir-tab", lambda g, w: f"gitdir: {g}\t\n", lambda g: Path(g, "commondir").write_text(f"\t{fx.common}\t"))
    layout("gitdir-double-slash", lambda g, w: f"gitdir: /{g}\n", lambda g: Path(g, "commondir").write_text(f"/{fx.common}\n"))
    layout("big-git-file", lambda g, w: f"gitdir: {g}\n" + "x" * 5000, lambda g: Path(g, "commondir").write_text(f"{fx.common}\n"))
    # a .git that is a symlink to a real dir / a file / dangling
    ln = os.path.join(root, "dotgit-link")
    os.mkdir(ln)
    os.symlink(fx.common, os.path.join(ln, ".git"))
    out.append(ln)
    dang = os.path.join(root, "dotgit-dangling")
    os.mkdir(dang)
    os.symlink(os.path.join(root, "gone"), os.path.join(dang, ".git"))
    out.append(dang)
    ff = os.path.join(root, "dotgit-fifo")
    os.mkdir(ff)
    os.mkfifo(os.path.join(ff, ".git"))
    out.append(ff)
    nested = os.path.join(root, "crlf", "x", "y")
    os.makedirs(nested)
    out.append(nested)
    return out


def test_dot_git_file_layouts_when_git_cannot_resolve_equal_v9(fx, monkeypatch):
    M.set_review_mode("enable", "global", fx.repo, fx.opts)
    layouts = _git_file_layouts(fx)
    slow = _fake_git(os.path.join(fx.plain, "slow"), "--show-toplevel", "exec sleep 3")
    o = {"dataDir": fx.data, "gitTimeoutMs": 300}
    path = os.environ["PATH"]
    env = {"PATH": f"{slow}:{path}"}
    want = v9_many(MOD, "readReviewMode", [[c, o] for c in layouts], env=env)
    monkeypatch.setenv("PATH", env["PATH"])
    for c, w in zip(layouts, want):
        assert py_oracle_err(py_read, c, o) == w, c


def _tree(root: str) -> dict:
    out = {}
    for dirpath, dirs, files in os.walk(root):
        for n in dirs + files:
            p = os.path.join(dirpath, n)
            st = os.lstat(p)
            body = os.readlink(p).replace(str(root), "<R>") if stat.S_ISLNK(st.st_mode) else b"" if stat.S_ISDIR(st.st_mode) or stat.S_ISFIFO(st.st_mode) else Path(p).read_bytes()
            out[os.path.relpath(p, root)] = (oct(stat.S_IMODE(st.st_mode)), stat.S_IFMT(st.st_mode), body)
    return out


def _twin(tmp_path, name, state, cwd_kind, global_body):
    root = tmp_path / name
    root.mkdir()
    f = Fx(root)
    _states(f)[state]()
    if global_body is not None:
        os.makedirs(f.data)
        Path(f.data, "review-mode.json").write_text(global_body)
    return f


def _norm(v, root):
    return json.loads(json.dumps(v).replace(str(root), "<R>"))


def test_set_review_mode_equals_v9_results_errors_and_files_byte_for_byte(tmp_path):
    n = 0
    states = list(_states(Fx(tmp_path / "p") if (tmp_path / "p").mkdir() is None else None))
    combos = [(st, op, "clone", ck, None) for st in states for op in ("enable", "disable") for ck in ("repo", "plain")]
    combos += [(st, op, "global", ck, g) for st in ("none", "off") for op in ("enable", "disable") for ck in ("repo", "missing") for g in (None, ENVELOPE({"mode": "on"}))]
    # cwd undefined cannot cross the oracle (JSON null), so it is covered by test_mode.py only
    for state, op, scope, cwd_kind, g in combos:
        a, b = (_twin(tmp_path, f"t{n}{i}", state, cwd_kind, g) for i in "ab")
        n += 1
        cwd = lambda f: {"repo": f.repo, "plain": f.plain, "missing": os.path.join(f.plain, "m")}[cwd_kind]  # noqa: E731
        want = v9(MOD, "setReviewMode", op, scope, cwd(a), {"dataDir": a.data})
        got = py_oracle_err(py_set, op, scope, cwd(b), {"dataDir": b.data})
        label = (state, op, scope, cwd_kind, g)
        if isinstance(want, dict) and "__error__" in want:
            # the wrapped OS text is Node's vs Python's: compare the typed prefix only
            assert isinstance(got, dict) and got["__error__"].split(": ")[0] == want["__error__"].split(": ")[0], (label, got, want)
        else:
            assert _norm(got, b.dir) == _norm(want, a.dir), label
        assert _tree(a.dir) == _tree(b.dir), label


def test_set_review_mode_global_relative_data_dir_and_env_equal_v9(fx):
    for o in ({"dataDir": "relative"}, {"dataDir": ""}):
        want = v9(MOD, "setReviewMode", "enable", "global", fx.repo, o)
        got = py_oracle_err(py_set, "enable", "global", fx.repo, o)
        assert got == want, o
    assert not os.path.exists(fx.data)
