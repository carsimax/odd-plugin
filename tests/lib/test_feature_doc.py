"""Port of v9 `lib/feature-doc.spec.ts` (4 tests) plus lint, section and task-line cases."""
import os
import subprocess

from odd_claude.lib.feature_doc import (
    FEATURE_DOC_SUMMARY_CAP,
    ActiveFeatureDoc,
    active_feature_doc_summary,
    find_active_feature_doc,
    is_done_task_line,
    is_open_task_line,
    is_task_line,
    lint_feature_doc,
    lint_feature_docs,
    render_tasks_lint,
    section,
    section_range,
    summarize_feature_doc,
    tasks_lint_json,
)


def DOC(branch, extra=""):
    return f"""# Feature X
Goal: do it. Branch: `{branch}`.

## Specs

- **S1** first
- **S2** second

## Tasks

- T0 | S1 | worker | done — finished work
- T1 | S2 | worker | pending — open work
{extra}
## Log
- L1: first entry
- L2: last entry
"""


def repo(tmp_path, files):
    root = str(tmp_path)
    os.makedirs(os.path.join(root, "odd", "tasks"))
    for n, t in files.items():
        with open(os.path.join(root, "odd", "tasks", n), "w", encoding="utf-8") as f:
            f.write(t)

    def exec(_c, a):
        return root if "--show-toplevel" in a else "feat/x"

    return root, exec


def test_matches_the_document_by_branch_and_summarizes(tmp_path):
    root, exec = repo(tmp_path, {"a.md": DOC("feat/other"), "b.md": DOC("feat/x")})
    s = active_feature_doc_summary(root, exec)
    assert "odd/tasks/b.md" in s
    assert "Header: # Feature X" in s
    assert "Specs: S1, S2" in s
    assert "T1 | S2 | worker | pending" in s
    assert "Last log entry: - L2: last entry" in s
    assert "a.md" not in s


def test_done_tasks_are_excluded(tmp_path):
    root, exec = repo(tmp_path, {"b.md": DOC("feat/x")})
    assert "T0" not in active_feature_doc_summary(root, exec)


def test_no_matching_branch_no_git_and_a_missing_dir_add_nothing(tmp_path):
    root, exec = repo(tmp_path, {"a.md": DOC("feat/other")})
    assert active_feature_doc_summary(root, exec) is None
    assert active_feature_doc_summary(root, lambda c, a: None) is None
    assert active_feature_doc_summary(root, lambda c, a: os.path.join(root, "nope") if "--show-toplevel" in a else "feat/x") is None


def test_the_summary_is_hard_capped(tmp_path):
    many = "\n".join(f"- T{i + 10} | S1 | worker | pending — {'x' * 150}" for i in range(80))
    root, exec = repo(tmp_path, {"b.md": DOC("feat/x", many)})
    s = active_feature_doc_summary(root, exec)
    assert FEATURE_DOC_SUMMARY_CAP - 10 < len(s) <= FEATURE_DOC_SUMMARY_CAP


def test_find_active_feature_doc_returns_repo_relative_path(tmp_path):
    root, exec = repo(tmp_path, {"b.md": DOC("feat/x")})
    doc = find_active_feature_doc(root, exec)
    assert doc.path == os.path.join("odd", "tasks", "b.md")
    assert doc.text == DOC("feat/x")


def test_empty_summary_parts():
    s = summarize_feature_doc(ActiveFeatureDoc(path="p.md", text="# T\n\n## Tasks\n"))
    assert s == "Active ODD feature document (reinjected): p.md\nHeader: # T\nSpecs: none listed\nOpen tasks: none\nLast log entry: none"


def test_section_and_range():
    text = "h\n## Specs\na\nb\n## Tasks\nc"
    assert section(text, "Specs") == ["a", "b"]
    assert section_range(text, "Tasks") == (5, ["c"])
    assert section_range(text, "Log") == (-1, [])


