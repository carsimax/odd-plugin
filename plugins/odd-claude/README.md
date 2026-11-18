# odd-claude

A Claude Code plugin that ports the ODD harness of gentle-shell (MIT) <!-- odd-check: allow --> to Claude Code. **v0.2 is the declarative core**: the ODD persona, orchestrator cards, agents, skills and native integrations, all as text and configuration. Guards (enforcement code) arrive in later phases (see [docs/roadmap.md](../../docs/roadmap.md)). The plugin collects no data and sends nothing anywhere.

## What v0.2 ships

- **Persona / output style `odd`** (`output-styles/odd.md`, `force-for-plugin: true`, so no `/setup` is needed). SessionStart and UserPromptSubmit hooks add `additionalContext` with the rest of the prompt and the path of the cards. Replies follow the user's language.
- **Persona modes**: `/odd-claude:persona [mentor|neutral]` stores the mode in the plugin data dir; it applies from the next session start (or `/clear`).
- **Cards** (`cards/*.md`): orchestrator rules loaded on demand (delegation, tracking, verification, memory, skills, prompts, writer, quota recovery), with tool names mapped to Claude Code (`Agent`, `TodoWrite`, `AskUserQuestion`, `Bash` with `run_in_background`, `Monitor`, worktree tools). See `cards/SOURCES.md`.
- **Agents** (listed as `odd-claude:<agent>`): `odd-explore` (read-only), `odd-verify` (runs checks), `odd-worker` (scoped writer), `odd-jd-fix`, `odd-jd-judge-a`, `odd-jd-judge-b` (Judgment Day).
- **Skills** (`odd-claude:<skill>`): `odd`, `branch-pr`, `chained-pr`, `cognitive-doc-design`, `comment-writer`, `issue-creation`, `judgment-day`, `skill-creator`, `skill-creation`, `skill-improver`, `skill-registry`, `tui-design`, `ui-design`, `work-unit-commits`, plus the commands `doctor`, `status`, `setup`, `persona`, `background-subagents`.
- **Support docs** (`support/`): test-first policy and the `odd/tasks/<feature>.md` format. **Sounds**: `assets/sounds/` (original tones, see its LICENSE).

### Background subagents

`/odd-claude:background-subagents [enable|disable|status]` sets a policy (default off; env `ODD_CLAUDE_BACKGROUND_SUBAGENTS=on|off` is the fallback). When on, the session context tells the orchestrator to launch independent `Agent` work with `run_in_background: true`. Note that Claude Code itself runs subagents in the background by default.

### Skill registry

On SessionStart the hook reads the existing `.atl/skill-registry.md` (one context line) and starts a detached, locked refresh in the background, so the registry is written or updated without delaying session start (the first start in a project has no line yet; the next start does). The registry is an index of project, user and plugin skills by trigger and path, plus `.atl/.gitignore`. Run it on demand with `/odd-claude:skill-registry`. Another tool may also write `.atl/skill-registry.md`; to stop odd-claude from touching it set `ODD_CLAUDE_NO_SKILL_REGISTRY=1`. Git-tracked registries are preserved on automatic refresh.

### codegraph MCP

The plugin declares a `codegraph` MCP server (`.mcp.json`, needs the `codegraph` binary). Tool names depend on who provides the server:

- plugin server: `mcp__plugin_odd-claude_codegraph__codegraph_explore`
- user-level `codegraph` server: Claude Code suppresses the plugin one ("duplicates manually-configured") and the tool is `mcp__codegraph__codegraph_explore`.

Agent allowlists list both names; a name that is not connected is ignored. The SessionStart warm-up (detached `codegraph sync`) is **off by default**: a `.codegraph/` directory comes from the repository and is not a trust signal. Opt in per project: `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/codegraph-trust.js" --action trust --cwd <project>` (records the path in plugin state; `--action untrust` / `--action list`). There is no environment-variable opt-in: a repository can set env through its own `.claude/settings.json`, so only the trust list the user writes counts.

When trusted and an index exists, SessionStart syncs it. Repeated starts do not overlap: an in-flight lock per project (`<data dir>/locks`, replaced when its process is gone or after 6 minutes) skips the spawn. Other flags: `ODD_CLAUDE_CODEGRAPH_INIT=1` also runs `codegraph init` in a trusted project with no index (opt-in); `ODD_CLAUDE_NO_CODEGRAPH_WARMUP=1` disables the warm-up. It never runs in a home or broad directory.

### Engram tool names

Memory tools are `mem_*`: `mcp__engram__mem_*` when the engram MCP is configured at user level, or `mcp__plugin_engram_engram__mem_*` if an engram plugin ships its own server (`engram@engram` 0.1.22 does not). `odd-worker` lists both `mem_save` names.

### Subagents cannot ask questions

Claude Code removes `AskUserQuestion` from every subagent (verified on 2.1.327). A child that needs a human decision returns `status: interaction_required` and the orchestrator relays it; see `cards/prompts.md`.

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
