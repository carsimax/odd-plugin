# Portability matrix: gentle-shell → odd-claude

One row per runtime feature (`R##`) and content asset (`A##`) of the upstream, as described in [gentle-shell-inventory.md](./gentle-shell-inventory.md). Claude Code mechanisms are defined in [claude-code-extensibility.md](./claude-code-extensibility.md); unresolved choices are in [open-questions.md](./open-questions.md); doc index in [../README.md](../README.md).

Upstream paths are relative to `upstream/gentle-shell/`. Verdicts are **proposals** from reading the upstream plus the capability facts below; items marked "verify" depend on a Claude Code behavior that must be confirmed in a spike.

## Naming convention

odd-claude is its own plugin. **No `gentle-` / `gentle-ai` prefix is used anywhere in the port; the prefix is `odd`.** Upstream names appear only in the "Feature" and "Upstream paths" columns as source references.

| Upstream | odd-claude |
|---|---|
| plugin / package `gentle-pi`, `gentle-shell` | plugin `odd-claude` |
| agents `gentle-ai-worker` / `-explore` / `-verify` | `odd-worker` / `odd-explore` / `odd-verify` |
| agents `jd-*`, `review-*` | `odd-jd-fix`, `odd-jd-judge-a`, `odd-jd-judge-b`, `odd-review-risk`, `odd-review-resilience`, `odd-review-readability`, `odd-review-reliability` |
| skills `gentle-ai-<x>` | `<x>` under plugin namespace (`odd-claude:<x>`); `gentle-ai` skill → `odd`; `gentle-design` → `design`; `gentle-ui-design` → `ui-design` |
| Pi tools `gentle_review*`, `gentle_odd_phase`, `gentle_design*`, `gentle_guide` | `odd_review*`, `odd_phase`, `odd_design*`, `odd_guide` |
| slash commands `/gentle:<x>` | `/odd-claude:<x>` (plugin command namespace) |
| env vars `GENTLE_PI_*` | `ODD_*` (`GENTLE_PI_AGENTS_CHILD` → `ODD_AGENT_CHILD`, assets root → `${CLAUDE_PLUGIN_ROOT}`) |
| XML-ish prompt tags `<gentle-auto-permissions>` etc. | `<odd-…>` |
| Pi-native tools (`subagent_*`, `todo`, `ask_user_*`, `bash_background`) | no odd name: replaced by the native Claude Code tool (shown in the mechanism column) |
| brand assets (logo, themes named Gentle*) | renamed or dropped; see A29, A50 and `TRADEMARKS.md` |

Binding decisions applied to the verdicts: **no telemetry** of any kind (R37, A49 are ❌ and no telemetry mechanism is proposed anywhere), and **upstream-only** sourcing (no other project is used as a reference).

## Capability facts used (summary; details in the extensibility doc)

- Plugins ship: skills, commands, agents, hooks (33 events), MCP servers, output styles, themes, `bin/`, `userConfig`, `dependencies`, and **mods** (in-process TS modules declared in `hooks/hooks.json` `modules`; APIs `$.tool.register`, `prompt.compose`, `agent.spawn` hook, `ui` panes/status/toast/ask, `command.register`, `model.complete`, store/state, audio).
- Mods may be gated/preview and are off in `-p`/SDK runs → anything essential must have a non-mod path.
- Plugins **cannot write settings**: `statusLine`, `defaultMode`, output-style selection, keybindings and providers need a user step (an `/odd-claude:setup` command).
- Plugin agents ignore `permissionMode` / `hooks` frontmatter → enforcement goes through plugin hooks keyed by agent type.
- Native equivalents exist for: Agent tool (background, resume, nesting ≤3), TodoWrite/Tasks, AskUserQuestion, Bash `run_in_background` + Monitor, native worktree tools, auto mode, history, image paste, vim mode.

Verdict legend: ✅ 100% (copy, rename tool names) · 🟡 adaptation (different mechanism or partial) · ❌ not portable / not needed / excluded by decision.
Mods column: **no** = works without mods · **optional** = better UX with a mod, fallback exists · **yes** = needs a mod.
Effort: S ≤ 1 day · M ≈ days · L ≈ weeks / needs a spike.

---

## 1. Runtime features

