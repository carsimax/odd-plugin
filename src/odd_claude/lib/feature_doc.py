"""Active ODD feature document and tasks lint; port of v9 `lib/feature-doc.ts`.

The active document is the file in `<git root>/odd/tasks/*.md` whose header names the current branch. Fail-soft: any problem
(no git, no match, unreadable file) yields None.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Callable, Literal

from pydantic import BaseModel, ConfigDict, Field

from .system import real_exec

FEATURE_DOC_SUMMARY_CAP = 2000
LINE_CAP = 160
LOG_CAP = 300
TASKS_LINT_SCHEMA = "odd-claude.tasks-lint/v1"

ExecFn = Callable[[str, list[str]], "str | None"]
LintRule = Literal["open-tasks-on-closed-branch", "done-without-log", "open-without-done-when", "missing-section"]


@dataclass
class ActiveFeatureDoc:
    path: str
    text: str


class LintFinding(BaseModel):
    file: str
    line: int
    rule: LintRule
    message: str


class TasksLint(BaseModel):
    files: int
    findings: list[LintFinding]


class TasksLintOutput(BaseModel):
    """The `--json` stdout shape: `{schema, files, findings}`."""

    model_config = ConfigDict(populate_by_name=True)
    schema_id: str = Field(default=TASKS_LINT_SCHEMA, alias="schema")
    files: int
    findings: list[LintFinding]


def tasks_lint_json(lint: TasksLint) -> str:
    """Serialized like v9 `tasks --json` (2-space JSON, no trailing newline)."""
    return TasksLintOutput(files=lint.files, findings=lint.findings).model_dump_json(by_alias=True, indent=2)


# JS `\s` / `String.prototype.trim` whitespace: differs from Python's (no U+001C-001F and U+0085, but U+FEFF).
_JS_WS = "\t\n\x0b\x0c\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_WS = f"[{_JS_WS}]"
# JS multiline `^`: after \n, \r, U+2028 or U+2029 (Python's `re.M` only knows \n).
_BOL = r"(?:^|(?<=[\r\u2028\u2029]))"


def _trim(s: str) -> str:
    return s.strip(_JS_WS)


def _clip(s: str, cap: int) -> str:
    """JS `length`/`slice` count UTF-16 code units; slicing may split a surrogate pair, like in JS."""
    u = s.encode("utf-16-le", "surrogatepass")
    if len(u) // 2 <= cap:
        return s
    return u[: 2 * max(0, cap - 3)].decode("utf-16-le", "surrogatepass") + "..."


def _utf16_key(name: str) -> bytes:
    """JS `.sort()` compares UTF-16 code units (big-endian bytes compare the same way)."""
    return name.encode("utf-16-be", "surrogatepass")


def _read(path: str) -> str:
    with open(path, encoding="utf-8", errors="replace", newline="") as f:
        return f.read()


def _header(text: str) -> str:
    return text.split("\n## ", 1)[0]


def find_active_feature_doc(cwd: str, exec: ExecFn = real_exec) -> ActiveFeatureDoc | None:
    """The feature document whose header (text before the first `## ` heading) contains ``Branch: `<branch>` ``, or None."""
    try:
        root = exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"])
        branch = exec("git", ["-C", cwd, "branch", "--show-current"])
        if not root or not branch:
            return None
        d = os.path.join(root, "odd", "tasks")
        needle = f"Branch: `{branch}`"
        for name in sorted((n for n in os.listdir(d) if n.endswith(".md")), key=_utf16_key):
            try:
                path = os.path.join(d, name)
                text = _read(path)
                if needle in _header(text):
                    return ActiveFeatureDoc(path=os.path.relpath(path, root), text=text)
            except OSError:
                pass  # unreadable candidate: try the next one
    except OSError:
        pass  # no git, no odd/tasks directory
    return None


def section_range(text: str, title: str) -> tuple[int, list[str]]:
    """Body of the `## <title>` section as (0-based index of its first body line, lines); the index is -1 when the heading is absent."""
    lines = text.split("\n")
    at = next((i for i, l in enumerate(lines) if _trim(l) == f"## {title}"), -1)
    if at < 0:
        return -1, []
    rest = lines[at + 1 :]
    end = next((i for i, l in enumerate(rest) if l.startswith("## ")), -1)
    return at + 1, rest if end < 0 else rest[:end]


def section(text: str, title: str) -> list[str]:
    return section_range(text, title)[1]


def is_task_line(line: str) -> bool:
    """A task line of `## Tasks`: `- T<n> ...` or a `- [ ]` checkbox."""
    return re.match(r"- (T[0-9]+|\[ \])", _trim(line)) is not None


def is_done_task_line(line: str) -> bool:
    """A task line whose route/status column says `done`."""
    return re.search(rf"\|{_WS}*done\b", line, re.I | re.A) is not None


def is_open_task_line(line: str) -> bool:
    return is_task_line(line) and not is_done_task_line(line)


def summarize_feature_doc(doc: ActiveFeatureDoc) -> str:
    """Compact state of a feature document, hard-capped at FEATURE_DOC_SUMMARY_CAP characters."""
    specs = "\n".join(section(doc.text, "Specs"))
    ids = list(dict.fromkeys(re.findall(rf"{_BOL}- \*\*(S[0-9]+)\*\*", specs, re.M)))
    open_tasks = [_clip(l, LINE_CAP) for l in (_trim(x) for x in section(doc.text, "Tasks")) if is_open_task_line(l)]
    log = [l for l in (_trim(x) for x in section(doc.text, "Log")) if l.startswith("- ")]
    first = _trim(doc.text.split("\n", 1)[0])
    parts = [
        f"Active ODD feature document (reinjected): {doc.path}",
        f"Header: {_clip(first, LINE_CAP)}",
        f"Specs: {', '.join(ids) if ids else 'none listed'}",
        "Open tasks:" + ("\n" + "\n".join(open_tasks) if open_tasks else " none"),
        f"Last log entry: {_clip(log[-1], LOG_CAP) if log else 'none'}",
    ]
    return _clip("\n".join(parts), FEATURE_DOC_SUMMARY_CAP)


def active_feature_doc_summary(cwd: str, exec: ExecFn = real_exec) -> str | None:
    """The summary for the active document of the cwd's branch, or None."""
    doc = find_active_feature_doc(cwd, exec)
    if not doc:
        return None
    try:
        return summarize_feature_doc(doc)
    except Exception:
        return None


