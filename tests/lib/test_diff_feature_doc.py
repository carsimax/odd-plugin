"""S7: differential tests of `odd_claude.lib.feature_doc` against the compiled v9 `dist/lib/feature-doc.js`.

Pure functions run on a corpus of documents (every lint rule, CRLF, BOM, tabs, JS `\\s` characters, `\\b` beside non-ASCII
letters, astral characters, lone surrogates, `^` after `\\r` / U+2028). Git-backed functions run on the same temp repo for both sides.
Not crossing the JSON boundary: the `exec` callback (git-probe branches of `lint_feature_doc` are covered through `lint_feature_docs`
on real repos) and the exported constants (pinned below to their v9 values).
"""
import os
import shutil
import subprocess

import pytest

from odd_claude.lib import feature_doc as py
from .conftest import FIXTURES
from .v9_oracle import needs_v9, v9, v9_many

pytestmark = needs_v9

JS_WS = ["\t", "\n", "\x0b", "\x0c", "\r", " ", " ", " ", " ", " ", " ", " ", " ", " ", "　", "﻿"]
NOT_JS_WS = ["\x1c", "\x1d", "\x1e", "\x1f", "\x85", "᠎", "​", "⁠"]
LOOKALIKES = ["", " ", "﻿", " ", "　", "\x1f", "\x85", "\x0b", "\t", " ", "​", "᠎"]


def _doc(tasks="", specs="- **S1** one", log="- L1 req", head="# Title\nBranch: `feat/x`", eol="\n"):
    parts = [head, "## Specs", specs, "## Tasks", tasks, "## Log", log]
    return eol.join(parts) + eol