| ID | Feature | Upstream paths | odd-claude name | Verdict | Claude Code mechanism | Mods? | External deps | Effort | Notes |
|---|---|---|---|---|---|---|---|---|---|
| R01 | Orchestrator ODD prompt | `extensions/gentle-ai.ts:13053,1698,1490,1513,1389`; `assets/orchestrator*.md` | output style `odd`; `hooks` SessionStart | 🟡 | Output style carries the core prompt; SessionStart `additionalContext` injects state and the path of lazy cards (`${CLAUDE_PLUGIN_ROOT}/cards/`); placeholders become env/`${CLAUDE_PLUGIN_ROOT}` | optional (`prompt.compose`) | – | M | Output-style *selection* cannot be written by a plugin → `/odd-claude:setup`; or inject the whole prompt through SessionStart instead. Decision needed |
| R02 | Persona & delegation mode | `extensions/gentle-ai.ts:3052,1675`; `lib/orchestrator-mode-policy.ts` | `/odd-claude:persona` | 🟡 | Command writes a state file; SessionStart hook reads it and selects the card set (standard / full delegation) | optional | – | S | Full-delegation = deny Edit/Write in the main thread via PreToolUse (see A15) |
| R03 | Review provider contract fragment | `extensions/gentle-ai.ts:1545,1618`; `contracts/review-provider-contract-mirror/v1.6.0` | part of `odd_review` | 🟡 | Contract text injected by SessionStart when RDD is on | optional | review binary (R29) | M | Moves with R29; mirror contract already lists `claude-code` as a host |
| R04 | Child context filtering | `extensions/child-context.ts`; `lib/child-context-files.ts` | – | ❌ | Not needed: subagents have isolated context natively | no | – | – | Not needed; verify that `CLAUDE.md` loading in subagents is acceptable (no equivalent of the filter) |
| R05 | Subagent runtime | `extensions/gentle-agents.ts`; `lib/agents-runner.ts:519` (`pi --mode rpc`); `agents-protocol.ts`; `agents-config.ts` | native Agent tool (`odd-*` agents) | 🟡 | Native Agent tool: foreground/background, resume, nesting ≤3; `subagent_status/result/continue/cancel/list_*` map to native task management | no | – | M | The whole runner/RPC/transport stack is dropped. Behaviors to re-create: admission (R26–R28), depth bookkeeping, report cap (`agents-report-cap.ts`) |
| R06 | Child→parent messaging (`subagent_parent_message`) | `extensions/gentle-agents.ts:408` | – | 🟡 | Child returns result to parent natively; no mid-run push | optional (`$.store`) | – | S | Mid-run notification/query channel has no native equivalent (verify); acceptable loss for v1 |
| R07 | Peer orchestrators (`orchestrator_*`) | `extensions/gentle-agents.ts:3069-3266`; `lib/orchestrator-*.ts`; `session-messaging-grants.ts` | `odd_orchestrator_*` (if built) | 🟡 | Cross-session state via mod `$.store`, or MCP channels (preview) | yes (or MCP preview) | – | L | Hard; defer. Low value for single-session users |
| R08 | Session IPC transport | `lib/agents-session-transport.ts`; `lib/windows-session-transport.ts`; `runtime/windows-session-transport.ps1` | – | ❌ | Subsumed by R07's mechanism; Pi-process-specific sockets are not needed | no | – | – | Disagreement flag: grouped "hard" in the brief; treated as ❌ because nothing remains to port once R07 picks its channel |
| R09 | Agents view / widget (`/gentle:agents`) | `lib/agents-view*.ts`, `agents-widget.ts`, `agents-thread-view.ts`, `agents-keys.ts`; `extensions/gentle-agents.ts:3534` | `/odd-claude:agents` | 🟡 | Native background-task view; richer pane via mod `ui` pane | optional | – | M | Without mods: a command that lists tasks as text |
| R10 | Child UI questions forwarded to parent | `extensions/gentle-agents.ts:738-748` | – | 🟡 | AskUserQuestion from a subagent (verify it surfaces in the parent UI) | no | – | S | If subagents cannot ask, agents must return questions in their result |
| R11 | Background jobs (`bash_background`, `monitor`, `job_*`) | `lib/background-jobs*.ts`, `background-monitor.ts`, `jobs-view.ts`, `jobs-widget.ts`; `odd/tasks/background-jobs.md` | native Bash `run_in_background` + Monitor | 🟡 | Native; upstream spec was itself modeled on this feature | no | – | S | `/gentle:jobs` modal → native task list. Guidance text in cards must be rewritten |
| R12 | Background subagents policy | `lib/background-subagents-policy.ts`; `/gentle:background-subagents` | `/odd-claude:background-subagents` | 🟡 | Native `run_in_background` on Agent; policy sentence via SessionStart | no | – | S | |
| R13 | codegraph tool | `extensions/codegraph-tools.ts:379`; `lib/background-cache-warming.ts` | `odd_codegraph` → MCP `codegraph` | 🟡 | codegraph MCP/bin shipped or declared; SessionStart hook auto-inits/warms the index | no | `codegraph` CLI | S | Agents already reference `mcp__codegraph__codegraph_explore` |
| R14 | Exploration budget | `lib/exploration-budget.ts` | hook `odd-explore-budget` | 🟡 | PostToolUse counts Read/Grep/Glob per turn, returns `additionalContext` steer; or `$.session.usage` in a mod | optional | – | S | |
| R15 | `todo` tool + sidebar | `extensions/gentle-todo.ts`; `lib/shell-todo.ts`; `GENTLE_PI_TODO` | native TodoWrite/Tasks | 🟡 | Native; sidebar via mod pane | optional | – | S | Skills/cards mentioning `todo` need renaming |
| R16 | `ask_user_question` / `ask_user_choice` | `extensions/ask-user-*.ts`; `lib/questionnaire/` | native AskUserQuestion | 🟡 | Native | no | – | S | Pi component UX differs; answer-memory for auto mode (R24) is dropped |
| R17 | `gentle_guide` tour | `extensions/gentle-guide.ts`; `lib/gentle-guide.ts` | `/odd-claude:guide` + skill `guide` | 🟡 | Command + skill that walks through features in text; no anchored popovers | no | – | S | |
| R18 | Design canvas | `extensions/gentle-design.ts`; `lib/gentle-design.ts`, `design-canvas-server.ts`, `design-comments.ts`, `design-handoffs.ts`, `design-*.ts`; `assets/design-canvas/` | `odd_design`, `odd_design_comments`; `/odd-claude:design` | 🟡 | Local HTTP server started by a command or an MCP server; tools via MCP | no | node, browser | L | Server logic is Node and reusable; tool registration changes |
| R19 | Tower local web | `extensions/gentle-tower.ts`; `lib/tower-*.ts`; `runtime/tower-*.mjs`; `web/tower/` | `/odd-claude:tower` | 🟡 | Local HTTP server from command/MCP; presence from hooks (SessionStart/End) | no | node, vite build | L | Needs a per-session presence source (hooks) instead of Pi events |
| R20 | Permission modes normal/auto/yolo/super-yolo | `lib/permission-mode-policy.ts`, `yolo-session-policy.ts`; `/gentle:mode`, `/gentle:yolo`; `docs/permission-modes.md` | native `default` / `auto` / `bypassPermissions` | 🟡 | Native modes; `defaultMode` is a setting → `/odd-claude:setup`; hooks adapt behavior | no | – | M | Four upstream modes vs. native set; mapping to decide. `/gentle:mode`/`yolo` registration not located upstream |
| R21 | Bash guardrails (destructive confirm, allow-always) | `extensions/gentle-ai.ts:2962,2807`; `lib/destructive-command-guard.ts` | hook `odd-bash-guard` | 🟡 | PreToolUse `Bash` returns `ask`/`deny`; allow-always via native permission rules | no | – | M | Pure logic in `destructive-command-guard.ts` is reusable as-is (Node) |
| R22 | Sensitive path blocking | `extensions/gentle-ai.ts:2350-2494`; `lib/execution-surface-guard.ts`, `foreign-target-grants.ts` | hook `odd-path-guard` | 🟡 | PreToolUse `Read\|Edit\|Write\|Bash` deny | no | – | M | Plugins cannot ship `permissions.deny`; hooks are the only enforcement point |
| R23 | Child safety | `extensions/child-safety.ts`; `gentle-ai.ts:13385` | hook `odd-child-guard` | 🟡 | PreToolUse keyed by subagent `agent_type`; blocks destructive commands for odd agents | no | – | S | `ODD_AGENT_CHILD` env is not needed if hooks see agent type (verify) |
| R24 | Auto-permission classifier (extra model) | `lib/auto-permission-*.ts`; `docs/auto-permission-*.md` | native auto mode | 🟡 | Use Claude Code's native auto mode instead of a custom classifier | no | – | S | Upstream docs say its design follows Claude Code auto mode; custom evidence/memory dropped |
| R25 | Super yolo | `lib/yolo-session-policy.ts`, `yolo-temp-scratch.ts`; `gentle-ai.ts:2721` | `bypassPermissions` + R21/R22 hooks | 🟡 | Native bypass mode with hooks retained as the safety floor | no | – | S | Decide whether hooks stay active in bypass (verify hook behavior) |
| R26 | Bounded writer admission | `lib/bounded-writer-admission.ts`, `writer-surfaces.ts`, `writer-batch-admission.ts` | hook `odd-writer-admission` | 🟡 | PreToolUse matcher `Agent`: require `## Allowed edit surfaces`, feature-doc locator, no overlap in same message | no | – | M | Logic is pure TS/Node → port as-is; changes only in input extraction (`subagent_run` → `Agent` input) |
| R27 | Verifier admission | `lib/verifier-admission.ts`, `verifier-settle-reminder.ts` | hook `odd-verifier-admission` | 🟡 | PreToolUse matcher `Agent`: require `Risk:` line naming a high-risk item | no | – | M | |
| R28 | Judgment Day fix dispatch validation | `extensions/gentle-ai.ts:552-727` | hook `odd-jd-dispatch` | 🟡 | PreToolUse matcher `Agent` for `odd-jd-fix` (5 sections, ≤2 rounds, SHA-256) | no | – | M | Needs a digest helper (script in `bin/`) |
| R29 | Native review RDD tools | `lib/native-review-cli.ts`, `lib/review-*.ts` (37), `runtime/native-review-cli.mjs`; `gentle-ai.ts:12432-12830` | `odd_review`, `odd_review_run`, `odd_review_capture`, `odd_review_capture_group`, `odd_review_scope`, `odd_phase` | 🟡 | MCP server (or mod `$.tool.register`) fronting a review engine + the four `odd-review-*` agents | optional | **Go review binary (upstream external, source not in this upstream)** | L | Highest risk. Provider contract and CLI already name `claude-code` as a host (`contracts/review-provider-contract-mirror/v1.6.0/bundle/manifest.json`, `lib/native-review-cli.ts:1034,1056`) – evidence the binary may already support it; open question: reuse the binary or reimplement in TS |
| R30 | RDD state / commands | `lib/rdd-mode-control.ts`, `review-session-standing-permission*.ts`; `/gentle:rdd`, `/gentle:review-mode`, `/gentle:review-session-permission` | `/odd-claude:rdd`, `/odd-claude:review-mode`, `/odd-claude:review-session-permission` | 🟡 | Commands + state file read by hooks | no | R29 | M | |
| R31 | Review/verifier nudges before settle | `extensions/gentle-ai.ts:13185,13243`; `lib/verifier-settle-reminder.ts`, `review-reminder-receipt.ts` | hook `odd-settle-nudge` | 🟡 | Stop hook with `decision: block` + reason | no | R29 | M | Must avoid Stop-hook loops (use `stop_hook_active`) |
| R32 | Publication / delivery gate | `lib/review-publication-gate.ts`, `review-delivery-preflight.ts`, `delivery-conflict-markers.ts`, `delivered-test-lint.ts` | hook `odd-delivery-gate` | 🟡 | PreToolUse `Bash` on `git push` / `gh pr` | no | R29, git, gh | M | Conflict-marker/test-lint checks work without RDD |
| R33 | Review candidate views | `lib/review-candidate-view*.ts`, `review-candidate-symlink-scan.ts` | part of `odd_review_scope` | 🟡 | Engine side of R29; agents read the candidate via the scope tool | no | R29 | L | |
| R34 | Context backstop | `lib/context-backstop.ts`, `context-threshold.ts` | hook `odd-context-backstop` | 🟡 | PostToolUse `additionalContext` / mod `$.session.usage`; writer admission needs a usage number (verify availability in hooks) | optional | – | S | |
| R35 | Quota recovery & model fallback | `lib/model-fallback-policy.ts`, `model-fallback-store.ts`, `agents-protocol.ts:236-256`; `assets/orchestrator-quota-recovery.md` | `--fallback-model` + hook `odd-stop-failure` | 🟡 | Native `--fallback-model` (same provider) + StopFailure hook to advise; agent frontmatter `model` | no | – | M | **Cross-provider fallback ❌** (Claude Code runs Anthropic models only) |
| R36 | Usage / quotas / stats | `lib/shell-usage.ts`, `stats-collector.ts`, `stats-view.ts`; `extensions/gentle-stats.ts` | `/odd-claude:stats` | 🟡 | statusLine script (needs setup) or mod `$.ui.status`; command reading local transcripts | optional | – | M | Local display only; nothing is sent anywhere |
| R37 | Telemetry (trigger, runtime metrics, `/gentle:telemetry`) | `lib/telemetry-trigger.ts`, `runtime-metrics*.ts`; `extensions/runtime-metrics.ts`; `gentle-ai.ts:13850` | – | ❌ | **Excluded by decision: no telemetry in odd-claude.** No mechanism proposed | no | – | – | Also drop the nudge at `gentle-ai.ts:13065+` |
| R38 | gentle-ai binary / Engram detection | `lib/gentle-ai-binary.ts`; `bin/engram-guard`; `/gentle:doctor`, `/gentle:status`, `/gentle:dev-binary`, `/gentle:install-<owner>` | `/odd-claude:doctor`, `/odd-claude:status` | 🟡 | Engram as plugin `dependencies` (`engram@engram`); doctor command checks binaries (review engine, codegraph, git) | no | engram, codegraph | M | `engram-guard` unnecessary when Engram is a managed dependency; `dev-binary` is maintainer-only |
| R39 | Model profiles | `lib/profiles-orchestrator.ts`, `session-profile-*.ts`, `agent-profiles.ts`, `agent-profile-pin.ts`; `docs/session-profile-format.md` | `/odd-claude:profiles` | 🟡 | Command regenerates agent frontmatter `model`/`effort`; mod `agent.spawn` for dynamic per-spawn choice | optional | – | M | Pi's multi-provider profile concept shrinks to Claude models |
| R40 | Per-agent model routing | `lib/agent-model-resolution.ts`, `agents-config.ts`, `model-routing-authority.ts`, `model-price-ratio.ts` | agent frontmatter `model`/`effort` | 🟡 | Static in frontmatter; dynamic via mod `agent.spawn` | optional | – | S | |
| R41 | OpenAI fast mode | `extensions/gentle-fast.ts`; `lib/openai-fast-tier.ts`; `docs/fast-mode.md` | – | ❌ | OpenAI-specific; Claude Code has its own `/fast` | no | – | – | |
| R42 | TPS indicator | `extensions/gentle-tps.ts` | statusLine segment | 🟡 | statusLine script or mod `$.ui.status` | optional | – | S | Needs token/time data in the statusLine payload (verify) |
| R43 | NaN provider | `extensions/nan-provider.ts`; `lib/nan-provider.ts` | – | ❌ | Plugins cannot register providers | no | – | – | |
| R44 | Status bar / footer / prompt | `extensions/gentle-shell.ts`; `lib/shell-bar.ts`, `shell-prompt.ts`, `shell-sidebar*.ts`, `shell-gauge.ts` | statusLine script `odd-status` | 🟡 | statusLine (configured by `/odd-claude:setup`) or mod `$.ui.status` / above-prompt | optional | – | M | Custom editor/footer replacement is not possible; only status line + panes |
| R45 | Startup banner | `extensions/startup-banner.ts` | SessionStart message | 🟡 | SessionStart `systemMessage`/mod toast or pane | optional | – | S | Cosmetic |
| R46 | Changes widget | `lib/shell-changes*.ts`, `session-changes.ts`, `change-diff.ts`; `/gentle:changes` | `/odd-claude:changes` | 🟡 | Command rendering `git status/diff`; optional mod pane | optional | git | S | |
| R47 | Image attachments | `lib/image-attachments.ts`, `clipboard-image.ts`, `pasted-image-paths.ts`, `image-disk-cache.ts`; `/gentle:images` | – | ❌ | Not needed: native image paste/attach | no | – | – | Verify parity (clipboard paste, path drop) |
| R48 | Command palette & panels | `lib/command-palette*.ts`, `shell-panel.ts`; `/gentle:panel`, `usage`, `commands`, `customize`, `vim`, `animations`, `double-esc-cancel` | few commands only | ❌ | Native `/` menu replaces palette; `usage`/`changes` live in R36/R46; `customize`, `vim`, `animations`, `double-esc-cancel` have no target | no | – | – | `/odd-claude:commands` (help list) may be worth S effort |
| R49 | Keybindings & Vim engine | `lib/keymaps*.ts`, `vim-*.ts`, `pi-tui-keys.ts`; `/gentle:vim` | – | ❌ | Claude Code has native vim mode; keybindings are not shippable by plugins | no | – | – | |
| R50 | `session_worktree_register` | `extensions/gentle-shell.ts:2645`; `lib/session-worktree-registry.ts` | native worktree tools | 🟡 | Native `EnterWorktree`/worktree support; writer admission resolves cwd from hook input | no | git | S | |
| R51 | Quiet tools (re-render built-ins) | `extensions/quiet-tools.ts`; `lib/quiet-tools-config.ts` | mod `ui.render` ToolUse | 🟡 | Partial, via mod render hook | yes | – | S | Cosmetic; skip unless mods are adopted |
| R52 | Codemode & hidden tools | `lib/hidden-tools.ts`, `codemode-renderer.ts`, `builtin-codemode-optout.ts` | – | ❌ | No equivalent concept | no | – | – | |
| R53 | Skill registry | `extensions/skill-registry.ts`; `/skill-registry:refresh` | hook `odd-skill-registry`; `/odd-claude:skill-registry` | 🟡 | SessionStart/UserPromptSubmit hook injects trigger→path index; native skill discovery already lists skills | no | – | S | Registry mostly overlaps with native skill listing (verify gap: project/user skills) |
| R54 | Themes | `themes/*.json`; `lib/terminal-theme.ts`, `theme-customization.ts` | plugin themes | 🟡 | Convert Pi theme JSON to Claude Code theme format (plugin `themes`) | no | – | S | See A50 |
| R55 | Prompt history | `extensions/history/`; `lib/history-capture-policy.ts` | – | 🟡 | Native history covers the need; nothing to ship | no | – | – | Partial; effectively not needed |
| R56 | Session scratch | `extensions/session-scratch.ts`; `/gentle:scratch` | hook + `/odd-claude:scratch` | 🟡 | SessionStart creates a temp dir, SessionEnd removes it | no | – | S | |
| R57 | Notifications & audio | `extensions/gentle-notifications.ts`; `lib/notification-*.ts`; `assets/sounds` | hooks `Stop`/`Notification` | 🟡 | Hooks call `afplay`/`paplay`/powershell; or mod `$.audio` | optional | afplay / paplay / powershell | S | Simplify: drop pulse worker/scheduler; reuse WAVs (A26) |
| R58 | Voice dictation | `extensions/gentle-voice.ts`; `lib/voice-*.ts`; `scripts/voice-worker.cjs` | – | ❌ | Native voice exists in Claude Code; custom STT worker not shippable | no | – | – | |
| R59 | Music | `extensions/gentle-music.ts`; `docs/gentle-music.md` | – | ❌ | Needs control of the TUI (hand terminal to external program) | no | `gentle-stream` | – | |
| R60 | Desktop RPC & feed | `extensions/gentle-desktop-*.ts`; `lib/desktop-*.ts`; `docs/desktop-*.md` | – | ❌ | Separate desktop app built around Pi RPC | no | – | – | |
| R61 | herdr integration | `extensions/gentle-herdr-*.ts`; `lib/herdr-*.ts`; `herdr/` | – | ❌ | herdr hosts Pi sessions; out of scope | no | herdr | – | |
| R62 | Program identity (terminal title) | `extensions/gentle-program-identity.ts` | hook | 🟡 | SessionStart/End hook writing the title escape | no | – | S | Cosmetic |
| R63 | Star prompt | `extensions/gentle-star-prompt.ts`; `lib/star-prompt.ts` | – | 🟡 | SessionStart hook message (optional; outward-facing nudge) | no | GitHub | S | Open question whether to keep it at all |
| R64 | Resume hint | `extensions/resume-hint.ts` | SessionEnd hook | 🟡 | SessionEnd hook message (verify visibility on exit) | no | – | S | Native `/resume` exists; low value |
| R65 | pi-pretty | `extensions/pi-pretty.ts` | – | ❌ | Pi npm dependency | no | `@heyhuynhgiabuu/pi-pretty` | – | |
| R66 | Launcher | `bin/gentle-shell.mjs`; `lib/gentle-shell-launcher.ts`; `runtime/gentle-shell-*.mjs` | – | ❌ | Replaced by marketplace install | no | – | – | |
| R67 | Bundled runtime / installer | `lib/gentle-shell-bundled.ts`; `scripts/install-gentle-ai.mjs`, `bundled-install.mjs`, `installer-*.mjs`; `assets/install-wizard/` | – | ❌ | Replaced by marketplace + plugin `dependencies` | no | – | – | See A27 |
| R68 | Update & uninstall | `lib/gentle-shell-startup-update.ts`, `gentle-shell-uninstall.ts`, `update-status.ts` | – | ❌ | Marketplace update / uninstall | no | – | – | |
| R69 | RPC/TUI mode, animations, cards | `lib/rpc-host.ts`, `animation-policy.ts`, `card-*-policy.ts`, `shell-card.ts` | – | ❌ | Pi-host rendering concerns | no | – | – | |
| R70 | Agent status file *(added)* | `extensions/gentle-agent-status.ts`; `lib/agent-status.ts`; `docs/agent-status.md` | hooks → status file | 🟡 | SessionStart/UserPromptSubmit/Stop/SessionEnd hooks write the same JSON | no | – | S | Only useful with an external consumer |
| R71 | herdr desktop status *(added)* | `extensions/gentle-herdr-desktop-status.ts`; `lib/herdr-desktop-status.ts`, `herdr-desktop-events.ts` | – | ❌ | Tied to R60/R61 | no | herdr | – | |
| R72 | Reply-language anchor *(added)* | `lib/reply-language-anchor.ts`, `card-content-policy.ts` | text in R01 | 🟡 | A few lines in the output style / SessionStart context | no | – | S | |
| R73 | Managed asset migrations *(added)* | `assets/migrations/*.json`; `lib/agent-assets.ts`, `agent-home.ts`; `scripts/update-agent-body-history.mjs` | – | ❌ | Plugin files are versioned by the marketplace; no user-edited copies to migrate | no | – | – | |
| R74 | Request-context placement *(added)* | `lib/request-context-placement.ts`; `docs/prompt-budget.md`, `review-request-context.md` | part of `odd_review` | 🟡 | Moves with R29; prompt-budget ideas inform card sizes | no | R29 | S | |

