"""Root of the odd-claude install (the dir holding package.json, agents/, dist/ ...), port of v9 lib/root.ts.
Resolution: `CLAUDE_PLUGIN_ROOT` when set and non-empty, else the module location. v9's root is `<root>/dist/lib/root.js` three
segments up; the Python module `<repo>/src/odd_claude/lib/root.py` maps to the same install root, `<repo>/plugins/odd-claude`,
so v9-observable outputs (e.g. the consent off-switch command) are identical.
shortcut: assumes a source checkout layout; a wheel install has no `plugins/`, upgrade when Phase 8.5 retires the TS tree."""
import os
from pathlib import Path
from typing import Mapping


def module_root() -> str:
    """The root derived from where this module lives; never reads the environment."""
    return str(Path(__file__).resolve().parents[3] / "plugins" / "odd-claude")


def odd_claude_root(env: Mapping[str, str | None] | None = None) -> str:
    """Legacy: `CLAUDE_PLUGIN_ROOT` is only set by the removed plugin distribution (bench still sets it)."""
    from_env = (os.environ if env is None else env).get("CLAUDE_PLUGIN_ROOT")
    return from_env if isinstance(from_env, str) and from_env != "" else module_root()