DOCS = [
    (FIXTURES / "output-schemas" / "feature.md").read_text(encoding="utf-8"),
    "",
    "no headings",
    "# T\n## Specs\n## Tasks\n## Log",
    "# T\n## Tasks\n- T1 | done\n",
    "# T\n## Specs\n## Log\n",
    _doc("- T1 | done; ok\n- T2 | route; done when: x\n- [ ] open one\n- T3 route\n- T4 | done", log="- L1 T1 ok"),
    _doc("- T1 | done", log="- T10 only, T1_x, xT1"),
    _doc("- T1 | done", log="- T1é"),
    _doc("- T1 | done", log="- ñT1"),
    _doc("- T1 | done", log="- ЖT1 T1Ж"),
    _doc("- T1 | done", log="- T1 x"),
    _doc("- T1 | done", log="- 1T1"),
    _doc("- T1 | done", log="- T١"),
    _doc("- T٣ | done", log="- T٣"),
    _doc("- T1 | done; done when: x"),  # known v9 false positive: `| done when` counts as done
    _doc("- T1 | done when: x\n- T2 | route; done when: y\n- T3 | S1; DONE WHEN z"),
    _doc("- T1 | route\n- T2 | route; DoNe WhEn: x\n- T3 | route; done when"),
    _doc("- T1 | DONE\n- T2 | Done\n- T3 | dOnE"),
    _doc("- T1 | doné\n- T2 | doñ\n- T3 | done_x\n- T4 | done1\n- T5 | doneЖ\n- T6 | done-x\n- T7 | done\U0001f600"),
    _doc("- T1 | done\n- T2 |done\n- T3 |\tdone\n- T4 | \t done\n- T5 |\n done"),
    _doc("\n".join(f"- T{i} |{w}done" for i, w in enumerate(JS_WS + NOT_JS_WS, 1))),
    _doc("\n".join(f"- T{i} | route{w}done" for i, w in enumerate(JS_WS + NOT_JS_WS, 1))),
    _doc("\n".join(f"{w}- T{i} | route" for i, w in enumerate(LOOKALIKES, 1)), log="- L1"),
    _doc("\n".join(f"- T{i}{w}| route done when x" for i, w in enumerate(LOOKALIKES, 1))),
    _doc("\n".join(f"{w}- [ ] box{i}{w}" for i, w in enumerate(LOOKALIKES, 1))),
    _doc("-\tT1 | x\n- T1\t| x\n-  T2\n- [x] c\n- [] d\n-[ ] e\n- [ ]f\n  - T3 nested\n\t- T4"),
    _doc("- T1 | done", eol="\r\n", log="- T1 ok"),
    _doc("- T1 | route\r\n- T2 | done when: y", eol="\r\n"),
    "﻿" + _doc("- T1 | route"),
    "﻿# Title\nBranch: `feat/x`\n﻿## Specs\n- **S1** a\n## Tasks\n- T1 | route\n## Log\n- L1\n",
    _doc("- T1 | route", head="﻿# Title\nBranch: `feat/x`"),
    "# T\n  ## Specs\n- **S1** a\n\t## Tasks\n- T1 | route\n  ## Log\n- T1 x\n",
    "# T\n## Specs \n- **S1** a\n## Tasks\t\n- T1 | route\n## Log　\n- L1\n",
    "# T\n##Specs\n## Specs x\n## specs\n## Tasks\n- T1 | route\n## Log\n- L1\n",
    "# T\n## Specs\n- **S1** a\n## Specs\n- **S9** dup\n## Tasks\n## Tasks\n- T1 | route\n## Log\n## Log\n- L1\n",
    "# T\n## Specs\n- **S1** a\n## Tasks\n- T1\n## Tasks\n- T2 | route\n  ## nested heading\n- T3 | route\n##\tx\n- T4 | route\n## Log\n- L1\n",
    "# T\r\n## Specs\r\n- **S1** a\r\n## Tasks\r\n- T1 | route\r\n## Log\r\n- L1\r\n",
    "# T\r\r## Specs\r- **S1** a\r## Tasks\r- T1 | route\r## Log\r- L1\r",
    "# T\n## Specs\n- **S1** a\r- **S2** b - **S3** c - **S4** d\x0b- **S5** e\x0c- **S6** f\x85- **S7** g\n- **S1** dup\n  - **S8** indented\n",
    "# T\n## Specs\n- **S1** a\n- **S12**\n- **S**\n-  **S2**\n- **s3**\n- **S٣**\n- **S4** x\n- **S1.5**\n",
    "# T\n## Specs\n" + "\n".join(f"- **S{i}** x" for i in range(1, 40)) + "\n## Tasks\n## Log\n",
    "# T\n## Specs\n" + "\n".join(f"- **S{i}** x" for i in range(1, 400)) + "\n## Tasks\n- T1 | route\n## Log\n- L1\n",
    "# T\n## Specs\n- **S1**\n## Tasks\n" + "\n".join(f"- T{i} | route {'é' * 20}" for i in range(1, 80)) + "\n## Log\n- L1\n",
    "# T\n## Specs\n- **S1**\n## Tasks\n" + "\n".join(f"- T{i} | route \U0001f600{'x' * 60}" for i in range(1, 80)) + "\n## Log\n- L1\n",
    "# T\n## Tasks\n" + "- T1 | " + "x" * 152 + "\U0001f600yy" + "\n- T2 | " + "y" * 151 + "\U0001f600z\n- T3 | " + "z" * 150 + "\U0001f600\n## Log\n- L1\n",
    "# T\n## Tasks\n- T1 | " + "x" * 153 + "\ud800 tail\n- T2 | " + "x" * 153 + "\udc00 tail\n## Log\n- L1\n",
    "# " + "x" * 157 + "\U0001f600 header\n## Specs\n## Tasks\n## Log\n- L1\n",
    "# " + "x" * 156 + "\U0001f600 header\n## Specs\n## Tasks\n## Log\n- L1\n",
    "# " + "x" * 200 + "\n## Specs\n## Tasks\n## Log\n- " + "y" * 296 + "\U0001f600z\n",
    "# T\n## Specs\n## Tasks\n## Log\n- " + "y" * 297 + "\U0001f600z\n",
    "# T\n## Specs\n## Tasks\n## Log\n- " + "y" * 298 + "\U0001f600z\n- L2 é\n",
    "# T\n## Specs\n## Tasks\n## Log\n- " + "\U0001f600" * 150 + "\n",
    "# T\n## Specs\n## Tasks\n## Log\n- " + "\U0001f600" * 149 + "\n",
    "# T\n## Specs\n## Tasks\n## Log\n- " + "\U0001f600" * 151 + "\n",
    "# T\n## Specs\n## Tasks\n## Log\n- \ud800\n- \udc00\n- \udc00\ud800\n",
    "# T\n## Specs\n- **S1** \ud800\n## Tasks\n- T1 | route \ud83d\n- T\ud800 | x\n## Log\n- T1 \ude00\n",
    "# \ud83d\n## Specs\n## Tasks\n## Log\n",
    "# T\n## Specs\n## Tasks\n## Log\nno dash\n  - indented dash\n - nbsp dash\n-nodash\n- last   line\n",
    "# T\n## Specs\n## Tasks\n## Log\n- one\n\n\n- two  \n\n",
    "  \n # padded first line\n## Specs\n## Tasks\n## Log\n- L",
    " 　 spaced first line ﻿\n## Specs\n## Tasks\n## Log\n- L",
    "\x1f\x85 control first line\x1f\x85\n## Specs\n## Tasks\n## Log\n- L",
    "\n## Specs\n## Tasks\n## Log\n",
    "# T\n## Specs\n## Tasks\n- T1 | route; done when x\n- T2 | done\n## Log\n- T2 x",
    "# T\n## Specs\n## Tasks\n- T1 | route; done when x\n- T2 | done\n## Log\n- T2 x\n## After\n- T1 outside log",
    _doc("- T1 | done", log="- L1\n## Other\n- T1 not in log"),
    _doc("- T12 | done\n- T1 | done", log="- T12 ok"),
    _doc("- T1 | done", log="T1 without dash"),
    _doc("- T1 | done", log="- _T1"),
    _doc("- T1 | done", log="- T1_"),
    _doc("- T1 | done", log="- T1éñ"),
    _doc("- T0001 | done\n- T01 | done", log="- T01"),
    _doc("- T1 | done", log="- T1\ud800"),
    _doc("- T1 | done", log="- \ud800T1"),
    _doc("- T1 | done", log="- \U0001f600T1\U0001f600"),
    _doc("- T1 | done\n- T2 | done", log="- T1\r- T2"),
    _doc("", specs="- **S1** a", log=""),
    _doc("- T1 | route", head="Branch: `a`\nBranch: `b`"),
    _doc("- T1 | route", head="# t\n\nBranch: `éñ/\U0001f600`"),
    _doc("- T1 | route", head="# t\nBranch: ``\nBranch: `x`"),
    _doc("- T1 | route", head="# t\nBranch: `multi\nline`"),
    _doc("- T1 | route", head="# t\r\nBranch: `x`\r\n"),
    _doc("- T1 | route", head="# t\nbranch: `x`"),
    _doc("- T1 | route", head="# t\n  Branch: `x`  "),
    _doc("- T1 | route", head="# t\nBranch:  `x`"),
    _doc("- T1 | done", head="# t\nBranch: `x`"),
    "# t\nBranch: `x`\nno heading at all T1 | route",
    "# t\nBranch: `x`\n## Specs\nBranch: `y`\n## Tasks\n- T1 | route\n## Log\n",
]