def test_task_line_predicates():
    assert is_task_line("  - T12 | S1")
    assert is_task_line("- [ ] item")
    assert not is_task_line("- [x] item")
    assert not is_task_line("- note")
    assert is_done_task_line("- T1 | S1 | DONE")
    assert not is_done_task_line("- T1 | S1 | doneness")
    assert is_open_task_line("- T1 | S1 | pending")
    assert not is_open_task_line("- T1 | S1 | done")
    # v9 parity: `| done when:` is a known false positive (recorded follow-up), kept as-is.
    assert is_done_task_line("- T1 | S1 | x | done when: y")


def _never(_c, _a):
    return None


def lint(text, exec=_never):
    return lint_feature_doc("odd/tasks/f.md", text, "/r", exec, "main")


def test_lint_missing_sections():
    f = lint("# H\n")
    assert [(x.line, x.rule) for x in f] == [(1, "missing-section")] * 3
    assert f[0].message == 'no "## Specs" section; add it (feature document layout: header, ## Specs, ## Tasks, ## Log).'


def test_lint_open_without_done_when_and_done_without_log():
    text = "# H\n## Specs\n## Tasks\n- T1 | x | pending\n- T2 | x | done\n- T3 | x | done\n## Log\n- T3 ok\n"
    f = lint(text)
    assert [(x.line, x.rule) for x in f] == [(4, "open-without-done-when"), (5, "done-without-log")]
    assert f[1].message == "T2 is marked done but never appears in ## Log; append a Log entry with its observed evidence, or reopen the task."


def test_lint_open_tasks_on_closed_branch():
    text = "# H\nBranch: `feat/y`\n## Specs\n## Tasks\n- T1 | x | Risk: none; done when: z\n## Log\n"

    def gone(_c, a):
        return None  # rev-parse of the branch fails: no longer exists locally

    f = lint(text, gone)
    assert len(f) == 1 and (f[0].line, f[0].rule) == (2, "open-tasks-on-closed-branch")
    assert f[0].message == "1 open task(s) but branch `feat/y` no longer exists locally; mark finished tasks done with evidence in ## Log, or close the document."

    def merged(_c, a):
        return "same" if "rev-parse" in a and "refs/heads/feat/y" in a[-1] else ("other" if "rev-parse" in a else "ok")

    assert "is already merged into main" in lint(text, merged)[0].message

    def live(_c, a):
        return "tip" + a[-1] if "rev-parse" in a else None  # not an ancestor

    assert lint(text, live) == []

    def fresh(_c, a):
        return "same"  # branch at the default tip

    assert lint(text, fresh) == []


def git(cwd, *a):
    subprocess.run(["git", "-C", cwd, *a], check=True, capture_output=True)


def test_lint_feature_docs_and_render(tmp_path):
    root = str(tmp_path)
    os.makedirs(os.path.join(root, "odd", "tasks"))
    git(root, "init", "-q", "-b", "main")
    with open(os.path.join(root, "odd", "tasks", "a.md"), "w") as f:
        f.write("# H\n## Specs\n## Tasks\n- T1 | x\n## Log\n")
    with open(os.path.join(root, "odd", "tasks", "note.txt"), "w") as f:
        f.write("ignored")
    res = lint_feature_docs(root)
    assert res.files == 1
    assert render_tasks_lint(res) == (
        "Feature documents: 1, findings: 1\n"
        "odd/tasks/a.md:4 open-without-done-when: open task has no `done when: <observable check>`; append the command or observation that proves it."
    )
    assert tasks_lint_json(res).startswith('{\n  "schema": "odd-claude.tasks-lint/v1",\n  "files": 1,')


def test_lint_feature_docs_without_git_or_tasks_dir(tmp_path):
    assert lint_feature_docs(str(tmp_path), _never) is None
    assert lint_feature_docs(str(tmp_path), lambda c, a: str(tmp_path)) is None
