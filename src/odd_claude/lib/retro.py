"""Session retro digest (port of v9 lib/retro.ts): a local, read-only summary of a Claude Code transcript (JSONL). Reports counts,
file paths, capped commands and 1-based line numbers only: prompt and tool-result bodies are never printed."""
import json
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .transcript_tail import STATS_MAX_LINE_BYTES, clean_text, read_tail

MAX_STR = 160
MAX_ITEMS = 25
MAX_LINES_PER_ITEM = 12
EXEMPT = ["git status", "git diff", "ls", "pwd"]
WRITE_TOOLS = {"Edit", "Write", "NotebookEdit"}
FEATURE_DOC = re.compile(r"(^|[\\/])odd[\\/]tasks[\\/][^\\/]+\.md\Z")
#: The worker agent; the legacy plugin-namespaced name is kept so old transcripts still analyze.
WORKERS = {"odd-worker", "odd-claude:odd-worker"}


class Prompts(BaseModel):
    count: int
    lines: list[int]


class ToolCount(BaseModel):
    name: str
    count: int


class ErrorItem(BaseModel):
    tool: str
    line: int


class Errors(BaseModel):
    count: int
    items: list[ErrorItem]


class Reread(BaseModel):
    file: str
    count: int
    lines: list[int]


class Reedit(Reread):
    mainThread: bool


class RepeatedCommand(BaseModel):
    command: str
    count: int
    lines: list[int]


class AgentLaunch(BaseModel):
    line: int
    subagentType: str
    model: str
    missingEditSurfaces: bool


class RetroDigest(BaseModel):
    """`odd-claude.retro/v1`. `lines` is the lines read and `firstLine` the absolute 1-based number of the first one; every line number is absolute.
    Unset `firstSourceWrite`/`firstFeatureDoc` are omitted from the JSON."""

    model_config = ConfigDict(populate_by_name=True)
    schema_: Literal["odd-claude.retro/v1"] = Field("odd-claude.retro/v1", alias="schema")
    lines: int
    firstLine: int
    bytesRead: int
    truncated: bool
    prompts: Prompts
    tools: list[ToolCount]
    errors: Errors
    rereads: list[Reread]
    reedits: list[Reedit]
    repeatedCommands: list[RepeatedCommand]
    agents: list[AgentLaunch]
    compactions: list[int]
    firstSourceWrite: int | None = None
    firstFeatureDoc: int | None = None


def _clean(s: Any) -> str:
    return clean_text(s)[:MAX_STR]


def _is_human_prompt(entry: dict, content: Any) -> bool:
    if entry.get("isMeta") is True or entry.get("isCompactSummary") is True:
        return False
    if isinstance(content, str):
        return content.strip() != ""
    if not isinstance(content, list):
        return False
    if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
        return False
    return any(isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str) and b["text"].strip() != "" for b in content)


def _grouped(m: dict[str, list[int]], minimum: int) -> list[tuple[str, list[int]]]:
    return sorted(((k, v) for k, v in m.items() if len(v) >= minimum), key=lambda kv: -len(kv[1]))[:MAX_ITEMS]