def _py_findings(res):
    return [f.model_dump() for f in res]


@pytest.fixture(scope="module")
def noexec():
    def f(cmd, args):
        raise TypeError("exec is not a function")

    return f


def test_constants_match_v9_values():
    assert (py.FEATURE_DOC_SUMMARY_CAP, py.TASKS_LINT_SCHEMA) == (2000, "odd-claude.tasks-lint/v1")


def test_section_range_and_section_match_v9():
    titles = ["Specs", "Tasks", "Log", "Other", "", "Spec", "Specs ", "specs", "Tasks ", "﻿Log"]
    calls = [[d, t] for d in DOCS for t in titles]
    a = v9_many("feature-doc", "sectionRange", calls)
    b = v9_many("feature-doc", "section", calls)
    for (d, t), ra, rb in zip(calls, a, b):
        start, lines = py.section_range(d, t)
        assert ra == {"start": start, "lines": lines}, (d, t)
        assert rb == py.section(d, t), (d, t)


LINES = (
    [ln for d in DOCS for ln in d.split("\n")]
    + [f"{w}- T1 | x{w}" for w in JS_WS + NOT_JS_WS]
    + [f"- T1 |{w}done{s}" for w in JS_WS + NOT_JS_WS for s in ["", "é", "_", "ñ", "Ж", " ", "\U0001f600", "\ud800", "9"]]
    + ["- T", "- T1", "- T12abc", "- T١", "- [ ]", "- [ ]x", "- [x]", "-", "", " ", "|done", "| done", "| done when", "|\x0bdone", "|\x1cdone", "|\x85done", "|᠎done"]
)


def test_task_line_predicates_match_v9():
    for fn, pyfn in [("isTaskLine", py.is_task_line), ("isDoneTaskLine", py.is_done_task_line), ("isOpenTaskLine", py.is_open_task_line)]:
        got = v9_many("feature-doc", fn, [[ln] for ln in LINES])
        assert got == [pyfn(ln) for ln in LINES], fn


PATHS = ["odd/tasks/x.md", "", "é/\U0001f600.md", "p" * 200]


def test_summarize_feature_doc_matches_v9():
    calls = [[{"path": p, "text": d}] for d in DOCS for p in PATHS[:2]] + [[{"path": PATHS[3], "text": d}] for d in DOCS[:8]] + [[{"path": PATHS[2], "text": d}] for d in DOCS]
    got = v9_many("feature-doc", "summarizeFeatureDoc", calls)
    want = [py.summarize_feature_doc(py.ActiveFeatureDoc(path=c[0]["path"], text=c[0]["text"])) for c in calls]
    for c, g, w in zip(calls, got, want):
        assert g == w, c


