# Claude Code extensibility (plugins focus)

Verified locally: Claude Code **v2.1.326** (`claude --version`). Docs fetched 2026-11-18. Source IDs map to URLs in [Sources](#sources). Items marked *(unverified)* were not confirmed on this machine.

## 1. Plugin layout [plugins/components]

```
my-plugin/
├── .claude-plugin/plugin.json   # optional; only `name` required
├── skills/<name>/SKILL.md
├── commands/*.md                # merged into skills
├── agents/*.md
├── hooks/hooks.json
├── .mcp.json   .lsp.json
├── output-styles/   themes/   workflows/*.js   monitors/monitors.json
└── bin/                         # added to the Bash tool PATH
```

A plugin-root `CLAUDE.md` is **not** loaded.

### Manifest fields [plugins-reference]

| Group | Fields |
|---|---|
| Metadata | `$schema`, `displayName`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `metadata`, `defaultEnabled`, `engines{"claude-code"}` (>=2.1.323) |
| Components | `skills` (adds), `commands` (replaces; path/array/object with `source`\|`content`, `description`, `argumentHint`, `model`, `allowedTools`), `agents` (replaces), `hooks` (merges), `mcpServers`, `lspServers`, `outputStyles`, `workflows`, `experimental.themes/monitors/evals`, `channels` |
| Other | `dependencies` (`"name"`, `"name@marketplace"`, or `{version}`), `userConfig`, `types` (`.d.ts` for mods) |

- `userConfig` entries: type `string|number|boolean|directory|file`; options `sensitive` (→ keychain), `options`, `multiple`, `min`/`max`, `required`, `default`. Referenced as `${user_config.KEY}`; in shell hooks as `$CLAUDE_PLUGIN_OPTION_<KEY>`.
- Unknown top-level fields are stripped with a warning.

### Variables

| Variable | Notes |
|---|---|
| `${CLAUDE_PLUGIN_ROOT}` | Changes on every update; keep no state there. |
| `${CLAUDE_PLUGIN_DATA}` | `~/.claude/plugins/data/<id>/`; persists across updates; removed on uninstall unless `--keep-data`. |
| `${CLAUDE_PROJECT_DIR}` | Project root. |

Not exported to the Bash tool environment [plugins-reference].

## 2. Distribution [plugin-marketplaces, plugins/marketplace-reference, plugins/cli-reference]

- `.claude-plugin/marketplace.json`: `name`, `owner`, `plugins[]`.
- Plugin sources: relative path, `github{repo,ref,sha}`, `url`, `git-subdir`, `npm` (no install scripts), `archive{url,sha256}`, `command`. `strict` mode controls whether the plugin manifest or the marketplace entry is authoritative.
- Scopes: user / project / local (+ managed).
- CLI (`claude plugin --help` locally): `install`, `uninstall`, `enable`, `disable`, `update`, `list`, `validate`, `init` (`--with skills,agents,hooks,mcp,lsp,output-style,channel`), `details` (component inventory + token cost), `configure`, `eval`, `test` (mod tests), `tag`, `prune`.
- Session-only loading: `--plugin-dir`, `--plugin-url`. `/reload-plugins` reloads in session.
- Auto-update defaults to on only for official marketplaces.

## 3. Namespacing

| Component | Name |
|---|---|
| Skill/command | `/<plugin>:<skill>` |
| Agent | `<plugin>:<name>` |
| MCP tool | `mcp__plugin_<plugin>_<server>__<tool>` |

## 4. What a plugin cannot ship [plugins-reference, settings, keybindings, statusline]

- `settings.json` keys: `permissions`/`defaultMode`, `env`, `model`, `agent`, output-style *selection*, `statusLine`, `spinnerVerbs`, `apiKeyHelper`, `sandbox`.
- `keybindings.json` (user file only), model providers.
- Plugin agents **ignore** `hooks`, `mcpServers`, `permissionMode`, `initialPrompt` frontmatter [sub-agents].
- Output styles have a `force-for-plugin` field; verified working on 2.1.326: the style applies without `/setup` (see [open-questions.md Findings Q2](open-questions.md#findings)).

## 5. Hooks [hooks]

**33 events**: SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult, SessionEnd.

- **Handler types**: `command` (exec-form `args`, `async`, `asyncRewake`, `shell`, `onFailure`), `http`, `mcp_tool`, `prompt`, `agent` (experimental).
- **Common fields**: `if`, `timeout` (600s default; 30 prompt; 60 agent), `statusMessage`, `once`.
- **Input**: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `agent_id`/`agent_type`, `tool_name`/`tool_input`.

| Event | Output controls |
|---|---|
| PreToolUse | `permissionDecision` allow/deny/ask/defer, `updatedInput`, `additionalContext` |
| PostToolUse | `block`, `additionalContext`, `updatedToolOutput` |
| UserPromptSubmit | `block`, `additionalContext`, `sessionTitle` (cannot rewrite the prompt) |
| Stop / SubagentStop | `decision: block` to force continuation |
| SessionStart | `additionalContext`, `initialUserMessage`, `sessionTitle`, `watchPaths`, `reloadSkills` |
| any | exit code 2 blocks; `additionalContext` capped at 10,000 chars |

## 6. Subagents [sub-agents]

- Frontmatter: `name`, `description`, `tools`, `disallowedTools`, `model` (alias/id/`inherit`), `permissionMode`, `maxTurns`, `autoCompactWindow`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `omitClaudeMd`, `effort`, `isolation: worktree`, `color`, `initialPrompt`.
- Priority: managed > `--agents` > project > user > plugin.
- Nesting up to 3 levels below main; 20 concurrent by default.
- Agent teams/teammates exist *(mechanics unverified)*.

## 7. Skills, styles, memory, UI

- **Skills** [skills]: `name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `background`, `hooks`, `paths`, `shell`; `$ARGUMENTS`/`$N`; `` !`cmd` `` dynamic injection; commands merged into skills.
- **Output styles** [output-styles]: `name`, `description`, `keep-coding-instructions`, `force-for-plugin`; they append to the system prompt, not replace it wholesale.
- **Memory** [memory]: `CLAUDE.md`, `.claude/rules/*.md` with `paths` globs, `@imports` (4 hops), `AGENTS.md`.
- **Status line** [statusline]: settings-only command; JSON on stdin incl. `model`, `context_window`, `rate_limits`; `refreshInterval`; no widgets.
- **Themes**: via plugin `experimental.themes`. **Keybindings**: user file only [keybindings].

## 8. MCP and channels [mcp, channels]

- Transports: stdio / http / sse / ws. `MAX_MCP_OUTPUT_TOKENS` 25k.
- Elicitation (form + url) gives structured user input.
- Channels (`claude/channel` push into a session): research preview; custom ones need `--dangerously-load-development-channels`.

## 9. Built-in tools and flags

- Tools: Bash (`run_in_background`), Monitor, Read/Write/Edit/NotebookEdit, Glob/Grep, WebFetch/WebSearch, Agent, Skill, AskUserQuestion, TodoWrite, TaskCreate/Get/List/Update, EnterWorktree/ExitWorktree, CronCreate/Delete/List, ScheduleWakeup, SendMessage, LSP, Workflow.
- Flags of note: `--agent`, `--agents`, `--append-system-prompt`, `--plugin-dir`, `--bare`, `--safe-mode`, `--restricted`, `--fallback-model`, `--bg`, `-p` with `stream-json` [headless].

## 10. Mods (key finding) [plugins/mods/overview, plugins/mods/api, plugins/mods/reference; local binary strings]

A plugin's `hooks/hooks.json` with `modules: ["./register.ts"]` loads **one** in-process ES module (js/mjs/cjs/jsx/ts/mts/cts/tsx; static relative imports only, no `require`/dynamic import) exporting `register(on, options)`. Middleware model: `next(e)`.

- Hot reload with `--plugin-dir`. Tests `*.test.ts` using kit `claude-code/testing`, run by `claude plugin test`. `types/index.d.ts` needed for `$.state`/namespaces.
- **Limits**: 10s per event (50ms for `prompt.edit`); `$.process.run` 30s default (max 10min); 4MiB stdout/file; `$.http` 30s.
- **Policies**: `allowManagedModsOnly`, `disableAllHooks`; `sec-default@builtin` runs first; `plugin.register` lets mods refuse other mods.
- **Gating**: server flag `tengu_plugin_hooks_modules`; a third-party blog says "preview behind a flag" *(unverified)*. **Spike (2.1.326, [open-questions.md Findings Q1](open-questions.md#findings)): mods do load in `-p`** (`command.register` and `tool.register` worked), and the interactive check confirmed panes (`ui.open` + `ui.render`). `prompt.compose`, `prompt.section` and `prompt.context` are **blocked for third-party (tier user) mods in both `-p` and interactive**: the built-in `cc-plugin-sec-default` (tier prepend) bypasses them. System-prompt shaping must therefore use a forced output style + SessionStart/UserPromptSubmit `additionalContext`, never mod `prompt.*`. Off in SDK/cloud and in safe/bare mode (docs, not tested here); works in terminal, Desktop, VS Code; needs >=2.1.287. Code mode refuses when plugins have JS hooks checking tool calls.

### Events

| Area | Events |
|---|---|
| Tools | `tool.call` (`{deny}`\|`{result}`\|rewrite), `tool.check` (allow/ask/deny), `tool.describe` |
| Prompt | `prompt.submit` (add context/drop), `prompt.fill/suggest/edit/autocomplete`, `prompt.compose` (`{sections:[{id,text,scope}]}`), `prompt.section`, `prompt.context` (`{blocks}`), `prompt.attachment`, `prompt.mention`, `skill.prompt`, `attribution.text` |
| Commands/config | `command.run/describe`, `config.set/describe`, `settings.read` |
| Turn | `turn.start`, `turn.step` (change model/effort), `turn.complete` |
| Session | `session.start/end/compact/receive/send/append/attach/detach/measure` |
| Agents | `agent.offer`, `agent.spawn` (`next({...e,model})` or deny) |
| UI | `ui.render`, `ui.resolve`, `ui.press/input/select/focus/scroll/close/message/fault` |
| Other | `plugin.register`, `engine.create`, `telemetry.*`, `classic.<SettingsHookEvent>`; every `$` call is also an interceptable event |

### `$` API

| Namespace | Members |
|---|---|
| plugin / command | `plugin(name,root)`; `command.register/run/list` |
| tool | `tool.register({name,description,inputSchema,isDeferred})` → `mcp__<plugin>__<name>`; `call/check/list` |
| agent / model | `agent.register/spawn/call/list/limits`; `model.complete/fork/classify` |
| prompt / turn | `prompt.submit/read/fill/suggest/compose`; `turn.abort` |
| session | `messages/cwd/root/model/turns/id/repo/surfaces/usage/version/compact/send/append/authorize` |
| config/env | `config.list/set`; `settings.read`; `env.get/set` |
| storage | `fs.read/write/list/exists/stat/ancestors` (non-atomic write); `store` (cross-session machine KV, 4MiB); `state` (per-session reactive) |
| runtime | `clock.now/sleep/after/every`; `http.fetch`; `process.run/spawn`; `mcp.call/connect` (own manifest servers only); `audio.play/speak` |
| UI | `theme.set/clear` (Desktop/mobile only); `ui.resolve/invalidate/open/close/panes/place/focus/scroll/toast/notify/status/log/notice/ask` (2-4 options, header<=12)`/copy/selection/blit/view` |
| other | `wasm.compile` (undocumented); `telemetry` (built-ins only) |

**Render sites**: Pane (dock/inline), AbovePrompt, AbovePromptList, Placed, Backdrop (Desktop), UserMessage, AssistantMessage, ToolUse, ToolResult, ToolGroup, CommandOutput, AskUserQuestion (redraw only), ToolProgress, Spinner, TurnDuration, InfoNotice, SessionMode, PromptHint. Panes opened unasked seat from 144 cols. Mods cannot change the permission dialog.

**Corrections to earlier assumptions**: no `scan`/capabilities manifest is read anymore; `$.ui.mount` and `$.session.start` are test-kit only; `$.classic.PreToolUse` is an event, not a call.

## 11. Capability summary

| Capability | Plugin can ship | Mechanism | Source |
|---|---|---|---|
| Skills / slash commands | yes | `skills/`, `commands/` | plugins/components |
| Subagents | partial | `agents/` (hooks, mcpServers, permissionMode, initialPrompt ignored) | sub-agents |
| Guards / context injection | yes | `hooks/hooks.json` (33 events, PreToolUse deny/updatedInput) | hooks |
| Persona / system-prompt text | partial | output style (`force-for-plugin`, verified Q2) + hook `additionalContext`; mod `prompt.*` is blocked for third-party mods (Q1) | output-styles, mods |
| MCP servers | yes | `.mcp.json` / `mcpServers` | mcp |
| Custom tools in-process | partial | mods `$.tool.register` (flag-gated) | mods/api |
| Bin helpers | yes | `bin/` on Bash PATH | plugins/components |
| Per-user config | yes | `userConfig` | plugins-reference |
| Dependencies on other plugins | yes | `dependencies` | plugins-reference |
| Persistent state | yes | `${CLAUDE_PLUGIN_DATA}`; mods `$.store` | plugins-reference |
| Themes | partial | `experimental.themes` | plugins-reference |
| Status line | no | settings `statusLine` only | statusline |
| Permissions / env / model / agent default / sandbox | no | settings only | settings |
| Keybindings | no | user `keybindings.json` | keybindings |
| Model providers | no | n/a | plugins-reference |
| Rich UI (panes, toasts) | partial | mods `ui.*`; terminal/Desktop/VS Code (pane verified interactively, Q1; `-p` unverified) | mods/api |

## 12. Design implications for odd-claude

1. **Critical behaviour must work with classic hooks.** The ODD prompt injection and guards (SessionStart/UserPromptSubmit `additionalContext`, PreToolUse deny) cannot depend on mods, which are flag-gated, with `prompt.*` hooks blocked for third-party mods by `cc-plugin-sec-default` in `-p` and interactive (Findings Q1) and off in safe/bare mode.
2. **Mods are an enhancement layer only**, with graceful degradation: the plugin must be fully functional if `modules` is not loaded.
3. **Settings-only items** (status line, permissions defaults, default agent, output-style selection, env) need an explicit, opt-in `/odd-claude:setup` command that shows the proposed changes and writes them with user consent.
4. Subagent guarantees depend on spike #3 (hooks inside subagents) in [open-questions.md](open-questions.md).
5. Follow the naming convention in [../README.md](../README.md#naming-convention).

## Sources

| ID | URL |
|---|---|
| plugins-reference | https://code.claude.com/docs/en/plugins-reference |
| plugins | https://code.claude.com/docs/en/plugins |
| plugin-marketplaces | https://code.claude.com/docs/en/plugin-marketplaces |
| hooks | https://code.claude.com/docs/en/hooks |
| sub-agents | https://code.claude.com/docs/en/sub-agents |
| skills | https://code.claude.com/docs/en/skills |
| output-styles | https://code.claude.com/docs/en/output-styles |
| statusline | https://code.claude.com/docs/en/statusline |
| keybindings | https://code.claude.com/docs/en/keybindings |
| mcp | https://code.claude.com/docs/en/mcp |
| settings | https://code.claude.com/docs/en/settings |
| memory | https://code.claude.com/docs/en/memory |
| plugins/components | https://code.claude.com/docs/en/plugins/components |
| plugins/marketplace-reference | https://code.claude.com/docs/en/plugins/marketplace-reference |
| plugins/loading | https://code.claude.com/docs/en/plugins/loading |
| plugins/cli-reference | https://code.claude.com/docs/en/plugins/cli-reference |
| channels | https://code.claude.com/docs/en/channels-reference |
| mods overview | https://code.claude.com/docs/en/plugins/mods/overview |
| mods api | https://code.claude.com/docs/en/plugins/mods/api |
| mods reference | https://code.claude.com/docs/en/plugins/mods/reference |
| headless | https://code.claude.com/docs/en/headless |
| CHANGELOG | https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md |