def collect_retro(path: str, tail_bytes: int | None = None) -> RetroDigest | None:
    """Digest of the transcript tail; None when it cannot be read. Never raises."""
    try:
        tail = read_tail(path) if tail_bytes is None else read_tail(path, tail_bytes)
        if tail is None:
            return None
        lines = tail.text.split("\n")
        prompts: list[int] = []
        tools: dict[str, int] = {}
        names: dict[str, str] = {}
        errors: list[ErrorItem] = []
        error_count = 0
        reads: dict[str, list[int]] = {}
        edits: dict[str, list[int]] = {}
        commands: dict[str, list[int]] = {}
        agents: list[AgentLaunch] = []
        compactions: list[int] = []
        first_source_write = first_feature_doc = None

        for i, text in enumerate(lines):
            line = tail.first_line + i
            if text == "" or len(text) > STATS_MAX_LINE_BYTES:
                continue
            try:
                entry = json.loads(text)
            except ValueError:
                continue
            if not isinstance(entry, dict) or entry.get("isSidechain") is True:
                continue
            if entry.get("isCompactSummary") is True or (entry.get("type") == "system" and entry.get("subtype") == "compact_boundary"):
                compactions.append(line)
            msg = entry.get("message")
            content = msg.get("content") if isinstance(msg, dict) else None
            if entry.get("type") == "user":
                if _is_human_prompt(entry, content):
                    prompts.append(line)
                if isinstance(content, list):
                    for b in content:
                        if not isinstance(b, dict) or b.get("type") != "tool_result" or b.get("is_error") is not True:
                            continue
                        error_count += 1
                        if len(errors) < MAX_ITEMS:
                            tid = b.get("tool_use_id")
                            errors.append(ErrorItem(tool=(names.get(tid) if isinstance(tid, str) else None) or "unknown", line=line))
                continue
            if entry.get("type") != "assistant" or not isinstance(content, list):
                continue
            for b in content:
                if not isinstance(b, dict) or b.get("type") != "tool_use" or not isinstance(b.get("name"), str):
                    continue
                bid = b.get("id")
                if isinstance(bid, str):
                    if bid in names:
                        continue  # streaming writes one message several times
                    names[bid] = _clean(b["name"])
                name = _clean(b["name"])
                tools[name] = tools.get(name, 0) + 1
                inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                file = _clean(inp.get("file_path") if inp.get("file_path") is not None else inp.get("notebook_path"))
                if name == "Read" and file != "":
                    reads.setdefault(file, []).append(line)
                if name in WRITE_TOOLS and file != "":
                    if FEATURE_DOC.search(file):
                        first_feature_doc = first_feature_doc or line
                    else:
                        first_source_write = first_source_write or line
                    edits.setdefault(file, []).append(line)
                if name == "Bash" and isinstance(inp.get("command"), str):
                    cmd = _clean(re.sub(r"\s+", " ", inp["command"]))
                    if cmd != "" and not any(cmd == e or cmd.startswith(f"{e} ") for e in EXEMPT):
                        commands.setdefault(cmd, []).append(line)
                if name in ("Agent", "Task"):
                    st = _clean(inp.get("subagent_type"))
                    prompt = inp.get("prompt")
                    agents.append(AgentLaunch(line=line, subagentType=st, model=_clean(inp.get("model")), missingEditSurfaces=st in WORKERS and not (isinstance(prompt, str) and "## Allowed edit surfaces" in prompt)))

        cap = lambda l: l[:MAX_LINES_PER_ITEM]  # noqa: E731
        # shortcut: tie-break approximates localeCompare (case-insensitive, lowercase first); upgrade if non-ASCII tool names matter
        by_count = sorted(tools.items(), key=lambda kv: (-kv[1], kv[0].casefold(), kv[0].swapcase()))
        return RetroDigest(
            lines=len(lines), firstLine=tail.first_line, bytesRead=tail.bytes, truncated=tail.truncated,
            prompts=Prompts(count=len(prompts), lines=cap(prompts)),
            tools=[ToolCount(name=n, count=c) for n, c in by_count],
            errors=Errors(count=error_count, items=errors),
            rereads=[Reread(file=k, count=len(v), lines=cap(v)) for k, v in _grouped(reads, 3)],
            reedits=[Reedit(file=k, count=len(v), lines=cap(v), mainThread=True) for k, v in _grouped(edits, 2)],
            repeatedCommands=[RepeatedCommand(command=k, count=len(v), lines=cap(v)) for k, v in _grouped(commands, 2)],
            agents=agents[:MAX_ITEMS], compactions=cap(compactions),
            firstSourceWrite=first_source_write, firstFeatureDoc=first_feature_doc,
        )
    except Exception:
        return None


def _at(l: list[int]) -> str:
    return ", ".join(map(str, l))


def render_retro(d: RetroDigest) -> str:
    out = ["odd-claude retro (local transcript digest)", f"lines      {d.lines} read", f"first line read  {d.firstLine} (all line numbers are absolute in the transcript file)"]
    out.append(f"prompts    {d.prompts.count}{f' (lines {_at(d.prompts.lines)})' if d.prompts.count > 0 else ''}")
    out.append(f"tools      {'none' if not d.tools else ' · '.join(f'{t.name} {t.count}' for t in d.tools)}")
    out.append(f"errors     {d.errors.count}{' · ' + ', '.join(f'{e.tool} @{e.line}' for e in d.errors.items) if d.errors.items else ''}")
    for r in d.rereads:
        out.append(f"reread     {r.file} x{r.count} (lines {_at(r.lines)})")
    for r in d.reedits:
        out.append(f"reedit     {r.file} x{r.count} (lines {_at(r.lines)}){' main thread' if r.mainThread else ''}")
    for c in d.repeatedCommands:
        out.append(f"repeat     {c.command} x{c.count} (lines {_at(c.lines)})")
    for a in d.agents:
        out.append(f"agent      {a.subagentType or '(no type)'}{f' · {a.model}' if a.model != '' else ''} @{a.line}{' · MISSING ## Allowed edit surfaces' if a.missingEditSurfaces else ''}")
    if d.compactions:
        out.append(f"compact    lines {_at(d.compactions)}")
    out.append(f"first source write  {'none' if d.firstSourceWrite is None else d.firstSourceWrite}")
    out.append(f"first feature doc   {'none' if d.firstFeatureDoc is None else d.firstFeatureDoc}")
    if d.truncated:
        out.append(f"(partial: only the last {d.bytesRead / (1024 * 1024):.1f} MiB of the transcript was read)")
    return "\n".join(out)


def retro_json(d: RetroDigest) -> str:
    """The `--json` text of the retro CLI: 2-space JSON, unset fields omitted."""
    return json.dumps(d.model_dump(by_alias=True, exclude_none=True), indent=2, ensure_ascii=False)