def test_lint_feature_doc_matches_v9(noexec):
    files = ["odd/tasks/x.md", "é/\U0001f600.md", ""]
    calls = [[f, d, "/root", None, "main"] for d in DOCS for f in files[:1]] + [[files[1], d, "/root", None, "trunk"] for d in DOCS[:20]]
    got = v9_many("feature-doc", "lintFeatureDoc", calls)
    for c, g in zip(calls, got):
        if isinstance(g, dict) and "__error__" in g:
            assert g["__error__"] == "exec is not a function"  # branch probe reached; covered by the repo tests
            with pytest.raises(TypeError):
                py.lint_feature_doc(c[0], c[1], c[2], noexec, c[4])
        else:
            assert g == _py_findings(py.lint_feature_doc(c[0], c[1], c[2], noexec, c[4])), c


def test_lint_rules_are_all_exercised():
    rules = set()
    for g in v9_many("feature-doc", "lintFeatureDoc", [["f", d, "/r", None, "main"] for d in DOCS]):
        if isinstance(g, list):
            rules |= {f["rule"] for f in g}
    assert rules == {"done-without-log", "open-without-done-when", "missing-section"}


def test_render_tasks_lint_matches_v9():
    lints = [
        {"files": 0, "findings": []},
        {"files": 2, "findings": [{"file": "a.md", "line": 3, "rule": "done-without-log", "message": "m é\U0001f600"}]},
        {"files": 1, "findings": [{"file": "é.md", "line": 1, "rule": "missing-section", "message": 'no "## Specs" section'},
                                  {"file": "b.md", "line": 99, "rule": "open-without-done-when", "message": ""}]},
        {"files": 7, "findings": []},
    ]
    got = v9_many("feature-doc", "renderTasksLint", [[x] for x in lints])
    assert got == [py.render_tasks_lint(py.TasksLint.model_validate(x)) for x in lints]


# ---- git-backed functions: the same repo and cwd for both sides ----

