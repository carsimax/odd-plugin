"""Real implementations of the injected probes (exec, filesystem); port of v9 `lib/system.ts`.

Kept apart from the pure logic so tests never touch the machine.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import Callable, Mapping

from .js import js_get, js_json_loads, js_keys


@dataclass
class CliResult:
    exit_code: int = 0
    stdout: str = ""
    stderr: str = ""


def run_main(module_name: str, fn: Callable[[], CliResult]) -> int | None:
    """Runs `fn` and writes its result when `module_name` is `__main__`; returns the exit code (None when imported).

    A raised action error goes to stderr with exit code 1.
    """
    if module_name != "__main__":
        return None
    try:
        r = fn()
        if r.stdout:
            sys.stdout.write(r.stdout + "\n")
        if r.stderr:
            sys.stderr.write(r.stderr + "\n")
        return r.exit_code
    except Exception as e:
        sys.stderr.write(f"error: {e}\n")
        return 1


def real_exec(cmd: str, args: list[str]) -> str | None:
    try:
        r = subprocess.run([cmd, *args], capture_output=True, text=True, errors="replace", timeout=5, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    return f"{r.stdout or ''}{r.stderr or ''}".strip()


def _dirname(p: str) -> str:
    """Like node's `path.dirname`: "" and "a" -> ".", "a/b/" -> "a"."""
    return os.path.dirname(p.rstrip("/") or ("/" if p else ".")) or "."


def real_is_writable(dir: str) -> bool:
    """Read-only: checks the dir, or its nearest existing ancestor when it does not exist yet."""
    cur = dir
    while not os.path.exists(cur):
        parent = _dirname(cur)
        if parent == cur:
            return False
        cur = parent
    return os.access(cur, os.W_OK)


def _home() -> str:
    """Like node's `os.homedir()`: `$HOME` as is (even empty), else the passwd entry."""
    h = os.environ.get("HOME")
    return os.path.expanduser("~") if h is None else h


def _config_dir(env: Mapping[str, str | None]) -> str:
    return env.get("CLAUDE_CONFIG_DIR") or os.path.join(_home(), ".claude")


def real_installed_plugins(env: Mapping[str, str | None] | None = None) -> list[str] | None:
    """Keys of <CLAUDE_CONFIG_DIR or ~/.claude>/plugins/installed_plugins.json, or None when unreadable."""
    env = os.environ if env is None else env
    try:
        with open(os.path.join(_config_dir(env), "plugins", "installed_plugins.json"), encoding="utf-8") as f:
            raw = js_json_loads(f.read())
        if raw is None:
            return None  # JS: `null.plugins` throws
        plugins = raw.get("plugins") if isinstance(raw, dict) else None
        return None if plugins is None or plugins is False or plugins == "" or (plugins == 0 and not isinstance(plugins, (dict, list))) else js_keys(plugins)  # JS truthiness: {} and [] are truthy
    except (OSError, ValueError):
        return None


def real_installed_version(env: Mapping[str, str | None] | None = None) -> str | None:
    """Version of the global install behind `<ODD_CLAUDE_HOME or ~/.odd-claude>/current`; None when absent or unreadable."""
    env = os.environ if env is None else env
    try:
        home = env.get("ODD_CLAUDE_HOME") or os.path.join(_home(), ".odd-claude")
        current = os.path.realpath(os.path.join(home, "current"), strict=True)
        with open(os.path.join(current, "package.json"), encoding="utf-8") as f:
            v = js_json_loads(f.read()).get("version")  # type: ignore[union-attr]
        return v if isinstance(v, str) else None
    except (OSError, ValueError, AttributeError):
        return None


def real_hook_events(env: Mapping[str, str | None] | None = None) -> list[str] | None:
    """Hook events of `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json` running odd-claude's `dist/hooks/run.js`; None when unreadable."""
    env = os.environ if env is None else env
    try:
        with open(os.path.join(_config_dir(env), "settings.json"), encoding="utf-8") as f:
            raw = js_json_loads(f.read())
        if raw is None:
            return None  # JS: `null.hooks` throws
        hooks = raw.get("hooks") if isinstance(raw, dict) else None
        if hooks is None:
            hooks = {}
        return [e for e in js_keys(hooks) if re.search(r"/dist/hooks/run\.js", json.dumps(js_get(hooks, e), separators=(",", ":")))]
    except (OSError, ValueError):
        return None


def real_hooks_installed(env: Mapping[str, str | None] | None = None) -> bool | None:
    """True when settings.json has a hook command running odd-claude's `dist/hooks/run.js`; None when unreadable."""
    events = real_hook_events(env)
    return None if events is None else len(events) > 0


def flag_value(argv: list[str], name: str) -> str | None:
    """Value of `--name <value>` in argv; None when absent or empty."""
    if name not in argv:
        return None
    i = argv.index(name) + 1
    v = argv[i] if i < len(argv) else None
    return v if v and not v.startswith("--") else None


def env_with_data_dir(argv: list[str], env: Mapping[str, str | None]) -> dict[str, str | None]:
    """env with the data dir pinned to `--data-dir` when given (ODD_CLAUDE_DATA wins over every other source)."""
    d = flag_value(argv, "--data-dir")
    return dict(env) if d is None else {**env, "ODD_CLAUDE_DATA": d}
