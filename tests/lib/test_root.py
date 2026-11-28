"""Port of v9 lib/root.spec.ts. Python's "plugin root" is the v9 install root `<repo>/plugins/odd-claude` (the dir holding
package.json, agents/, dist/), found from this module's location, so the off-switch command keeps naming the real review-mode CLI."""
from pathlib import Path

from odd_claude.lib.root import module_root, odd_claude_root


def test_claude_plugin_root_wins_when_set_and_non_empty():
    assert odd_claude_root({"CLAUDE_PLUGIN_ROOT": "/opt/odd root"}) == "/opt/odd root"


def test_without_the_env_or_empty_the_root_is_the_module_relative_package_root():
    assert odd_claude_root({}) == module_root()
    assert odd_claude_root({"CLAUDE_PLUGIN_ROOT": ""}) == module_root()
    assert (Path(module_root()) / "package.json").exists()
    assert (Path(module_root()) / "agents").exists()


def test_default_env_is_the_process_environment(monkeypatch):
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", "/from/env")
    assert odd_claude_root() == "/from/env"
    monkeypatch.delenv("CLAUDE_PLUGIN_ROOT")
    assert odd_claude_root() == module_root()


def test_module_root_is_absolute_and_normalized():
    r = module_root()
    assert r.startswith("/") and ".." not in r and not r.endswith("/")
