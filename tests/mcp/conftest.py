"""Shared helpers of the MCP server tests: real temp git repos and plugin-data dirs (all under tmp_path), an in-process `ReviewServer`
with the reviewer always injected (never the real `claude`), and a stdio driver that runs the v9 server (`node dist/mcp/review-server.js`)
or the Python server as a child process with a sandboxed HOME and data dir. The autouse `sandbox` fixture of review/test_run keeps every
profile or mode read away from the real ~/.odd-claude and ~/.claude."""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import pytest
from odd_claude.review.mode import ModeOptions

from review.conftest import REPO_ROOT
from review.test_run import SEVERE, assess, fake_runner, git, section, sandbox  # noqa: F401

PLUGIN_ROOT = REPO_ROOT / "plugins" / "odd-claude"
V9_SERVER = PLUGIN_ROOT / "dist" / "mcp" / "review-server.js"
needs_v9_server = pytest.mark.skipif(shutil.which("node") is None or not V9_SERVER.is_file(), reason="node or plugins/odd-claude/dist/mcp/review-server.js missing")


class Fx:
    def __init__(self, base: Path, dirty: bool = True, files: dict[str, str] | None = None):
        self.dir = os.path.realpath(base)
        self.repo = os.path.join(self.dir, "repo")
        self.data = os.path.join(self.dir, "data")
        os.mkdir(self.repo)
        os.mkdir(self.data)
        git(self.repo, "init", "-q", "-b", "main")
        for name, text in (files or {"a.txt": "one\ntwo\nthree\n", "b.txt": "bee\n"}).items():
            Path(self.repo, name).write_text(text)
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "init")
        if dirty:
            Path(self.repo, "a.txt").write_text("one\nTWO\nthree\nfour\nfive\n")
        self.common_dir = os.path.realpath(os.path.join(self.repo, ".git"))

    def write(self, name: str, text: str) -> None:
        Path(self.repo, name).write_text(text)


@pytest.fixture
def make_fx(tmp_path):
    n = [0]

    def make(dirty: bool = True, files: dict[str, str] | None = None) -> Fx:
        n[0] += 1
        d = tmp_path / f"fx{n[0]}"
        d.mkdir()
        return Fx(d, dirty, files)

    return make


@dataclass
class Called:
    is_error: bool
    body: Any


def make_server(f: Fx, level: str = "medium", runner: Callable | None = None, **deps_extra):
    """An in-process server for `f`: the risk assessor is injected, the mode data dir is the fixture's. Returns `(call, deps)`."""
    from odd_claude.mcp.review_server import ReviewServer

    deps: dict = {"riskAssessor": assess(level), "modeOptions": ModeOptions(data_dir=f.data), **({"runner": runner} if runner is not None else {}), **deps_extra}
    server = ReviewServer({"deps": deps, "cwd": f.repo})
    ids = [0]

    def call(name: str, args: dict | None = None) -> Called:
        ids[0] += 1
        res = server.handle({"jsonrpc": "2.0", "id": ids[0], "method": "tools/call", "params": {"name": name, "arguments": {} if args is None else args}})
        assert "error" not in res, json.dumps(res["error"])
        result = res["result"]
        assert len(result["content"]) == 1 and result["content"][0]["type"] == "text"
        assert len(result["content"][0]["text"].encode()) <= 256 * 1024
        return Called(result.get("isError") is True, json.loads(result["content"][0]["text"]))

    call.deps = deps  # type: ignore[attr-defined]
    call.server = server  # type: ignore[attr-defined]
    return call


def parse_invocation(invocation: str) -> tuple[str, dict[str, str]]:
    """A consent choice's invocation as the tool call it names: `review_x --a-b v` becomes {a_b: "v"} (every value a string, quotes undone)."""
    tokens: list[str] = []
    cur, quoted, any_ = "", False, False
    i = 0
    while i < len(invocation):
        ch = invocation[i]
        if quoted:
            if ch == "'":
                quoted = False
            else:
                cur += ch
        elif ch == "'":
            quoted, any_ = True, True
        elif ch == "\\" and i + 1 < len(invocation):
            i += 1
            cur += invocation[i]
        elif ch == " ":
            if cur != "" or any_:
                tokens.append(cur)
            cur, any_ = "", False
        else:
            cur += ch
        i += 1
    if cur != "" or any_:
        tokens.append(cur)
    args: dict[str, str] = {}
    for j in range(1, len(tokens), 2):
        assert tokens[j].startswith("--") and tokens[j][2:].replace("-", "").isalpha() and tokens[j] == tokens[j].lower(), f"flag {tokens[j]}"
        assert j + 1 < len(tokens), f"flag {tokens[j]} has a value"
        args[tokens[j][2:].replace("-", "_")] = tokens[j + 1]
    return tokens[0], args


def lit(args: list[dict]) -> dict[str, str]:
    """The literal arguments of a status transition: names snake_cased, values as given (strings)."""
    return {a["name"].replace("-", "_"): a["value"] for a in args}


def choice_args(env: dict, answer: str) -> dict[str, str]:
    c = next(x for x in env["choices"] if x["answer"] == answer)
    tool, args = parse_invocation(c["invocation"])
    assert tool == "review_answer_consent"
    return args


def error_code(c: Called) -> str:
    assert c.is_error is True, json.dumps(c.body)[:500]
    return c.body["error"]["code"]


def good(c: Called) -> Any:
    assert c.is_error is False, json.dumps(c.body)[:500]
    return c.body


def binding_values(inputs: list[dict]) -> list[str]:
    return [next(a["value"] for a in i["arguments"] if a["name"] == "binding") for i in inputs]


