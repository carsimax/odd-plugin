# odd-claude

odd-claude ports the ODD harness to Claude Code. It installs globally (`~/.claude` + `~/.odd-claude`) with a TUI and scripts; it is no longer a Claude Code plugin.

## Quick path

Requirements: Node >= 22, `gh` authenticated (the repository is private), `jq` (status line).

```
gh api repos/carsimax/odd-plugin/contents/scripts/install.sh -H "Accept: application/vnd.github.raw" | sh
```

Pin a release: `... | sh -s -- --version <v>`. From a checkout:

```
npm --prefix plugins/odd-claude/tui ci && npm --prefix plugins/odd-claude/tui run bundle && node plugins/odd-claude/tui/dist/odd-claude.mjs install --source plugins/odd-claude
```

| Goal | Command (`odd-claude.mjs` = the bundled TUI, run with `node`) |
|---|---|
| Update | `odd-claude.mjs update` |
| Roll back | `odd-claude.mjs rollback [--to <version>]` |
| Uninstall | `odd-claude.mjs uninstall [--purge]` |

## Migrating from the plugin

The installer detects `odd-claude@*`, uninstalls it and copies its state from `~/.claude/plugins/data/odd-claude-*`. Names changed: `/odd-claude:profiles` -> `/odd-profiles` (same for every command), agent `odd-claude:odd-worker` -> `odd-worker`, MCP `mcp__plugin_odd-claude_review__*` -> `mcp__odd-review__*`. Details in the [README](plugins/odd-claude/README.md#migrating-from-the-plugin).

## More

- [odd-claude README](plugins/odd-claude/README.md): install, commands, development
- [Docs](docs/README.md): decisions and research
- [Roadmap](docs/roadmap.md): phases and status
