# odd-claude

A Claude Code plugin that ports the ODD harness of gentle-shell (MIT) <!-- odd-check: allow --> to Claude Code. **v0.1 is the skeleton**: an installable plugin that declares its Engram dependency and can diagnose and configure itself. Personas, guards and review agents arrive in later phases (see [docs/roadmap.md](../../docs/roadmap.md)). The plugin collects no data and sends nothing anywhere.

## Requirements

- Claude Code >= 2.1.323 (the `engines.claude-code` value in `.claude-plugin/plugin.json`)
- Node >= 20
- git
- Optional: the `engram` plugin (declared as a dependency, `engram@engram`) or the `engram` binary; `codegraph`

`/odd-claude:doctor` reports which of these are present.

## Install

```
/plugin marketplace add <repo>
/plugin install odd-claude@odd-claude
```

For development, load the plugin from a checkout without installing:

```
claude --plugin-dir plugins/odd-claude
```

## Commands

- `/odd-claude:doctor`: checks node, git, engram, codegraph, plugin version and data dir; lists what is missing.
- `/odd-claude:status`: shows the current session state, registered hooks and the roadmap position.
- `/odd-claude:setup [default|acceptEdits|auto|plan|restore [backup]]`: opt-in writer for `permissions.defaultMode` in `~/.claude/settings.json` (the only key handled in v0.1).
  - Always shows a diff first and writes nothing until you explicitly confirm.
  - Before writing, the original file is copied to a backup under the plugin data dir (`backups/`), and only the listed key changes.
  - `restore` shows the diff back to the latest backup (or the named one) and applies it after confirmation. The current file is backed up first, so a restore is itself reversible.
  - Any other argument is refused.

### Setup limitations

- Re-serialization: the settings file is rewritten as JSON. Integers beyond 2^53 lose precision, `-0` becomes `0`, duplicate keys collapse, number forms are normalized and the file may be reformatted (indent is preserved). All of this is visible in the diff before you confirm.
- Very large settings files (more than about 15k lines) make the diff slow and memory hungry.
- `restore` without a name toggles between the last two states, because it backs up the current file first.

## Data directory

State lives under `${CLAUDE_PLUGIN_DATA}` (for an installed plugin `~/.claude/plugins/data/odd-claude-<marketplace>`; with `--plugin-dir` it is `odd-claude-inline`): `sessions/`, `backups/`, `logs/hooks.log` and `setup.json`.

## Development

From `plugins/odd-claude`:

```
npm install
npm run build   # tsc -> dist/
npm test        # build + node:test suite
npm run check   # naming / data-collection guard
```

`dist/` is committed so the plugin runs without a local `tsc`: **rebuild it (`npm run build`) and commit it with every source change.**

`claude plugin test plugins/odd-claude` applies once the mods layer (Phase 5) provides a hooks module; until then it reports `no hooks module to load`, and `npm test` is the test suite. Validate the manifests with `claude plugin validate plugins/odd-claude` and `claude plugin validate .`.

## License and attribution

MIT. This is a port of gentle-shell <!-- odd-check: allow --> (MIT); see [NOTICE](NOTICE).
