"""Differential: lib/root against v9 dist/lib/root.js through the oracle. The Python root is `<repo>/plugins/odd-claude`, which
is exactly where v9's `<root>/dist/lib/root.js` resolves, so both outputs are equal."""
from odd_claude.lib.root import module_root, odd_claude_root

from .v9_oracle import needs_v9, v9, v9_many

pytestmark = needs_v9

ENVS = [{}, {"CLAUDE_PLUGIN_ROOT": ""}, {"CLAUDE_PLUGIN_ROOT": "/opt/odd root"}, {"CLAUDE_PLUGIN_ROOT": "relative/x"}, {"CLAUDE_PLUGIN_ROOT": " "}, {"OTHER": "1"}]


def test_module_root_equals_v9():
    assert module_root() == v9("root", "moduleRoot")


def test_odd_claude_root_equals_v9_for_every_env():
    for env, want in zip(ENVS, v9_many("root", "oddClaudeRoot", [[e] for e in ENVS])):
        assert odd_claude_root(env) == want, env


def test_default_env_reads_the_process_environment(monkeypatch):
    for value in ("", "/x y", "rel"):
        monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", value)
        assert odd_claude_root() == v9("root", "oddClaudeRoot", env={"CLAUDE_PLUGIN_ROOT": value}), value