---

## 2. Content assets

| ID | Feature | Upstream paths | odd-claude name | Verdict | Claude Code mechanism | Mods? | External deps | Effort | Notes |
|---|---|---|---|---|---|---|---|---|---|
| A01 | Agent `gentle-ai-explore` | `assets/agents/gentle-ai-explore.md` | `odd-explore` | 🟡 | Plugin agent; tools read→`Read`, grep→`Grep`, find→`Glob`, `web_search`/`fetch_content`→`WebSearch`/`WebFetch`, codegraph MCP | no | codegraph | S | `web_enable`, `source_check`, `get_search_content` have no native name; drop |
| A02 | Agent `gentle-ai-verify` | `assets/agents/gentle-ai-verify.md` | `odd-verify` | 🟡 | Plugin agent; `Read, Grep, Glob, Bash`, codegraph MCP | no | codegraph | S | Read-only is enforced by hook (R23) since plugin agents ignore `permissionMode` |
| A03 | Agent `gentle-ai-worker` | `assets/agents/gentle-ai-worker.md` | `odd-worker` | 🟡 | `Read, Grep, Glob, Edit, Write, Bash`, codegraph MCP, engram `mem_save` | no | engram, codegraph | S | Admission via R26 |
| A04 | Agent `jd-fix-agent` | `assets/agents/jd-fix-agent.md` | `odd-jd-fix` | 🟡 | As A03 minus `mem_save` | no | codegraph | S | Dispatch via R28 |
| A05 | Agent `jd-judge-a` | `assets/agents/jd-judge-a.md` | `odd-jd-judge-a` | 🟡 | `"*": false` → explicit `tools` allowlist (+ `disallowedTools`); `Read, Grep, Glob, Bash` | no | codegraph | S | |
| A06 | Agent `jd-judge-b` | `assets/agents/jd-judge-b.md` | `odd-jd-judge-b` | 🟡 | Same as A05 | no | codegraph | S | |
| A07 | Agent `review-risk` | `assets/agents/review-risk.md` | `odd-review-risk` | 🟡 | `Read, Grep, Glob` + MCP `odd_review_scope` | no | R29 | S | Useless without R29 |
| A08 | Agent `review-resilience` | `assets/agents/review-resilience.md` | `odd-review-resilience` | 🟡 | Same as A07 | no | R29 | S | |
| A09 | Agent `review-readability` | `assets/agents/review-readability.md` | `odd-review-readability` | 🟡 | Same as A07 | no | R29 | S | |
| A10 | Agent `review-reliability` | `assets/agents/review-reliability.md` | `odd-review-reliability` | 🟡 | Same as A07 | no | R29 | S | |
| A11 | Chain `4r-review` | `assets/chains/4r-review.chain.md` | skill/command `4r-review` | 🟡 | No chain format: a command or skill that launches the four reviewers sequentially via Agent | no | R29 | S | Upstream marks it manual/compat-only |
| A12 | Card `orchestrator.md` (always-loaded prompt) | `assets/orchestrator.md` | `cards/orchestrator.md` → output style `odd` | 🟡 | Output style / SessionStart text; rule set: Task Size (3 conditions, high-risk list, `Risk:` line), Ask → Evidence-budget → Verification → Track → Writer → Incident, Language Boundary | optional | – | M | Rewrite tool names (`subagent_run` → `Agent`, `todo` → TodoWrite) |
| A13 | Card `orchestrator-delegation.md` | `assets/orchestrator-delegation.md` | `cards/delegation.md` | 🟡 | Lazy card read via `Read` from `${CLAUDE_PLUGIN_ROOT}` | no | – | S | |
| A14 | Card `orchestrator-delegation-reference.md` | `assets/orchestrator-delegation-reference.md` | `cards/delegation-reference.md` | 🟡 | Same; **"Pi Runtime Overlays" section must be rewritten** | no | – | M | Largest card (157 lines) |
| A15 | Card `orchestrator-full-delegation.md` | `assets/orchestrator-full-delegation.md` | `cards/full-delegation.md` | 🟡 | Coordinator mode: PreToolUse deny `Edit\|Write\|MultiEdit\|NotebookEdit` in the main thread | no | – | S | |
| A16 | Card `orchestrator-full-delegation-card.md` | `assets/orchestrator-full-delegation-card.md`; `scripts/build-full-delegation-card.mjs` | `cards/full-delegation-card.md` | 🟡 | Generated from A15 by the build script; keep generation or inline | no | – | S | |
| A17 | Card `orchestrator-memory.md` | `assets/orchestrator-memory.md` | `cards/memory.md` | 🟡 | Engram tool names per the engram plugin | no | engram | S | |
| A18 | Card `orchestrator-prompts.md` | `assets/orchestrator-prompts.md` | `cards/prompts.md` | 🟡 | Text; provider-defect part tied to A39 | no | – | S | |
| A19 | Card `orchestrator-quota-recovery.md` | `assets/orchestrator-quota-recovery.md` | `cards/quota-recovery.md` | 🟡 | Text; relevant to R35 | no | – | S | |
| A20 | Card `orchestrator-skills.md` | `assets/orchestrator-skills.md` | `cards/skills.md` | 🟡 | Skill Registry Protocol rewritten for R53 | no | – | S | |
| A21 | Card `orchestrator-tracking.md` | `assets/orchestrator-tracking.md` | `cards/tracking.md` | 🟡 | ODD tracking and delivery strategies; text | no | – | S | |
| A22 | Card `orchestrator-verification.md` | `assets/orchestrator-verification.md` | `cards/verification.md` | 🟡 | Verification rule normative text; ties to R27 | no | – | S | |
| A23 | Card `orchestrator-writer.md` | `assets/orchestrator-writer.md` | `cards/writer.md` | 🟡 | Writer handoff + JD 5-section dispatch; ties to R26/R28 | no | – | S | |
| A24 | Support `strict-tdd.md`, `strict-tdd-verify.md` | `assets/support/strict-tdd.md`, `strict-tdd-verify.md` | `support/test-first.md`, `support/test-first-verify.md` | ✅ | Plain markdown policy | no | – | S | Rename "strict-tdd" (upstream calls it a legacy filename, not a switch) |
| A25 | Migrations manifests | `assets/migrations/*.json` | – | ❌ | Not needed (see R73) | no | – | – | |
| A26 | Sounds (3 WAV + LICENSE) | `assets/sounds/*` | `assets/sounds/` | ✅ | Played by R57 hooks | no | – | S | Original synthetic tones; keep `LICENSE.md` |
| A27 | Install wizard UI | `assets/install-wizard/` | – | ❌ | Marketplace replaces installer (R67) | no | – | – | |
| A28 | Design canvas web assets | `assets/design-canvas/` | `assets/design-canvas/` | 🟡 | Static files served by R18's server | no | – | M | Rename `gentle` strings/i18n; CSS/JS reusable |
| A29 | Logo | `assets/gentle-logo-only.png` | – | ❌ | Excluded by naming decision; upstream `TRADEMARKS.md` reserves the marks. Need a new odd-claude icon | no | – | S | Flag: trademark/branding is a legal question, see open questions |
| A30 | Skill `gentle-ai-branch-pr` | `skills/branch-pr/SKILL.md` (174 lines) | `odd-claude:branch-pr` | ✅ | Plugin skill, no change | no | git, gh | S | No Pi references |
| A31 | Skill `gentle-ai-chained-pr` | `skills/chained-pr/` (+`references/chaining-details.md`) | `odd-claude:chained-pr` | ✅ | Plugin skill | no | git, gh | S | |
| A32 | Skill `gentle-ai-cognitive-doc-design` | `skills/cognitive-doc-design/SKILL.md` | `odd-claude:cognitive-doc-design` | ✅ | Plugin skill | no | – | S | |
| A33 | Skill `gentle-ai-comment-writer` | `skills/comment-writer/SKILL.md` | `odd-claude:comment-writer` | ✅ | Plugin skill | no | – | S | |
| A34 | Skill `gentle-design` | `skills/design/SKILL.md` | `odd-claude:design` | 🟡 | Skill; references tools `gentle_design` ×6 and `gentle_design_comments` ×3 → `odd_design*` | no | R18 | S | Not usable without R18 |
| A35 | Skill `gentle-ai` (harness discipline) | `skills/gentle-ai/SKILL.md` | `odd-claude:odd` | 🟡 | Plugin skill; rewrite "Pi work" wording | no | – | S | Overlaps with A12; decide if both are needed |
| A36 | Skill `gentle-ui-design` | `skills/gentle-ui-design/` (+4 references) | `odd-claude:ui-design` | ✅ | Plugin skill | no | – | S | |
| A37 | Skill `gentle-ai-issue-creation` | `skills/issue-creation/` (+`references/delegated-workflow-actions.md`) | `odd-claude:issue-creation` | ✅ | Plugin skill | no | gh | S | |
| A38 | Skill `gentle-ai-judgment-day` | `skills/judgment-day/` (+`references/prompts-and-formats.md`) | `odd-claude:judgment-day` | ✅ | Plugin skill; agent names renamed (`odd-jd-*`) | no | – | S | Enforcement is R28 |
| A39 | Skill `gentle-ai-provider-defect-report` | `skills/provider-defect-report/SKILL.md` | `odd-claude:provider-defect-report` | ✅ | Plugin skill | no | review binary | S | Only meaningful if odd-claude keeps an external review binary (R29) |
| A40 | Skill `gentle-ai-rdd-defect-workflow` | `skills/rdd-defect-workflow/SKILL.md` | `odd-claude:rdd-defect-workflow` | ✅ | Plugin skill; "Pi" ×2 reworded | no | R29 | S | For maintainers of RDD |
| A41 | Skill `gentle-ai-skill-creator` | `skills/skill-creator/SKILL.md` | `odd-claude:skill-creator` | ✅ | Plugin skill; "Pi" ×1 → Claude Code | no | – | S | Reword target runtime and `docs/skill-style-guide.md` path |
| A42 | Skill `gentle-ai-skill-improver` | `skills/skill-improver/SKILL.md` | `odd-claude:skill-improver` | ✅ | Plugin skill; "Pi" ×1 | no | – | S | |
| A43 | Skill `gentle-ai-skill-registry` | `skills/skill-registry/SKILL.md` | `odd-claude:skill-registry` | ✅ | Plugin skill; "Pi" ×5 → Claude Code paths | no | – | S | Pairs with R53 |
| A44 | Skill `gentle-ai-tui-design` | `skills/tui-design/` (+`NOTICE.md`, 5 references) | `odd-claude:tui-design` | ✅ | Plugin skill; `todo` ×3 → TodoWrite | no | – | S | Keep `NOTICE.md` (attribution) |
| A45 | Skill `gentle-ai-work-unit-commits` | `skills/work-unit-commits/SKILL.md` | `odd-claude:work-unit-commits` | ✅ | Plugin skill | no | git | S | |
| A46 | Prompt `skill-creation` | `prompts/skill-creation.md` | `/odd-claude:skill-creation` | ✅ | Plugin command (`commands/skill-creation.md`); `description`, `argument-hint`, `$ARGUMENTS` are the same convention | no | – | S | Update the skill name it calls |
| A47 | Contracts review-integration v1/v2 | `contracts/review-integration/{v1,v2}` | `contracts/review-integration/` | 🟡 | Reused only if the existing review binary is reused (R29) | no | R29 | M | v2 already includes provider-role schemas |
| A48 | Contracts provider mirror v1.6.0 | `contracts/review-provider-contract-mirror/`; `scripts/check-provider-contract.mjs` | `contracts/provider-mirror/` | 🟡 | Same condition as A47 | no | R29 | M | Manifest lists `claude-code` host |
| A49 | Contracts telemetry | `contracts/telemetry/runtime-aggregate-v1.schema.json` | – | ❌ | **Excluded by decision: no telemetry.** Not copied | no | – | – | Schema's `host` enum lists `claude-code`; irrelevant given the decision |
| A50 | Themes (3) | `themes/Gentle.json`, `Gentleman-Cute.json`, `Gentleman-Sexy.json` | `themes/odd-*.json` | 🟡 | Convert Pi theme schema to Claude Code plugin theme format; rename (no `Gentle*`) | no | – | S | Verdict could be ✅ if the formats map 1:1 (verify) |
| A51 | herdr layout / keys / themes / 11 mods | `herdr/` | – | ❌ | herdr-specific (R61) | no | herdr | – | The upstream mods are herdr JS mods, **not** Claude Code mods despite the same word |
| A52 | Tower web SPA | `web/tower/` | `web/tower/` | 🟡 | Served by R19's server; data source changes from Pi sessions to hook-written presence | no | node, pixi.js, mermaid, vite | L | |
| A53 | Design explorations | `design/` | – | ❌ | Upstream's own design history, not product | no | – | – | Reference only |
| A54 | ODD feature-doc format and task docs | `odd/` | `odd/tasks/<feature>.md` (format) | ✅ | Plain markdown convention: header, `## Specs` `S#`, `## Tasks` `T#`, `## Delivery`, `## Risks`, `## Log` `L#` | no | – | S | The 230 upstream task docs are history and are **not** copied |
| A55 | Upstream docs | `docs/` (39 `.md` + `assets/`, `images/`) | – | ❌ | Source material for this research, not shipped | no | – | – | Some are sources for individual features (see inventory §3.10) |
| A56 | Scripts | `scripts/` | – | ❌ | Build/installer/CI of the Pi package; only `prepare-verifier.mjs` (offline git prep for a verifier) and `check-provider-contract.mjs` may be reused | no | node | S | Reuse decision tied to R27 / A48 |
| A57 | Runtime modules | `runtime/` | – | ❌ | Generated JS mirror of `lib/` for Pi launcher; odd-claude chooses its own build output | no | – | – | |
| A58 | Tests | `tests/` (610 entries) | `tests/` | 🟡 | Pure-logic tests (guards, admission, JD validation) can be adapted to Node test runner; Pi-harness tests dropped | no | node | M | Source of behavioral specs for R21–R28 |