# ---- stdio drivers ----

ECHO_PY = r'''
import json, re, sys
prompt = sys.stdin.buffer.read().decode("utf-8")
def section(name):
    return re.search(r"<<<ODD-DATA-\w+ " + name + r">>>\n([\s\S]*?)\n<<<END-ODD-DATA-\w+ " + name + r">>>", prompt).group(1)
head = re.search(r"Role: (\w+)(?:, lens: (\w+))?\.", prompt)
role = head.group(1)
echo = json.loads(re.search(r"Echo these fields verbatim in the result: (\{.*\})", prompt).group(1))
if role == "lens":
    result = {**echo, "inspection": {"status": "completed", "paths": section("changed-path-manifest").split("\n")}, "findings": [], "evidence": ["reviewed the complete candidate scope"]}
elif role == "refuter":
    result = {**echo, "results": [{"finding_id": f["id"], "outcome": "refuted", "proof_refs": ["a.txt:1 handles the empty input"]} for f in json.loads(section("findings"))]}
else:
    result = {**echo, "original_criteria": {"passed": True, "evidence": ["ok"]}, "correction_regression": {"passed": True, "evidence": ["ok"]}, "follow_ups": []}
sys.stdout.write("```json\n" + json.dumps(result) + "\n```\n")
'''


def make_echo_claude(root: Path, sleep_s: float = 0.0) -> str:
    """A fake `claude` (a shell wrapper around a Python script) that answers like the in-process fake reviewer; the directory to put first on PATH."""
    d = Path(os.path.realpath(root)) / "echo-claude"
    d.mkdir(parents=True, exist_ok=True)
    (d / "echo.py").write_text(ECHO_PY)
    claude = d / "claude"
    claude.write_text(f'#!/bin/sh\nsleep {sleep_s}\nexec "{sys.executable}" "{d / "echo.py"}" "$@"\n')
    claude.chmod(0o755)
    return str(d)


def child_env(home: str, data: str, extra_path: str | None = None, **more: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_") and k not in ("CLAUDE_PLUGIN_ROOT", "ODD_CLAUDE_DATA", "CLAUDE_PLUGIN_DATA", "ODD_CLAUDE_HOME")}
    env.update({"HOME": home, "CLAUDE_PLUGIN_DATA": data, "GIT_CONFIG_NOSYSTEM": "1", **more})
    if extra_path:
        env["PATH"] = extra_path + os.pathsep + env.get("PATH", "")
    return env


IMPLS = {
    "v9": ["node", str(V9_SERVER)],
    "py": [sys.executable, "-m", "odd_claude.mcp.review_server"],
}


def run_raw(impl: str, data: bytes, env: dict[str, str], cwd: str, timeout: float = 120) -> tuple[bytes, int]:
    """Feeds raw bytes to the server's stdin (then EOF) and returns its stdout and exit code."""
    r = subprocess.run(IMPLS[impl], input=data, capture_output=True, env=env, cwd=cwd, timeout=timeout)
    assert r.stderr == b"", r.stderr
    return r.stdout, r.returncode


def norm(stdout: bytes) -> list[bytes]:
    """Reply lines in a canonical order: concurrent tool calls may answer in any order, so lines are compared as a sorted list."""
    return sorted(stdout.splitlines())


class Stdio:
    """A live stdio client of one implementation; `request` sends one message and waits for the reply with that id."""

    def __init__(self, impl: str, env: dict[str, str], cwd: str):
        self.p = subprocess.Popen(IMPLS[impl], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=cwd)
        self.replies: dict[Any, dict] = {}
        self.log: list[dict] = []
        self._cv = threading.Condition()
        self._t = threading.Thread(target=self._read, daemon=True)
        self._t.start()
        self._ids = 0

    def _read(self) -> None:
        for line in self.p.stdout:  # type: ignore[union-attr]
            if line.strip():
                m = json.loads(line)
                with self._cv:
                    self.replies[m.get("id")] = m
                    self.log.append(m)
                    self._cv.notify_all()

    def send(self, message: dict) -> None:
        self.p.stdin.write((json.dumps(message) + "\n").encode())  # type: ignore[union-attr]
        self.p.stdin.flush()  # type: ignore[union-attr]

    def start(self, method: str, params: Any = None) -> int:
        self._ids += 1
        self.send({"jsonrpc": "2.0", "id": self._ids, "method": method, **({} if params is None else {"params": params})})
        return self._ids

    def wait(self, id: Any, timeout: float = 60) -> dict:
        end = time.time() + timeout
        with self._cv:
            while id not in self.replies:
                left = end - time.time()
                assert left > 0, f"no reply to {id}"
                self._cv.wait(left)
            return self.replies[id]

    def request(self, method: str, params: Any = None, timeout: float = 60) -> dict:
        return self.wait(self.start(method, params), timeout)

    def initialize(self) -> None:
        r = self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}})
        assert "error" not in r
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def call(self, name: str, args: dict | None = None, timeout: float = 60) -> Called:
        r = self.request("tools/call", {"name": name, "arguments": {} if args is None else args}, timeout)
        assert "error" not in r, json.dumps(r["error"])
        return Called(r["result"].get("isError") is True, json.loads(r["result"]["content"][0]["text"]))

    def close(self) -> int:
        try:
            self.p.stdin.close()  # type: ignore[union-attr]
            return self.p.wait(timeout=30)
        finally:
            if self.p.poll() is None:
                self.p.kill()
                self.p.wait()
            for s in (self.p.stdout, self.p.stderr):
                if s:
                    s.close()