def _git(repo, *args):
    subprocess.run(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", *args], check=True, capture_output=True)


def _commit(repo, msg):
    _git(repo, "commit", "--allow-empty", "-q", "-m", msg)


def _repo(tmp_path, name, base="main"):
    repo = str(tmp_path / name)
    os.makedirs(os.path.join(repo, "odd", "tasks"))
    subprocess.run(["git", "init", "-q", "-b", base, repo], check=True, capture_output=True)
    _commit(repo, "root")
    return repo


def _task_doc(branch, tasks="- T1 | route; done when: x\n- T2 | route"):
    return f"# t\nBranch: `{branch}`\n## Specs\n- **S1** a\n## Tasks\n{tasks}\n## Log\n- L1 x\n"


def _put(repo, name, content):
    data = content if isinstance(content, bytes) else content.encode("utf-8")
    with open(os.path.join(repo, "odd", "tasks", name), "wb") as f:
        f.write(data)


def _both(fn_js, fn_py, repo, *, norm=lambda x: x):
    got = v9("feature-doc", fn_js, repo)
    want = fn_py(repo)
    return got, norm(want)


def _lint_norm(x):
    return None if x is None else {"files": x.files, "findings": _py_findings(x.findings)}


def _doc_norm(x):
    return None if x is None else {"path": x.path, "text": x.text}


@pytest.fixture()
def branchy(tmp_path):
    """main with: `live` (fresh at main tip), `feat/work` (ahead, checked out), `merged` (ancestor of an advanced main)."""
    repo = _repo(tmp_path, "r")
    _git(repo, "branch", "live")
    _git(repo, "branch", "merged")
    _git(repo, "branch", "feat/éñ")
    _commit(repo, "main advances")  # `merged` and `live` are now ancestors of main; `live` is behind
    _git(repo, "checkout", "-q", "-b", "feat/work")
    _commit(repo, "work")
    for name, br in [("a-live.md", "live"), ("b-merged.md", "merged"), ("c-gone.md", "gone"), ("d-feat.md", "feat/work"), ("e-main.md", "main"), ("f-uni.md", "feat/éñ")]:
        _put(repo, name, _task_doc(br))
    _put(repo, "g-closed-done.md", _task_doc("gone", "- T1 | done\n"))
    _put(repo, "h-nobranch.md", "# t\n## Specs\n## Tasks\n- T1 | route\n## Log\n")
    _put(repo, "i-bad.md", b"# t\nBranch: `gone`\n## Specs\n## Tasks\n- T1 | route\n- T2 | done\n- T3 x\xff\xe2\x82 y\n## Log\n- T2\n")
    _put(repo, "j-bom.md", "﻿" + _task_doc("gone"))
    _put(repo, "k-crlf.md", _task_doc("gone").replace("\n", "\r\n"))
    _put(repo, "l-notmd.txt", _task_doc("gone"))
    os.makedirs(os.path.join(repo, "odd", "tasks", "m-dir.md"))
    _put(repo, "￠.md", _task_doc("gone"))
    _put(repo, "\U00010000.md", _task_doc("gone"))
    _put(repo, "B.md", _task_doc("gone"))
    _put(repo, "a.md", _task_doc("gone"))
    _put(repo, "é.md", _task_doc("gone"))
    return repo


def test_lint_feature_docs_matches_v9(branchy):
    got, want = _both("lintFeatureDocs", py.lint_feature_docs, branchy, norm=_lint_norm)
    assert got == want
    assert {f["rule"] for f in got["findings"]} >= {"open-tasks-on-closed-branch"}
    assert any("merged" in f["message"] for f in got["findings"]) and any("no longer exists" in f["message"] for f in got["findings"])


def test_lint_feature_docs_cwd_variants_match_v9(branchy, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # relative cwd values resolve the same on both sides
    sub = os.path.join(branchy, "odd")
    plain = str(tmp_path / "plain")
    os.makedirs(plain)
    nogit_tasks = str(tmp_path / "ng")
    os.makedirs(os.path.join(nogit_tasks, "odd", "tasks"))
    notasks = _repo(tmp_path, "nt")
    shutil.rmtree(os.path.join(notasks, "odd"))
    for cwd in [sub, plain, nogit_tasks, notasks, str(tmp_path / "missing"), "", branchy + "/"]:
        got = v9("feature-doc", "lintFeatureDocs", cwd, cwd=str(tmp_path))
        assert got == _lint_norm(py.lint_feature_docs(cwd)), cwd


def test_find_active_feature_doc_and_summary_match_v9(branchy, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    for branch in ["feat/work", "main", "live", "feat/éñ", "gone"]:
        if branch == "gone":
            _git(branchy, "checkout", "-q", "--detach")
        elif branch != "feat/work":
            _git(branchy, "checkout", "-q", branch) if branch != "feat/work" else None
        else:
            _git(branchy, "checkout", "-q", "feat/work")
        for cwd in [branchy, os.path.join(branchy, "odd", "tasks"), str(tmp_path), str(tmp_path / "missing")]:
            got = v9("feature-doc", "findActiveFeatureDoc", cwd, cwd=str(tmp_path))
            assert got == _doc_norm(py.find_active_feature_doc(cwd)), (branch, cwd)
            got = v9("feature-doc", "activeFeatureDocSummary", cwd, cwd=str(tmp_path))
            assert got == py.active_feature_doc_summary(cwd), (branch, cwd)


def test_active_doc_picks_the_first_name_in_utf16_order(tmp_path):
    repo = _repo(tmp_path, "order")
    _git(repo, "checkout", "-q", "-b", "w")
    for name in ["￠.md", "\U00010000.md", "c.md", "B.md"]:
        _put(repo, name, _task_doc("w"))
    for n in ["B.md", "c.md", "￠.md", "\U00010000.md"]:  # remove from the front, one by one, via rewriting the branch header
        got = v9("feature-doc", "findActiveFeatureDoc", repo)
        assert got == _doc_norm(py.find_active_feature_doc(repo))
        os.rename(os.path.join(repo, "odd", "tasks", n), os.path.join(repo, "odd", "tasks", n[:-3] + ".txt"))


def test_origin_head_default_branch_matches_v9(tmp_path):
    repo = _repo(tmp_path, "trunky", base="trunk")
    _git(repo, "branch", "done-branch")
    _commit(repo, "advance trunk")
    _git(repo, "update-ref", "refs/remotes/origin/trunk", "HEAD")
    _git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
    _put(repo, "a.md", _task_doc("done-branch"))
    _put(repo, "b.md", _task_doc("trunk"))
    got, want = _both("lintFeatureDocs", py.lint_feature_docs, repo, norm=_lint_norm)
    assert got == want
    assert any("merged into trunk" in f["message"] for f in got["findings"])
    # dangling origin/HEAD: falls back to the same default on both sides
    repo2 = _repo(tmp_path, "dangling")
    _git(repo2, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/nothere")
    _put(repo2, "a.md", _task_doc("gone"))
    got, want = _both("lintFeatureDocs", py.lint_feature_docs, repo2, norm=_lint_norm)
    assert got == want
