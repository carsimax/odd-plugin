"""Differential test: Python lib/retro.py against the compiled v9 lib/retro.js on the same inputs and transcripts."""
import json
import re
import tempfile
from pathlib import Path

from odd_claude.lib import retro as r

from .v9_oracle import needs_v9, v9, v9_many

pytestmark = needs_v9

# Skipped on purpose: collation of scripts the ICU tie-break table in retro.py does not model (CJK, emoji order against each other).


def js(obj):
    return json.loads(json.dumps(obj, default=lambda o: o.model_dump(by_alias=True, exclude_none=True)))


def jl(o) -> str:
    """Raw UTF-8 JSON, except lone surrogates, which a file cannot hold: those go out as \\u escapes."""
    return re.sub("[\ud800-\udfff]", lambda m: f"\\u{ord(m[0]):04x}", json.dumps(o, ensure_ascii=False))


def use(name, id=None, **inp):
    b = {"type": "tool_use", "name": name, "input": inp}
    if id is not None:
        b["id"] = id
    return b


def asst(*blocks, **extra):
    return jl({"type": "assistant", "message": {"content": list(blocks)}, **extra})


def user(content, **extra):
    return jl({"type": "user", "message": {"content": content}, **extra})


def result(tid, err=True):
    return {"type": "tool_result", "tool_use_id": tid, "content": "x", **({"is_error": True} if err else {})}


def cap(n: int, tail: str, filler: str = "a") -> str:
    return filler * n + tail


TIE_NAMES = [
    "Bash", "bash", "BASH", "\u00c9dit", "Edit", "edit", "E\u00e7it", "a1", "a_", "A_", "a-1", "a b", "a  b", "Z", "z", "ab", "aB", "Ab", "AB", "ae", "\u00e6", "\u00e4", "ss", "\u00df", "mcp__a__b",
    "mcp__A__b", "mcp__a-b__c", "3", "1", "10", "2", "a.b", "a,b", "(x)", "[x]", "~", "$", "\u00e9", "e", "E", "\u00c9", "e\u0301", "caf\u00e9", "cafe", "Cafe", "CAF\u00c9", "x1", "x01", "X1", "\u00f1", "n", "N", "o\u0308", "\u00f6", "O",
    "Read", "Write", "Edit2", "edit2", "Task", "task", "NotebookEdit", "WebFetch", "webfetch", "Grep", "Glob", "mcp__codegraph__codegraph_explore", "mcp__engram__mem_save", "mcp__plugin_engram_engram__mem_save",
]
STRINGS_160 = [
    cap(159, "\U0001f600"), cap(158, "\U0001f600x"), cap(160, "\U0001f600"), cap(159, "\U0001f600\U0001f600"), "\U0001f600" * 81, "\U0001f600" * 80, "\U0001f600" * 79 + "a", "\u00e9" * 161, cap(159, "\ud800z"), cap(159, "\ude00"),
    "x" * 200, "\U0001f600a" * 100,
]