def _default_branch(root: str, exec: ExecFn) -> str:
    ref = exec("git", ["-C", root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    return re.sub(r"^origin/", "", ref) if ref else "main"


def _closed_reason(root: str, branch: str, base: str, exec: ExecFn) -> str | None:
    """Why a branch no longer carries work (missing locally, or merged into the default branch), or None while it is live."""
    tip = exec("git", ["-C", root, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"])
    if tip is None:
        return "no longer exists locally"
    base_tip = exec("git", ["-C", root, "rev-parse", "--verify", "--quiet", f"refs/heads/{base}"])
    # A branch still at the default branch's tip is freshly created, not merged.
    if base_tip is None or base_tip == tip:
        return None
    merged = exec("git", ["-C", root, "merge-base", "--is-ancestor", branch, base]) is not None
    return f"is already merged into {base}" if merged else None


def lint_feature_doc(file: str, text: str, root: str, exec: ExecFn, base: str) -> list[LintFinding]:
    """Lint one feature document; `file` is its repo-relative path. Pure apart from the git probes of the branch check."""
    out: list[LintFinding] = []

    def add(line: int, rule: LintRule, message: str) -> None:
        out.append(LintFinding(file=file, line=line, rule=rule, message=message))

    specs, tasks, log = (section_range(text, t) for t in ("Specs", "Tasks", "Log"))
    for title, r in (("Specs", specs), ("Tasks", tasks), ("Log", log)):
        if r[0] < 0:
            add(1, "missing-section", f'no "## {title}" section; add it (feature document layout: header, ## Specs, ## Tasks, ## Log).')
    log_text = "\n".join(log[1])
    open_lines: list[int] = []
    for i, raw in enumerate(tasks[1]):
        line = tasks[0] + i + 1
        if is_open_task_line(raw):
            open_lines.append(line)
            if not re.search(r"done when", raw, re.I | re.A):
                add(line, "open-without-done-when", "open task has no `done when: <observable check>`; append the command or observation that proves it.")
            continue
        m = re.match(r"- (T[0-9]+)", _trim(raw))
        if m and is_done_task_line(raw) and not re.search(rf"\b{m.group(1)}\b", log_text, re.A):
            add(line, "done-without-log", f"{m.group(1)} is marked done but never appears in ## Log; append a Log entry with its observed evidence, or reopen the task.")
    bm = re.search(r"Branch: `([^`]+)`", _header(text))
    branch = bm.group(1) if bm else None
    if branch and open_lines:
        reason = _closed_reason(root, branch, base, exec)
        if reason:
            needle = f"Branch: `{branch}`"
            ln = next((i for i, l in enumerate(text.split("\n")) if needle in l), -1) + 1
            add(ln, "open-tasks-on-closed-branch", f"{len(open_lines)} open task(s) but branch `{branch}` {reason}; mark finished tasks done with evidence in ## Log, or close the document.")
    return out


def lint_feature_docs(cwd: str, exec: ExecFn = real_exec) -> TasksLint | None:
    """Read-only lint of every `<git root>/odd/tasks/*.md`, or None when there is no git root or tasks directory."""
    try:
        root = exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"])
        if not root:
            return None
        d = os.path.join(root, "odd", "tasks")
        names = sorted((n for n in os.listdir(d) if n.endswith(".md")), key=_utf16_key)
        base = _default_branch(root, exec)
        findings: list[LintFinding] = []
        for name in names:
            try:
                path = os.path.join(d, name)
                findings.extend(lint_feature_doc(os.path.relpath(path, root), _read(path), root, exec, base))
            except OSError:
                pass  # unreadable document: skip it
        return TasksLint(files=len(names), findings=findings)
    except Exception:
        return None


def render_tasks_lint(lint: TasksLint) -> str:
    head = f"Feature documents: {lint.files}, findings: {len(lint.findings)}"
    return "\n".join([head, *(f"{f.file}:{f.line} {f.rule}: {f.message}" for f in lint.findings)])
