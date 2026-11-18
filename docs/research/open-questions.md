# Open questions (spikes before the roadmap)

Status of Q1, Q2, Q3, Q6, Q7 (all answered): see [Findings](#findings) (spiked 2026-11-18 on Claude Code 2.1.326). Q4 and Q5 were user decisions, **decided** 2026-11-18. Background in [claude-code-extensibility.md](claude-code-extensibility.md).

| # | Question | Why it matters | How to verify | Status |
|---|---|---|---|---|
| 1 | Are mods enabled on this account/build? | Mods are gated by server flag `tengu_plugin_hooks_modules` (unverified how it is rolled out); they decide whether the enhancement layer (custom tools, prompt sections, panes) is possible. | Hello-mod plugin loaded with `claude --plugin-dir`: `hooks/hooks.json` with `modules: ["./register.ts"]` that registers a tool, a `prompt.compose` section and a pane. Check each appears; also try in `-p` (expected off). | **answered** (mods load interactively and in `-p`; `prompt.*` unavailable to third-party mods) |
| 2 | Does output style `force-for-plugin` apply the persona without `/setup`? | Plugins cannot select an output style via settings; this field may be the only way to ship the persona. | Plugin with an output style with `force-for-plugin: true`; start a fresh session and inspect the system prompt/behaviour. | **answered** (yes) |
| 3 | Do plugin hooks run inside subagents, and can they tell them apart via `agent_type`? What exactly happens to ignored plugin-agent fields (`hooks`, `mcpServers`, `permissionMode`, `initialPrompt`)? | Guards (write/bash) and delegation rules must hold for subagents too. | Plugin with a logging `PreToolUse` hook and a plugin agent that edits a file; read hook stdin (`agent_id`, `agent_type`). Put ignored fields in the agent frontmatter and observe the warnings/effects. | **answered** |
| 4 | RDD (independent review): port using the gentle-ai Go binary, or ship odd-claude v1 without native review? | Decides scope and external dependencies of v1. | Read the review parts of `upstream/gentle-shell`; list what the binary provides vs. what hooks/agents could replace; prototype one review via a plugin agent. | **decided** (2026-11-18): v1 without native RDD; review with agents (four lenses + Judgment Day as agents + skill, advisory, no external binary); native RDD → **v2**. |
| 5 | Inter-session orchestrator messaging: `$.store` (mods) vs MCP channels? | `$.store` needs mods; channels are research preview and need `--dangerously-load-development-channels` for custom ones. | Spike both: write from one session and read from another (`$.store`); push via a minimal channel MCP server. | **decided** (2026-11-18): inter-session messaging → **v2** (out of v1). |
| 6 | How are MCP tools (engram/codegraph) named and granted inside plugin agents? | Plugin MCP tools are `mcp__plugin_<plugin>_<server>__<tool>`; agent `tools` allowlists must match. | Plugin agent with `tools:` listing such names; call the tool; also try a user-level MCP server. | **answered** (yes) |
| 7 | Exact mod types for this build. | Claude Code writes a `.d.ts` copy per version; `$.state`/namespaces need `types/index.d.ts`. | Follow the mods "create" docs, locate the generated `.d.ts` for v2.1.326, compile a mod against it. | **answered** (types written on first interactive `--plugin-dir` load) |

## Findings

All spikes live in [`../../spikes/`](../../spikes/README.md) and load only via `claude --plugin-dir` (session-only). Scratch cwd: `spikes/scratch/`. Raw evidence: `spikes/*/debug*.log`, `spikes/03-subagent-hooks/hook-log.jsonl`. Note: this machine's `claude` session also auto-loads a third-party `orca-agent-view` plugin dir and a `gentle-py` UserPromptSubmit hook (visible in debug logs); they are unrelated to the spikes.

### Q1 - Mods enabled? **Answered: yes, mods load interactively and in `-p`; `prompt.compose/section/context` are NOT available to third-party mods**

- `claude plugin test` from a dir with no mod: `no hooks module to load; there is no hooks/hooks.json naming one in "modules"`. Per the troubleshoot docs that message means mods can load (the "rollout switch served off" message was not shown).
- `claude plugin validate spikes/01-hello-mod`: `./register.ts hooks: session.start, tool.call{tool=mcp__odd-hello-mod__odd_ping}, prompt.compose, command.run{command=odd-hello}, ui.render{component=Pane}` and `calls: $.command.register, $.tool.register, $.ui.open, $.ui.resolve`.
- `claude plugin test spikes/01-hello-mod`: `(pass) odd-hello command replies` (1 pass, 0 fail). Test needs `on('ui.open', () => ({ value: { isPlaced: true } }))` stubbed.
- **Contradicts our section 10 note ("off in `-p`")**: `claude -p "/odd-hello" --plugin-dir spikes/01-hello-mod` printed `odd-hello-mod: hello from odd-hello-mod`; debug log: `hooks module odd-hello-mod@inline loaded (worker, environment 2, tier user); events: session.start,tool.call,prompt.compose,command.run,ui.render`; `plugin.register: ... judged by cc-plugin-sec-default: admitted`. The create docs also show `claude -p "/tally"` working.
- Custom tool works in `-p`: `$.tool.register` -> `mcp__odd-hello-mod__odd_ping` served on a loopback HTTP MCP server; haiku called it and answered ``odd_ping returned exactly: ODD-PONG``.
- **Prompt hooks do not reach third-party mods in `-p`**: `prompt.compose`, `prompt.section`, `prompt.context` each logged `its <event> hook was skipped. "cc-plugin-sec-default" runs first and sent the event on past it.`; model confirmed none of the 3 marker tokens was in its prompt/context. Whether they fire interactively is **unverified**. `prompt.submit` (documented `context` addition) was not tried.
- **Blocked: pane/`ui.*` and interactive behaviour.** No `tmux`; a pty driver (`spikes/tools/pty_drive.py`) reaches the "Do you trust this folder?" dialog for both the repo and `spikes/scratch`. Accepting it writes `~/.claude.json`, which the spike rules forbid, so it was not answered.
- Manual 3-step check for the user: (1) `cd spikes/scratch && claude --plugin-dir ../01-hello-mod --debug-file ../01-hello-mod/debug-tty.log` (accept trust yourself); (2) type `/odd-hello` (pane should show `ODD-PANE`; the transcript prints `odd-hello-mod: hello from odd-hello-mod`), then ask `do you see ODD-HELLO-SECTION-77 / ODD-SECTION-APPEND-55 / ODD-CONTEXT-BLOCK-66 in your system prompt?`; (3) `grep -i "hook was skipped\|not loaded" spikes/01-hello-mod/debug-tty.log`.
- **Interactive check (user-run, 2026-11-18, `spikes/01-hello-mod/debug-tty.log`)**: `hooks module odd-hello-mod@inline loaded (worker, environment 2, tier user); events: session.start,tool.call,prompt.compose,command.run,ui.render,prompt.section,prompt.context`. Pane: `ui.open odd-hello-mod odd-hello (asked, 167 columns): placed`, then `ui.render settled ... key=odd-hello`; the user confirmed the pane showed ODD-PANE (answer: "Sí, apareció"). `/odd-hello` output arrived and `mcp__odd-hello-mod__odd_ping` was listed among the deferred tools.
- **`prompt.*` blocked interactively too**: `odd-hello-mod: prompt.context bypassed by cc-plugin-sec-default (tier user); beneath runs`. The model reported none of ODD-HELLO-SECTION-77 / ODD-SECTION-APPEND-55 / ODD-CONTEXT-BLOCK-66 in its context, and harness notices said the `prompt.context`, `prompt.section` and `prompt.compose` hooks of odd-hello-mod were skipped because "cc-plugin-sec-default" runs first and passes the event on without calling them. Conclusion: the built-in `cc-plugin-sec-default` (tier prepend) bypasses `prompt.*` for third-party (tier user) mods in both interactive and `-p`.
- Works: panes (`ui.open` + `ui.render`), commands (`$.command.register`), tools (`$.tool.register`), in `-p` and interactive.
- (Earlier note, superseded: "interactive-only parts unverified".) Design impact: custom tools, commands and `$.process/$.fs` mods are usable headless; adding system prompt sections via `prompt.*` from a mod is **not** confirmed. Keep the persona on output styles (Q2) plus hook `additionalContext`; do not use mod `prompt.*`.

### Q2 - `force-for-plugin` output style: **Answered: yes**

`spikes/02-output-style` (style `odd-persona`, `force-for-plugin: true`, body "End every answer with the exact token ODD-MARKER-42 ..."). Fresh `claude -p "Say hi in 3 words." --model haiku --plugin-dir spikes/02-output-style`:
- with plugin: `'Hi there, friend.\n\nODD-MARKER-42'`; control without plugin: `'Hi there friend!'`.
- debug log: `Using forced plugin output style: odd-style-spike:odd-persona`. No `/setup` or settings change needed. Style id is namespaced `<plugin>:<style>`.
- Not tested: behaviour with a user-selected `outputStyle` in settings, or with several plugins forcing styles.

### Q3 - Plugin hooks in subagents / ignored fields: **Answered**

`spikes/03-subagent-hooks` (plugin `odd-subhook`, PreToolUse `*` hook appending stdin JSON; agent `odd-probe` with `permissionMode`, `initialPrompt`, `mcpServers`, `hooks`). Run: `claude -p "Use the Agent tool with subagent_type odd-subhook:odd-probe to write hello into probe-out.txt ..." --model haiku --permission-mode bypassPermissions`.
- Plugin hooks **do fire inside subagents**. `hook-log.jsonl`: main thread `{tool_name: Agent, agent_id: null, agent_type: null}`, subagent `{tool_name: Write, agent_id: "a870f5ca85d59543a", agent_type: "odd-subhook:odd-probe"}`. `agent_type` is the **namespaced** name `<plugin>:<agent>` and is absent for the main thread, so guards can distinguish both. File `probe-out.txt` was written.
- Ignored fields each emit a `[WARN]` in the debug log only: `Plugin agent file .../odd-probe.md sets permissionMode|hooks|mcpServers|initialPrompt, which is ignored for plugin agents. Use .claude/agents/ for this level of control.` `claude plugin validate` gives **no** warning for them (only agent listing `agents: odd-subhook:odd-probe`).
- `tools: Write, Read` was honoured (the agent used Write). Frontmatter `hooks` did not run (no extra effect observed). `permission_mode` in the hook payload was the parent's (`bypassPermissions`); parent and agent values coincided, so the agent's own value was not isolated.

### Q6 - MCP tools in plugin agents: **Answered: yes**

`spikes/06-agent-mcp` (plugin `odd-mcp`, `.mcp.json` server `oddsrv` = node stdio JSON-RPC, tool `ping`).
- Tool name is `mcp__plugin_odd-mcp_oddsrv__ping` (plugin name hyphen kept; log server id `plugin:odd-mcp:oddsrv`). Agent `odd-mcp:odd-mcp-probe` with `tools: mcp__plugin_odd-mcp_oddsrv__ping` called it: debug `Calling MCP tool: ping ... completed successfully in 2ms`, answer `ODD-MCP-PONG`. Control agent with `tools: Read` replied `NO-PING-TOOL` (0 tool uses), so the allowlist is what grants it.
- User-level (session) server: `--mcp-config spikes/06-agent-mcp/extra/mcp.json` (server `oddsrv2`) + `--agents` JSON with `tools: ["mcp__oddsrv2__ping"]` -> agent returned `ODD-MCP-PONG`. (A first attempt with a wrong server path failed with `Agent 'odd-ext' would be spawned with zero tools - refusing. ... unrecognized [mcp__oddsrv2__ping]`: an allowlist naming an unavailable MCP tool makes the launch fail rather than silently dropping it.) A real `~/.claude` user server was not touched.
- Implication: ship agents with the full `mcp__plugin_<plugin>_<server>__<tool>` names; engram/codegraph are only grantable when that server is actually connected.

### Q7 - Mod types for this build: **Answered**

- Types are written to `<plugin>/.claude-plugin/types/` on the first **interactive** `--plugin-dir` load (user-run, 2026-11-18). On disk now: `spikes/01-hello-mod/.claude-plugin/types/claude-code/index.d.ts`, `claude-code-mcp/index.d.ts`, `claude-code-tools/index.d.ts` and `tsconfig.json` (target es2023, strict, `typeRoots: ["."]`). `-p` runs and `plugin validate/test` do not write them. `claude plugin init` was not run (it scaffolds into `~/.claude/skills/`).
- Typecheck: `claude plugin validate` and `claude plugin test` typecheck against the build's embedded declarations (earlier finding: `tests/hello.test.ts ... TS2345 ... CommandRunInput` reported as a warning). `tsc` is on PATH here but broken (`Unable to resolve @typescript/typescript-darwin-arm64`; typescript 7.0.2 without its platform package), so `tsc -p spikes/01-hello-mod/.claude-plugin/types/tsconfig.json --noEmit` could not run and nothing was installed. `npx tsc -p spikes/01-hello-mod` works only where a functioning `tsc` is already available; otherwise rely on `claude plugin validate/test`.
- Earlier workaround kept: `as any` in the test input for `CommandRunInput`.

### Q4 / Q5 - User decisions (2026-11-18)

- **Q4:** "v1 sin RDD nativo; review con agentes (Recomendado)": the four lenses (risk/resilience/readability/reliability) and Judgment Day as agents + skill, advisory; no external binary; native RDD → **v2**.
- **Q5:** "Fuera de v1 (Recomendado)": inter-session orchestrator messaging (R07) → **v2**.

### Design impact of the spikes

- Phase 1 persona ships through the forced output style (Q2), no `/setup` needed; `/setup` keeps only settings-only items.
- Guards can target subagents by `agent_type` `<plugin>:<agent>` (Q3); the main thread has `agent_type` null.
- Agent `tools:` allowlists use full `mcp__plugin_<plugin>_<server>__<tool>` names (Q6).
- Mods are usable for tools, commands and panes, headless and interactive (Q1); `prompt.compose/section/context` are blocked for third-party mods by `cc-plugin-sec-default`, so system-prompt shaping uses forced output style + SessionStart/UserPromptSubmit `additionalContext`.