def build_transcripts() -> list[str]:
    ts = []
    # ties: every name once, in several orders (insertion order must not leak into the result)
    ts.append("\n".join(asst(use(n)) for n in TIE_NAMES) + "\n")
    ts.append("\n".join(asst(use(n)) for n in reversed(TIE_NAMES)) + "\n")
    ts.append("\n".join(asst(use(n)) for n in TIE_NAMES for _ in range(2)) + "\n" + asst(use("Read"), use("Read"), use("Zed")) + "\n")
    # names cut at 160 UTF-16 units (an astral character at the cap), as tool names, files, commands, agent fields
    for s in STRINGS_160:
        ts.append(asst(use(s)) + "\n" + asst(use("Read", file_path=s)) + "\n" + asst(use("Bash", command=s)) + "\n" + asst(use("Agent", subagent_type=s, model=s, prompt="p")) + "\n")
        ts.append("\n".join([asst(use("Read", file_path=s))] * 3 + [asst(use("Edit", file_path=s))] * 2 + [asst(use("Bash", command=s))] * 2) + "\n")
        ts.append(asst(use("Task", subagent_type="odd-worker", model=s, prompt=s)) + "\n")
    # long lines around the 2M UTF-16 unit line cap
    ts.append(asst(use("Read", file_path="/a", pad="x" * 2_097_000)) + "\n" + asst(use("Edit")) + "\n")
    ts.append(asst(use("Read", file_path="/a", pad="x" * 2_097_152)) + "\n" + asst(use("Edit")) + "\n")
    ts.append(asst(use("Read", file_path="/a", pad="\U0001f600" * 1_048_000)) + "\n" + asst(use("Edit")) + "\n")
    ts.append(asst(use("Read", file_path="/a", pad="\U0001f600" * 1_049_000)) + "\n" + asst(use("Edit")) + "\n")
    ts.append(asst(use("Read", file_path="/a", pad="\u00e9" * 1_049_000)) + "\n" + asst(use("Edit")) + "\n")
    # prompts: human text, whitespace only (JS trim vs Python strip), tool results, meta
    for t in ["hello", "   ", "\ufeff", "\u0085", "\x1c", "\x1f", "\u00a0", "\u180e", "\u2028", "\u200b", "\u3000\ufeff\u00a0", "\x0b\x0c", "\ufeffx", "\u0085x", "\x1c\x1d\x1e\x1f", "", "\u2029 ", "\u202f", "\u205f", "\u1680", "\u2000\u200a"]:
        ts.append(user(t) + "\n" + user([{"type": "text", "text": t}]) + "\n" + user([{"type": "text", "text": t}, result("x", False)]) + "\n")
    ts.append(user("hi", isMeta=True) + "\n" + user("hi", isCompactSummary=True) + "\n" + user(5) + "\n" + user(None) + "\n" + user([5, None, "x", {"type": "image"}]) + "\n" + user({"a": 1}) + "\n")
    # commands: JS \s vs Python \s, exempt list, repeats
    for cmd in ["git  status", "git\tstatus", "git\u00a0status", "git\u0085status", "git\x1cstatus", "git\ufeffstatus", "  ls  ", "ls -la", "lsx", "pwd", "pwd\n", "git diff --stat", "git difference", "git\u2028diff", "git\x0bstatus", "\ufeff", "\u0085", "a\u0085b", "a\x1fb", "a\u180eb", "a\u3000b", "a\u200bb", "a \u202f b"]:
        ts.append("\n".join([asst(use("Bash", command=cmd))] * 3) + "\n")
    ts.append(asst(use("Bash", command=5)) + "\n" + asst(use("Bash")) + "\n" + asst(use("Bash", command=None)) + "\n" + asst(use("Bash", command=["ls"])) + "\n")
    # feature doc and source writes, notebooks, inputs of odd types
    for f in ["odd/tasks/x.md", "/p/odd/tasks/x.md", "a/odd/tasks/sub/x.md", "odd\\tasks\\x.md", "C:\\p\\odd\\tasks\\x.md", "xodd/tasks/x.md", "odd/tasks/x.md ", "odd/tasks/.md", "odd/tasks/x.MD", "odd/tasks/x.md\u00e9", "odd/tasks/\U0001f600.md", "/odd/tasks/a\\b.md"]:
        ts.append(asst(use("Edit", file_path=f)) + "\n" + asst(use("Write", file_path="/src/a.py")) + "\n")
        ts.append(asst(use("Write", file_path="/src/a.py")) + "\n" + asst(use("NotebookEdit", notebook_path=f)) + "\n" + asst(use("Edit", file_path=f)) + "\n")
    ts.append(asst(use("Edit", file_path=None, notebook_path="/n.ipynb")) + "\n" + asst(use("Edit", file_path=5, notebook_path="/n.ipynb")) + "\n" + asst(use("Edit", file_path="", notebook_path="/n")) + "\n")
    ts.append(asst({"type": "tool_use", "name": "Read", "input": [1]}) + "\n" + asst({"type": "tool_use", "name": "Read", "input": None}) + "\n" + asst({"type": "tool_use", "name": "Read", "input": "x"}) + "\n")
    # rereads and reedits thresholds, caps of 12 lines per item and 25 items, ties in count ordering
    ts.append("\n".join(asst(use("Read", file_path="/f")) for _ in range(15)) + "\n")
    ts.append("\n".join(asst(use("Read", file_path=f"/f{i}")) for i in range(40) for _ in range(3)) + "\n")
    ts.append("\n".join(asst(use("Read", file_path=f"/f{i % 30}")) for i in range(30 * 4)) + "\n")
    ts.append("\n".join(asst(use("Edit", file_path=f"/e{i % 30}")) for i in range(60 + 30)) + "\n")
    ts.append("\n".join(asst(use("Bash", command=f"cmd {i % 30}")) for i in range(30 * 3)) + "\n")
    ts.append("\n".join(asst(use("Agent", subagent_type="odd-explore")) for _ in range(30)) + "\n")
    ts.append("\n".join(user(f"p{i}") for i in range(30)) + "\n")
    ts.append("\n".join(jl({"isCompactSummary": True}) if i % 2 else jl({"type": "system", "subtype": "compact_boundary"}) for i in range(30)) + "\n")
    # tool errors mapped to names, duplicates by id, unknown ids, more than 25 errors
    ts.append(asst(use("Bash", "t1"), use("Read", "t2"), use("Bash", "t1")) + "\n" + user([result("t1"), result("t2"), result("nope"), result("t1", False), result(None)]) + "\n")
    ts.append(asst(use("", "e"), use("Read", "e2")) + "\n" + user([result("e"), result("e2")]) + "\n" + asst(use("Read", "e2")) + "\n" + user([result("e2")]) + "\n")
    ts.append(asst(use("Bash", "b")) + "\n" + "\n".join(user([result("b")]) for _ in range(30)) + "\n")
    ts.append(asst(use("Bash", "b"), use("Bash", 5), use("Bash", None), use("Bash", ["b"])) + "\n" + user([result("b"), result(5)]) + "\n")
    ts.append(asst(use("Read", "dup", file_path="/a")) + "\n" + asst(use("Read", "dup", file_path="/a")) + "\n" + asst(use("Read", "dup2", file_path="/a")) + "\n")
    # agents: workers, legacy name, missing surfaces, odd types
    for st in ["odd-worker", "odd-claude:odd-worker", "odd-worker ", "ODD-WORKER", "odd-explore", "", "\ufeffodd-worker", "odd-worker\u00a0"]:
        for prompt in ["## Allowed edit surfaces\n- a", "no surfaces", "", None, 5, "x ## Allowed edit surfaces", "## allowed edit surfaces"]:
            ts.append(asst(use("Agent", subagent_type=st, prompt=prompt, model="opus")) + "\n" + asst(use("Task", subagent_type=st, prompt=prompt)) + "\n")
    ts.append(asst(use("Agent")) + "\n" + asst(use("Agent", subagent_type=5, model=None, prompt="x")) + "\n" + asst(use("Task", subagent_type=None, model=["x"])) + "\n")
    # sidechain, odd entries and shapes
    ts.append(asst(use("Read", file_path="/a"), isSidechain=True) + "\n" + user("hi", isSidechain=True) + "\n" + asst(use("Read", file_path="/a"), isSidechain=False) + "\n")
    ts.append("null\n[1]\n5\n\"s\"\ntrue\n{}\n" + jl({"type": "assistant"}) + "\n" + jl({"type": "assistant", "message": "x"}) + "\n" + jl({"type": "assistant", "message": {"content": "x"}}) + "\n" + jl({"type": "assistant", "message": {"content": [None, 5, "x", [1], {"type": "tool_use"}, {"type": "tool_use", "name": 5}]}}) + "\n")
    ts.append('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"A","input":{"command":NaN}}]}}\n' + asst(use("Ok")) + "\n")
    ts.append('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/a"}}]}}\n' + "garbage {\n" + "\n\n\n" + asst(use("Ok")) + "\n")
    ts.append(asst(use("A\x1b[31mB\x1b[0m"), use("\x1b]0;t\x07C"), use("  D  "), use("E\u200f\u202eF"), use("\ufeffG\ufeff")) + "\n")
    # CRLF, BOM, truncated final line, no trailing newline, empty
    ts += ["", "\n", "\n\n", asst(use("Read")) + "\r\n" + asst(use("Edit")) + "\r\n", "\ufeff" + asst(use("Read")) + "\n", asst(use("Read")) + "\n" + asst(use("Edit"))[:-5], asst(use("Read")), "\r\n\r\n"]
    ts.append("".join(asst(use("Read", file_path=f"/r{i}")) + "\n" + user(f"hello {i}") + "\n" for i in range(300)))
    ts.append("é😀日本\n" * 50 + asst(use("Read", file_path="/é😀")) + "\n")
    return ts


