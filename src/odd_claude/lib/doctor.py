"""Read-only diagnostics (port of v9 lib/doctor.ts, R38 semantics): probe tools and report ok/missing. Pure: every side
effect (exec, env, filesystem) is injected so tests use fakes. python and uv are required (where v9 required node), as is git;
engram, codegraph, the odd-claude install, its hooks and the data dir are optional."""
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

from .state import data_dir_from_env

MIN_PYTHON = (3, 14)


@dataclass
class DoctorDeps:
    #: Runs `cmd args`; returns trimmed stdout, or None when missing/failing.
    exec: Callable[[str, list[str]], str | None]
    env: Mapping[str, str | None]
    #: e.g. "3.14.1" (platform.python_version()).
    python_version: str
    #: odd-claude version of the running code.
    version: str
    #: Installed Claude Code plugin keys (`name@marketplace`); None when unknown.
    installed_plugins: Callable[[], list[str] | None]
    #: Version behind `~/.odd-claude/current`; None when the global install is absent.
    installed_version: Callable[[], str | None]
    #: Whether settings.json registers the odd-claude hooks; None when unknown.
    hooks_installed: Callable[[], bool | None]
    is_writable: Callable[[str], bool]


class DoctorItem(BaseModel):
    id: str
    label: str
    required: bool
    status: Literal["ok", "missing"]
    detail: str


class DoctorReport(BaseModel):
    """Output schema 1 (stdout only, never read back); keys are camelCase like v9."""

    schema_: Literal[1] = 1
    version: str
    items: list[DoctorItem]
    missing: list[str]
    requiredMissing: list[str]
    ok: bool

    def to_json_dict(self) -> dict:
        d = self.model_dump()
        return {"schema": d.pop("schema_"), **d}


def parse_version(text: str) -> str | None:
    m = re.search(r"[0-9]+\.[0-9]+\.[0-9]+", text)
    return m.group(0) if m else None


def python_satisfies(version: str) -> bool:
    m = re.match(r"v?([0-9]+)\.([0-9]+)", version)
    return m is not None and (int(m.group(1)), int(m.group(2))) >= MIN_PYTHON


def _item(id: str, label: str, required: bool, ok: bool, detail: str) -> DoctorItem:
    return DoctorItem(id=id, label=label, required=required, status="ok" if ok else "missing", detail=detail)


def _probe(deps: DoctorDeps, cmd: str, args: list[str]) -> str | None:
    out = deps.exec(cmd, args)
    return None if out is None else (parse_version(out) or "unknown version")


def collect_doctor(deps: DoctorDeps) -> DoctorReport:
    need = f"{MIN_PYTHON[0]}.{MIN_PYTHON[1]}"
    items = [_item("python", "python", True, python_satisfies(deps.python_version), f"{deps.python_version} (need >={need})")]
    uv = _probe(deps, "uv", ["--version"])
    items.append(_item("uv", "uv", True, uv is not None, uv or "not found on PATH"))
    git = _probe(deps, "git", ["--version"])
    items.append(_item("git", "git", True, git is not None, git or "not found on PATH"))

    engram_bin = _probe(deps, "engram", ["version"])
    plugins = deps.installed_plugins()
    engram_plugin = next((p for p in plugins or [] if p == "engram" or p.startswith("engram@")), None)
    parts = [x for x in (f"binary {engram_bin}" if engram_bin is not None else None, f"plugin {engram_plugin}" if engram_plugin is not None else None) if x]
    items.append(_item("engram", "engram", False, len(parts) > 0, ", ".join(parts) or "no binary on PATH and no engram plugin installed"))

    cg = _probe(deps, "codegraph", ["--version"])
    items.append(
        _item(
            "codegraph", "codegraph", False, cg is not None,
            f"{cg} (MCP server codegraph: serve --mcp)" if cg is not None
            else "not found on PATH (optional: the codegraph MCP server stays disconnected; install @colbymchenry/codegraph to enable it)",
        )
    )  # fmt: skip

    installed = deps.installed_version()
    items.append(
        _item(
            "install", "odd-claude install", False, installed is not None,
            f"version {installed} (~/.odd-claude/current)" if installed is not None
            else f"no ~/.odd-claude/current (running v{deps.version}); run `odd-claude install`",
        )
    )  # fmt: skip
    hooks = deps.hooks_installed()
    items.append(_item("hooks", "odd-claude hooks", False, hooks is True, "registered in settings.json" if hooks is True else "not registered in settings.json"))

    data_dir = data_dir_from_env(deps.env)
    writable = deps.is_writable(data_dir)
    items.append(_item("data-dir", "data dir", False, writable, f"{data_dir}{'' if writable else ' (not writable)'}"))

    missing = [i for i in items if i.status == "missing"]
    required_missing = [i.id for i in missing if i.required]
    return DoctorReport(
        schema_=1, version=deps.version, items=items, missing=[i.id for i in missing],
        requiredMissing=required_missing, ok=len(required_missing) == 0,
    )  # fmt: skip


def render_doctor(report: DoctorReport) -> str:
    w = max(len(i.label) for i in report.items)
    lines = [f"odd-claude doctor (v{report.version})", ""]
    for i in report.items:
        lines.append(f"{i.label.ljust(w)}  {'required' if i.required else 'optional'}  {i.status.ljust(7)}  {i.detail}")
    lines += ["", f"missing: {', '.join(report.missing) or 'none'}"]
    return "\n".join(lines)