---

## 3. Summary

| Verdict | Runtime (R, 74) | Assets (A, 58) | Total (132) |
|---|---|---|---|
| ✅ 100% | 0 | 18 | 18 |
| 🟡 adaptation | 54 | 31 | 85 |
| ❌ not portable / not needed / excluded | 20 | 9 | 29 |

Count command: `grep -c '^| [RA][0-9]' docs/research/portability-matrix.md` → 132 rows (R 74 + A 58). Regenerate the split after edits.

## 4. Candidate phases (dependency grouping, not a roadmap)

| Group | Items | Depends on | Why grouped |
|---|---|---|---|
| 0. Skeleton & decisions | plugin manifest, naming, `/odd-claude:setup`, `/odd-claude:doctor` (R38), engram dependency | open questions (mods gate, output style vs SessionStart) | everything else is installed through it |
| 1. Core declarative layer | R01, R02, R72, A12–A24 cards, A01–A06 agents, A30–A46 skills + command, A54, R05/R06/R12 (native Agent), R11, R15, R16, R13, R50, R53, A26 | group 0 | text and config only, no enforcement code |
| 2. Guards | R21, R22, R23, R25, R20, R24, R26, R27, R28, A15 (coordinator mode), R14, R34 | group 1 (agent names) | hooks over pure TS logic that already exists upstream |
| 3. RDD / review | R29, R30, R31, R32, R33, R03, R74, A07–A11, A47, A48, A39, A40 | groups 1–2; decision: reuse the Go binary or reimplement | largest effort and risk; independent of the rest |
| 4. Mods UX (optional) | R09, R36, R42, R44, R45, R46, R51, R39/R40 dynamic routing, R15 sidebar, R57 `$.audio` | mods being available (verify gating) | enhancements with non-mod fallbacks |
| 5. Web tools | R18, R19, A28, A52, R17 | group 1 | local servers; independent, can slip |
| 6. Cosmetic / small | R54, A50, R56, R57, R62, R63, R64, R70, R35 (partial) | – | low value, low effort |
| Out of scope | R04, R08, R37, R41, R43, R47, R48, R49, R52, R55 (native), R58–R61, R65–R69, R71, R73, A25, A27, A29, A49, A51, A53, A55–A57 | – | not portable, not needed, or excluded by decision (telemetry, branding) |