def test_collect_retro_on_transcripts_and_tail_sizes():
    ts = build_transcripts()
    with tempfile.TemporaryDirectory() as tmp:
        for k, body in enumerate(ts):
            f = Path(tmp, f"t{k}.jsonl")
            f.write_text(body, encoding="utf-8", newline="")
            sizes = [None] if len(body) < 400 else [None, 1, 50, 200, 997, len(body.encode()) // 2, len(body.encode()) - 3]
            calls = [[str(f)] if n is None else [str(f), n] for n in sizes]
            assert v9_many("retro", "collectRetro", calls) == [js(r.collect_retro(*c)) for c in calls], k


def test_collect_retro_on_unreadable_paths():
    with tempfile.TemporaryDirectory() as tmp:
        paths = [str(Path(tmp, "nope")), tmp, "/dev/null", ""]
        assert v9_many("retro", "collectRetro", [[p] for p in paths]) == [js(r.collect_retro(p)) for p in paths]


def digest(**kw):
    base = {"schema": "odd-claude.retro/v1", "lines": 3, "firstLine": 1, "bytesRead": 100, "truncated": False, "prompts": {"count": 0, "lines": []}, "tools": [], "errors": {"count": 0, "items": []},
            "rereads": [], "reedits": [], "repeatedCommands": [], "agents": [], "compactions": []}
    return {**base, **kw}


def test_render_retro():
    ds = [
        digest(), digest(prompts={"count": 2, "lines": [1, 5]}, tools=[{"name": "Read", "count": 3}, {"name": "Edit", "count": 1}], errors={"count": 2, "items": [{"tool": "Bash", "line": 4}, {"tool": "unknown", "line": 9}]}),
        digest(errors={"count": 3, "items": []}), digest(rereads=[{"file": "/a\U0001f600", "count": 3, "lines": [1, 2, 3]}], reedits=[{"file": "/b", "count": 2, "lines": [4, 5], "mainThread": True}, {"file": "/c", "count": 2, "lines": [4, 5], "mainThread": False}]),
        digest(repeatedCommands=[{"command": "npm test", "count": 2, "lines": [7, 8]}]),
        digest(agents=[{"line": 2, "subagentType": "", "model": "", "missingEditSurfaces": False}, {"line": 3, "subagentType": "odd-worker", "model": "opus", "missingEditSurfaces": True}, {"line": 4, "subagentType": "x", "model": "", "missingEditSurfaces": True}]),
        digest(compactions=[3, 9]), digest(firstSourceWrite=0, firstFeatureDoc=12), digest(firstSourceWrite=5), digest(firstFeatureDoc=7),
        digest(truncated=True, bytesRead=8 * 1024 * 1024), digest(truncated=True, bytesRead=1), digest(truncated=True, bytesRead=1_572_864), digest(truncated=True, bytesRead=5_033_164), digest(truncated=True, bytesRead=0, firstLine=99, lines=1000000),
        digest(prompts={"count": 1, "lines": [1]}, firstLine=12345),
    ]
    assert v9_many("retro", "renderRetro", [[d] for d in ds]) == [r.render_retro(r.RetroDigest.model_validate(d)) for d in ds]
