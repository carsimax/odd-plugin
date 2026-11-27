"""Shared helpers for the lib tests (owned by the core-lib T1 unit; other lib test files may import them)."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
FIXTURES = ROOT / "test-fixtures" / "contracts"


def fixture_text(rel: str) -> str:
    """Raw text of a Phase 1 contract fixture, e.g. `session-state/session.json`."""
    return (FIXTURES / rel).read_text(encoding="utf-8")


def fixture_json(rel: str):
    return json.loads(fixture_text(rel))


def spawn_py(code: str, *args: str, **kw) -> subprocess.Popen:
    """Starts `python -c code args...` as a real child process that can import `odd_claude` from this checkout."""
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(filter(None, [str(SRC), os.environ.get("PYTHONPATH", "")]))}
    return subprocess.Popen([sys.executable, "-c", code, *args], env=env, **kw)


def run_py(code: str, *args: str, timeout: float = 60) -> subprocess.CompletedProcess:
    p = spawn_py(code, *args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out, err = p.communicate(timeout=timeout)
    return subprocess.CompletedProcess(p.args, p.returncode, out, err)


def dead_pid() -> int:
    """Pid of a child that already exited (and was reaped)."""
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


@pytest.fixture
def opts(tmp_path):
    """StateOptions pointing at a fresh data dir under tmp_path."""
    from odd_claude.lib.state import StateOptions

    return StateOptions(data_dir=str(tmp_path / "data"))
