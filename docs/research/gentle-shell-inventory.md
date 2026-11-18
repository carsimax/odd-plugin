# gentle-shell upstream inventory

Descriptive inventory of the upstream source: `upstream/gentle-shell/` (npm package `gentle-pi` v4.8.0, an ODD harness for the Pi coding agent; gitignored, read-only). This file only **describes**. Portability verdicts, target names and effort live in [portability-matrix.md](./portability-matrix.md). Claude Code capabilities are in [claude-code-extensibility.md](./claude-code-extensibility.md); open decisions in [open-questions.md](./open-questions.md); doc index in [../README.md](../README.md).

All paths are relative to `upstream/gentle-shell/`. Line numbers are as read at v4.8.0 and are approximate anchors.

**Scope decisions that bind this project** (they do not change what upstream contains):

- The only source is this upstream. No other project is used as reference.
- Names: no `gentle-` / `gentle-ai` prefix in the port; the prefix is `odd` (see the matrix "Naming convention").
- No telemetry of any kind is ported (R37 and the telemetry contract are excluded).

---

## 1. Package structure

### 1.1 `package.json`

| Field | Value |
|---|---|
| name / version | `gentle-pi` / `4.8.0`, MIT, ESM (`"type": "module"`) |
| `bin` | `gentle-shell` → `bin/gentle-shell.mjs` |
| `pi` section | `extensions: ["./extensions"]`, `themes: ["./themes"]`, `prompts: ["./prompts"]`, `skills: ["./skills"]`, `image` (CDN logo). This is the whole "plugin manifest": Pi auto-loads the four directories. |
| `dependencies` | `@heyhuynhgiabuu/pi-pretty@0.6.27` (R65) |
| `peerDependencies` | `@earendil-works/pi-coding-agent >=1.2.0`, `pi-ai`, `pi-tui` (all optional peers), `typebox` |
| `engines` | Node `^22.19.0 \|\| >=23.6.0`; `packageManager` pnpm 11.1.1 |
| `scripts` | `test` (`scripts/run-test-suite.mjs`), `typecheck`, `build:runtime-modules` / `check:runtime-modules`, `build:tower`, `check:provider-contract`, `test:packed-package`, `postinstall` → `scripts/install-gentle-ai.mjs` |
| `files` | publishes `assets/ bin/ contracts/ docs/ extensions/ herdr/ lib/ prompts/ runtime/ skills/ scripts/ tests/ themes/ web/tower/dist/ README.md` |

### 1.2 Top-level directories

| Dir | Contents | Size / notes |
|---|---|---|
| `extensions/` | Pi extension entry points (each `export default (pi: ExtensionAPI)`) | 35 `.ts` entries + `history/` (30,534 lines; `gentle-ai.ts` 13,957, `gentle-shell.ts` 3,857, `gentle-agents.ts` 3,691) |
| `lib/` | Pure/testable logic behind the extensions | 294 entries (incl. `questionnaire/`), see §2 |
| `runtime/` (A57) | 25 `.mjs`/`.ps1` runtime modules generated from `lib/` by `scripts/build-runtime-modules.mjs` so the launcher and child processes can run without TS (`native-review-cli.mjs`, `tower-*.mjs`, `gentle-shell-*.mjs`, `windows-session-transport.ps1`, …) | generated mirror, not a separate feature |
| `bin/` | `gentle-shell.mjs` (launcher), `gentle-shell-install.mjs`, `engram-guard` (sh stub that exits 78 so a provider cannot open an unverified Engram store when memory is disabled) | |
| `assets/` | agents, chain, orchestrator cards, support, migrations, sounds, install wizard, design canvas, logo | §3 |
| `skills/` | 16 skills | §3.5 |
| `prompts/` | `skill-creation.md` (one Pi prompt template) | |
| `contracts/` | review-integration v1/v2 schemas+fixtures, provider-contract mirror v1.6.0, telemetry schema | §3.9 |
| `themes/` | 3 Pi-format JSON themes | |
| `herdr/` | herdr multiplexer layout, keys, themes, 11 mods | §3.12 |
| `web/tower/` | Vite + TypeScript + pixi.js + mermaid SPA (`src/`: `art, main, model, panels, scene, style.css, tour, types`; 1,549 lines) | built into `web/tower/dist/` |
| `design/` | HTML design explorations (`herdr-desktop`, `herdr-gentle-shell`, `shell-rework`) + `system.md` | |
| `odd/` | Feature documents used by the project itself: `tasks/` (230), `prs/`, `notes/`, `diagnostics/` | §3.14 |
| `docs/` | 39 `.md` files + `assets/` (brand, diagrams, features) + `images/desktop` | §3.15 |
| `scripts/` | build / install / verify tooling | §2.3 |
| `tests/` (A58) | 610 entries (unit, `crosslane`, `devbinary`, `maintainer`, fixtures) | not a product feature |

### 1.3 Extension entry points (`extensions/`)

| File | Role |
|---|---|
| `gentle-ai.ts` | Core: orchestrator prompt, guards (`tool_call`), RDD/review tools, 17 `gentle:*` commands |
| `gentle-shell.ts` | TUI shell: footer, editor, sidebar, panels, changes, images, vim, `session_worktree_register` |
| `gentle-agents.ts` | Subagent runtime, background jobs UI, peer orchestrators |
| `child-context.ts`, `child-safety.ts` | Child session context filtering / destructive-command block |
| `codegraph-tools.ts` | `codegraph` tool |
| `gentle-todo.ts`, `ask-user-question.ts`, `ask-user-choice.ts` | `todo`, `ask_user_question`, `ask_user_choice` |
| `gentle-design.ts`, `gentle-tower.ts`, `gentle-guide.ts` | design canvas, tower web, guided tour |
| `gentle-stats.ts`, `runtime-metrics.ts` | usage stats; runtime metrics (telemetry feeder) |
| `gentle-fast.ts`, `gentle-tps.ts`, `nan-provider.ts` | OpenAI fast tier, TPS indicator, NaN provider |
| `gentle-notifications.ts`, `gentle-music.ts`, `gentle-voice.ts` | sound notifications, music, voice (voice is an 11-line wrapper over `lib/voice-*`) |
| `gentle-desktop-feed.ts`, `gentle-desktop-rpc.ts` | desktop app feed/RPC |
| `gentle-agent-status.ts`, `gentle-herdr-activity.ts`, `gentle-herdr-agent.ts`, `gentle-herdr-desktop-status.ts` | agent-status file + herdr status publishers (all subscribe to `session_start/agent_start/agent_settled/tool_execution_end/session_shutdown`) |
| `gentle-program-identity.ts`, `gentle-star-prompt.ts`, `resume-hint.ts`, `startup-banner.ts` | terminal title, GitHub star prompt, resume hint, banner |
| `skill-registry.ts` | skill registry (`skill-registry:refresh` command, `--no-skill-registry` flag) |
| `quiet-tools.ts`, `pi-pretty.ts`, `session-scratch.ts`, `history/` | built-in tool re-render, pi-pretty wrapper, scratch dir, prompt history |

---

## 2. Runtime features

Each feature lists its main files and the Pi API surface it leans on. Pi events used overall: `session_start`, `session_shutdown`, `session_tree`, `session_before_fork`, `session_before_tree`, `session_before_compact`, `before_agent_start`, `agent_start`, `agent_end`, `agent_before_settle`, `agent_settled`, `turn_start`, `turn_end`, `input`, `context_with_system`, `before_provider_request`, `message_end`, `tool_call`, `tool_result`, `tool_execution_start/end`.

### 2.1 Prompt, persona, context

| ID | Feature | Key files | Pi APIs / notes |
|---|---|---|---|
| R01 | Orchestrator ODD prompt | `extensions/gentle-ai.ts:13053` (`before_agent_start`), `:1698`, `:1490`, `:1513`, `:1389`; `assets/orchestrator*.md` | `appendSystemPromptOnce` (`lib/append-system-prompt.ts`); placeholders `{{GENTLE_PI_ASSETS_ROOT}}`, `{{GENTLE_PI_BACKGROUND_POLICY}}`; lazy cards loaded on demand |
| R02 | Persona & delegation mode (`full` / standard) | `extensions/gentle-ai.ts:3052`, `:1675`; `lib/orchestrator-mode-policy.ts`; `/gentle:persona` | selects which card set the prompt carries |
| R03 | Review provider contract fragment | `extensions/gentle-ai.ts:1545`, `:1618`; `contracts/review-provider-contract-mirror/v1.6.0` | contract text injected into the prompt when RDD is on |
| R04 | Child context filtering | `extensions/child-context.ts`, `lib/child-context-files.ts` | strips AGENTS/CLAUDE-style context files from child sessions |

### 2.2 Subagents and orchestration

| ID | Feature | Key files | Pi APIs / notes |
|---|---|---|---|
| R05 | Subagent runtime | `extensions/gentle-agents.ts`, `lib/agents-runner.ts` (child = `pi --mode rpc`, `agents-runner.ts:519`), `agents-protocol.ts`, `agents-config.ts` | tools `subagent_run`, `subagent_status`, `subagent_result`, `subagent_continue`, `subagent_cancel`, `subagent_list_agents`, `subagent_list_tasks`, `subagent_reply`, `subagent_send_message`; modes foreground/background; env `GENTLE_PI_AGENTS_CHILD=1` marks a child |
| R06 | Child→parent messaging | `gentle-agents.ts:408` | tool `subagent_parent_message` (notification / query) |
| R07 | Peer orchestrators | `gentle-agents.ts:3069-3266`; `lib/orchestrator-*.ts` (alias, catalog, consultation, discovery, presence, scope, state, work…) | tools `orchestrator_session_id`, `orchestrator_consult`, `orchestrator_list`, `orchestrator_send_message`; grants in `lib/session-messaging-grants.ts` |
| R08 | Session IPC transport | `lib/agents-session-transport.ts` (`net.createServer`), `lib/windows-session-transport.ts`, `runtime/windows-session-transport.ps1` | unix socket / named pipe between sessions |
| R09 | Agents view/widget | `lib/agents-view*.ts`, `agents-widget.ts`, `agents-thread-view.ts`, `agents-keys.ts`; `/gentle:agents` | TUI overlay + shortcuts (`registerShortcut`) |
| R10 | Child UI questions forwarded to parent | `extensions/gentle-agents.ts:738-748` | child `ask_user_*` answered in the parent UI |
| R11 | Background jobs | `lib/background-jobs.ts`, `background-jobs-tools.ts`, `background-monitor.ts`, `jobs-view.ts`, `jobs-widget.ts`; `/gentle:jobs` | tools `bash_background`, `monitor`, `job_stop`, `job_list`; cap 25 running; exit notice once; monitor batching (20 lines/notice, flood stop >120 lines/60 s). Spec: `odd/tasks/background-jobs.md` |
| R12 | Background subagents policy | `lib/background-subagents-policy.ts`; `/gentle:background-subagents`; env `GENTLE_PI_BACKGROUND_SUBAGENTS` | policy string injected through `{{GENTLE_PI_BACKGROUND_POLICY}}` |
| R13 | codegraph tool | `extensions/codegraph-tools.ts` (`codegraph` tool at `:379`), `lib/background-cache-warming.ts` | wraps the external `codegraph` CLI |
| R14 | Exploration budget | `lib/exploration-budget.ts` | counts read calls per turn; steer messages (`gentle-ai.ts` tool_call) |
| R15 | `todo` tool + sidebar | `extensions/gentle-todo.ts`, `lib/shell-todo.ts`; env `GENTLE_PI_TODO` | tool `todo`; sidebar widget; collapse shortcut |
| R16 | `ask_user_question` / `ask_user_choice` | `extensions/ask-user-question.ts`, `ask-user-choice.ts`, `lib/questionnaire/`, `native-choice-list.ts` | `ctx.ui` custom components; answers feed `lib/auto-permission-answers.ts` |
| R17 | `gentle_guide` tour | `extensions/gentle-guide.ts`, `lib/gentle-guide.ts`; `/gentle:guide` | in-TUI guided tour with anchored popovers |
| R18 | Design canvas | `extensions/gentle-design.ts`, `lib/gentle-design.ts`, `design-canvas-server.ts`, `design-comments.ts`, `design-handoffs.ts`, `design-layout.ts`, `design-parts.ts`, `design-sources.ts`, `design-system-tokens.ts`; `assets/design-canvas/` | tools `gentle_design`, `gentle_design_comments`; `/gentle:design`; local `node:http` server (token via `timingSafeEqual`), opens browser |
| R19 | Tower local web | `extensions/gentle-tower.ts`, `lib/tower-*.ts` (actions, hub, launch, open, presence, server, snapshot); `runtime/tower-*.mjs`; `web/tower/` | `/gentle:tower`; `http.createServer` on `127.0.0.1`; presence files across sessions |

### 2.3 Permissions and guards

| ID | Feature | Key files | Pi APIs / notes |
|---|---|---|---|
| R20 | Permission modes `normal / auto / yolo / super-yolo` | `lib/permission-mode-policy.ts`, `lib/yolo-session-policy.ts`, `yolo-temp-scratch.ts`; `/gentle:mode`, `/gentle:yolo`; docs `permission-modes.md`, `yolo-mode.md` | mode is session state with an epoch re-checked after any `await` in `tool_call` |
| R21 | Bash guardrails (destructive confirm, allow-always) | `gentle-ai.ts:2962`, `:2807`; `lib/destructive-command-guard.ts` | `tool_call` returns `{block, reason}`; `ctx.ui.confirm` |
| R22 | Sensitive path blocking | `gentle-ai.ts:2350-2494`; `lib/execution-surface-guard.ts`, `foreign-target-grants.ts` | secrets/credentials paths for read/edit/write/bash |
| R23 | Child safety | `extensions/child-safety.ts` (28 lines), `blockChildDestructiveCommand` (`gentle-ai.ts` ~`:13385`) | active when `GENTLE_PI_AGENTS_CHILD=1` |
| R24 | Auto-permission classifier | `lib/auto-permission-runtime.ts`, `-classifier.ts`, `-memory.ts`, `-evidence.ts`, `-answers.ts`, `-tool-context.ts`; docs `auto-permission-*.md` | second model call (`ModelRegistry`, `pi-ai`) judges each eligible tool action; remembers human answers; directive `<gentle-auto-permissions>` appended to the prompt |
| R25 | Super yolo | `lib/yolo-session-policy.ts`, `gentle-ai.ts:2721` | no prompts, scratch temp dir |
| R26 | Bounded writer admission | `lib/bounded-writer-admission.ts`, `writer-surfaces.ts`, `writer-batch-admission.ts` | `subagent_run` of `gentle-ai-worker`/`worker`/`jd-fix-agent` rejected unless prompt has a non-empty `## Allowed edit surfaces`, a feature doc (when required) and context under the backstop |
| R27 | Verifier admission | `lib/verifier-admission.ts`, `verifier-settle-reminder.ts` | verifier launch rejected unless the `Risk:` line names a high-risk item |
| R28 | Judgment Day fix dispatch validation | `gentle-ai.ts:552-727` (`rejectInvalidJudgmentDayFixDispatch`) | exact 5-section prompt, ≤2 rounds, SHA-256 of frozen rows |

### 2.4 Review (RDD)

| ID | Feature | Key files | Notes |
|---|---|---|---|
| R29 | Native review tools | `lib/native-review-cli.ts`, `runtime/native-review-cli.mjs`, `lib/review-*.ts`; `gentle-ai.ts:12432-12830` | tools `gentle_review`, `gentle_review_run`, `gentle_review_capture`, `gentle_review_capture_group`, `gentle_review_scope`, `gentle_odd_phase`; the heavy lifting is delegated to the external **gentle-ai Go binary** (`lib/gentle-ai-binary.ts`) |
| R30 | RDD state & commands | `lib/rdd-mode-control.ts`, `review-session-standing-permission*.ts`; `/gentle:rdd`, `/gentle:review-mode`, `/gentle:review-session-permission` | on/off per session, consent latch |
| R31 | Review/verifier nudges before settle | `gentle-ai.ts:13185` (`agent_end`), `:13243` (`agent_before_settle`); `lib/verifier-settle-reminder.ts`, `review-reminder-receipt.ts` | blocks "settle" until reminder satisfied |
| R32 | Publication / delivery gate | `lib/review-publication-gate.ts`, `review-delivery-preflight.ts`, `delivery-conflict-markers.ts`, `delivered-test-lint.ts` | `tool_call` on bash (`git push`, `gh pr`…) checks review receipts |
| R33 | Review candidate views | `lib/review-candidate-view*.ts`, `review-candidate-symlink-scan.ts` | read-only candidate tree for reviewers |

`lib/review-*.ts` groups (37 files):

| Group | Files |
|---|---|
| Authority / transaction | `review-transaction`, `review-lock`, `review-object-store`, `review-repository`, `review-canonical`, `review-snapshot`, `review-correction-lifecycle`, `review-continuation-registry`, `review-last-event-controller` |
| Contracts / relay | `review-compact-contract`, `review-relay-contract`, `review-host-relay`, `review-integration-v2`, `review-graph-schema`, `review-relay-phase-timing`, `review-legacy-detector` |
| Policy / risk | `review-policy-ordinary`, `review-policy-judgment-day`, `review-risk`, `review-risk-assessment`, `review-triggers`, `review-blocker`, `review-failure-facts`, `review-start-context` |
| Consent / permission | `review-consent-component`, `-latch`, `-ui`, `review-session-standing-permission` (+`-ipc`) |
| Delivery | `review-delivery-preflight`, `review-publication-gate`, `review-reminder-receipt` |
| Views / UI | `review-candidate-view`, `-owner`, `review-candidate-symlink-scan`, `review-sidebar-state` |

### 2.5 Context, models, usage

| ID | Feature | Key files | Notes |
|---|---|---|---|
| R34 | Context backstop | `lib/context-backstop.ts`, `context-threshold.ts` | writers are refused when parent context is past a threshold (uses `ctx.getContextUsage()`) |
| R35 | Quota recovery & model fallback | `lib/model-fallback-policy.ts`, `-store.ts`, `-notice.ts`, `agents-protocol.ts:236-256` | terminal error categories quota/auth/rate-limit/transient move a child run to next model in a configured chain; request errors never fall back; `orchestrator-quota-recovery.md` card |
| R36 | Usage / quotas / `/gentle:stats` | `lib/shell-usage.ts`, `stats-collector.ts`, `stats-view.ts`, `bridge-cost.ts`; `extensions/gentle-stats.ts` | reads provider usage endpoints and local session cost; **local** only |
| R37 | Telemetry | `lib/telemetry-trigger.ts`, `runtime-metrics*.ts`, `extensions/runtime-metrics.ts`, `/gentle:telemetry` (`gentle-ai.ts:13850`); `contracts/telemetry` | one-shot nudge of the Go binary's own anonymous telemetry + runtime aggregate schema |
| R38 | Binary / Engram detection | `lib/gentle-ai-binary.ts`, `bin/engram-guard`; `/gentle:doctor`, `/gentle:status`, `/gentle:dev-binary`, `/gentle:install-<owner>` | locates `gentle-ai` and `engram`; isolation env |
| R39 | Model profiles | `lib/profiles-orchestrator.ts`, `session-profile-*.ts`, `agent-profiles.ts`, `agent-profile-pin.ts`; `/gentle:profiles`; doc `session-profile-format.md` | per-session frozen profile (orchestrator + per-agent model/thinking) |
| R40 | Per-agent model routing | `lib/agent-model-resolution.ts`, `agents-config.ts`, `model-routing-authority.ts`, `model-price-ratio.ts` | resolves each agent's model/thinking from profile/config |
| R41 | OpenAI fast mode | `extensions/gentle-fast.ts`, `lib/openai-fast-tier.ts`; doc `fast-mode.md` | `before_provider_request` payload tweak |
| R42 | TPS indicator | `extensions/gentle-tps.ts` | tokens/s in the footer |
| R43 | NaN provider | `extensions/nan-provider.ts` (6 lines), `lib/nan-provider.ts` | `pi.registerProvider(...)` |

### 2.6 TUI shell and UX

| ID | Feature | Key files | Notes |
|---|---|---|---|
| R44 | Status bar / footer / prompt | `extensions/gentle-shell.ts`, `lib/shell-bar.ts`, `shell-prompt.ts`, `shell-sidebar*.ts`, `shell-gauge.ts` | `setEditorComponent` / `setFooter` / `setWidget` |
| R45 | Startup banner | `extensions/startup-banner.ts` (1,174 lines) | |
| R46 | Changes widget | `lib/shell-changes*.ts`, `session-changes.ts`, `change-diff.ts`; `/gentle:changes` | per-session changed-file list + diff |
| R47 | Image attachments | `lib/image-attachments.ts`, `clipboard-image.ts`, `pasted-image-paths.ts`, `image-disk-cache.ts`; `/gentle:images` | |
| R48 | Command palette & panels | `lib/command-palette*.ts`, `shell-panel.ts`; `/gentle:panel`, `usage`, `commands`, `customize`, `vim`, `animations`, `double-esc-cancel` | |
| R49 | Keybindings & Vim engine | `lib/keymaps*.ts`, `vim-*.ts`, `pi-tui-keys.ts` | custom editor component |
| R50 | `session_worktree_register` | `extensions/gentle-shell.ts:2645`; `lib/session-worktree-registry.ts` | tool; feeds writer admission worktree resolution |
| R51 | Quiet tools | `extensions/quiet-tools.ts`, `lib/quiet-tools-config.ts` | re-registers built-in tool renderers |
| R52 | Codemode & hidden tools | `lib/hidden-tools.ts`, `codemode-renderer.ts`, `builtin-codemode-optout.ts` | tool batching script mode |
| R53 | Skill registry | `extensions/skill-registry.ts` (1,033 lines); `/skill-registry:refresh`, `--no-skill-registry` | builds trigger→path index, injects it |
| R54 | Themes | `themes/*.json`, `lib/terminal-theme.ts`, `theme-customization.ts` | Pi theme schema |
| R55 | Prompt history | `extensions/history/`, `lib/history-capture-policy.ts`; doc `prompt-history.md` | |
| R56 | Session scratch | `extensions/session-scratch.ts`; `/gentle:scratch` | per-session temp dir |
| R57 | Notifications & audio | `extensions/gentle-notifications.ts`, `lib/notification-*.ts`; `assets/sounds` | players: `afplay` (macOS), `paplay`/`pw-play` (Linux), fixed Windows `powershell.exe` incl. WSL |
| R58 | Voice dictation | `extensions/gentle-voice.ts`, `lib/voice-*.ts`, `scripts/voice-worker.cjs`; `/gentle:voice` | local STT worker, model download |
| R59 | Music | `extensions/gentle-music.ts` (364 lines); `/gentle:music` | hands the terminal to the external `gentle-stream` TUI (stops Pi TUI, like Ctrl+G external editor); `session_shutdown` cleanup |
| R60 | Desktop RPC & feed | `extensions/gentle-desktop-*.ts`, `lib/desktop-*.ts` (≈30 files); docs `desktop-rpc.md`, `desktop-feed.md`, `gentle-shell-desktop.md` | JSON RPC for a separate desktop app |
| R61 | herdr integration | `extensions/gentle-herdr-*.ts`, `lib/herdr-*.ts`, `herdr/` | publishes agent state to the herdr multiplexer |
| R62 | Program identity (terminal title) | `extensions/gentle-program-identity.ts` | sets title on `session_start`, restores on shutdown |
| R63 | Star prompt | `extensions/gentle-star-prompt.ts`, `lib/star-prompt.ts` | asks to star the repo on GitHub |
| R64 | Resume hint | `extensions/resume-hint.ts`, `runtime/gentle-shell-resume-hint.mjs` | prints how to resume on exit |
| R65 | pi-pretty | `extensions/pi-pretty.ts` | wrapper over npm dependency `@heyhuynhgiabuu/pi-pretty` |

### 2.7 Distribution, host, extras found during inventory

| ID | Feature | Key files | Notes |
|---|---|---|---|
| R66 | Launcher | `bin/gentle-shell.mjs`, `lib/gentle-shell-launcher.ts`, `runtime/gentle-shell-launcher.mjs`, `gentle-shell-startup-flow.mjs`, `gentle-shell-import-pi.mjs` | starts Pi with the package, bundled prefix |
| R67 | Bundled runtime / installer | `lib/gentle-shell-bundled.ts`, `scripts/install-gentle-ai.mjs`, `bundled-install.mjs`, `installer-*.mjs`, `assets/install-wizard/` | private prefix with pinned Pi, gentle-ai, engram; web installer |
| R68 | Update & uninstall | `lib/gentle-shell-startup-update.ts`, `gentle-shell-update-panel.ts`, `gentle-shell-uninstall.ts`, `update-status.ts`; `scripts/pi-update.mjs` | |
| R69 | RPC/TUI mode, animations, cards | `lib/rpc-host.ts`, `animation-policy.ts`, `card-*-policy.ts`, `shell-card.ts` | adapts UI when Pi runs `--mode rpc` |
| R70 | Agent status file *(added)* | `extensions/gentle-agent-status.ts`, `lib/agent-status.ts`; doc `agent-status.md` | writes a status file (working/idle/task) consumed by external tools |
| R71 | herdr desktop status *(added)* | `extensions/gentle-herdr-desktop-status.ts`, `lib/herdr-desktop-status.ts`, `herdr-desktop-events.ts` | bridges Pi events to herdr/desktop |
| R72 | Reply-language anchor *(added)* | `lib/reply-language-anchor.ts`, `card-content-policy.ts`; `orchestrator-delegation.md` "Language Boundary" | keeps replies in the user's language, subagent output in English unless pasted to user |
| R73 | Managed asset migrations *(added)* | `assets/migrations/*.json`, `scripts/update-agent-body-history.mjs`, `lib/agent-assets.ts`, `agent-home.ts` | upgrades user-modified agent files by sha256 history |
| R74 | Request-context placement & prompt diet *(added)* | `lib/request-context-placement.ts`, `docs/prompt-budget.md` | decides where review-request context sits in prompt |

---

## 3. Content assets

### 3.1 Agents (`assets/agents/*.md`, A01–A10)

Frontmatter `tools:` exactly as shipped (Pi tool names). `"*": false` = deny-all-then-allow.

| ID | File | Description (frontmatter) | `tools:` |
|---|---|---|---|
| A01 | `gentle-ai-explore.md` | read-only local and web exploration, economical model | read, grep, find, codegraph, web_enable, web_search, source_check, fetch_content, get_search_content, mcp__codegraph__codegraph_explore |
| A02 | `gentle-ai-verify.md` | read-only technical verification | read, grep, find, bash, mcp__codegraph__codegraph_explore |
| A03 | `gentle-ai-worker.md` | scoped implementation writer, no commit | read, grep, find, edit, write, bash, mem_save, mcp__codegraph__codegraph_explore |
| A04 | `jd-fix-agent.md` | Judgment Day surgical fix | read, grep, find, edit, write, bash, mcp__codegraph__codegraph_explore |
| A05 | `jd-judge-a.md` | blind adversarial reviewer A, read-only | `"*": false`, read, grep, find, bash, mcp__codegraph__codegraph_explore |
| A06 | `jd-judge-b.md` | blind adversarial reviewer B, read-only | same as A05 |
| A07 | `review-risk.md` | R1 Risk (security, privilege, data exposure, deps) | `"*": false`, read, grep, find, gentle_review_scope |
| A08 | `review-resilience.md` | R4 Resilience (fallbacks, retry, observability, rollback, SLO) | same shape as A07 |
| A09 | `review-readability.md` | R2 Readability (naming, complexity, review size) | same shape as A07 |
| A10 | `review-reliability.md` | R3 Reliability (tests, edge cases, determinism, contracts) | same shape as A07 |

Frontmatter carries only `name`, `description`, `tools` (no model/effort; the model is resolved at runtime by R40).

### 3.2 Chain

| ID | File | Content |
|---|---|---|
| A11 | `assets/chains/4r-review.chain.md` | Pi chain: sequential sections `review-risk`, `review-resilience`, `review-readability`, `review-reliability`; each `output: <name>-report.md`, `outputMode: file-only`, `progress: true`; each runs once against the supplied `initial_review_tree`. Declared "manual/compat lane only"; the controller owns authority. |

### 3.3 Orchestrator cards (`assets/orchestrator*.md`, A12–A23)

`orchestrator.md` is the always-loaded prompt; the rest are lazy cards.

| ID | File | Lines | Rule set |
|---|---|---|---|
| A12 | `orchestrator.md` | 86 | Core role; **Task Size** (3 conditions: understood in one bounded read batch ≤3 calls/~10k tokens, contained risk, resumable from the diff; high-risk list; `Risk:` line); **Delegation Rules** (Ask → Evidence-budget → Verification → Track → Writer → Incident); Mechanisms; Language Boundary |
| A13 | `orchestrator-delegation.md` | 46 | Handoff, Launch; preserve exact quotes; Spanish only when output is pasted to user; the six rules above in card form |
| A14 | `orchestrator-delegation-reference.md` | 157 | Session subject/display identity; **Pi Runtime Overlays**; detailed launch reference |
| A15 | `orchestrator-full-delegation.md` | 34 | Full-delegation mode: what stays yours, task size, rules, mechanisms (coordinator never implements) |
| A16 | `orchestrator-full-delegation-card.md` | 60 | Lazy card for full mode (generated by `scripts/build-full-delegation-card.mjs`): handoff, launch |
| A17 | `orchestrator-memory.md` | 33 | Engram usage detail (search, topic keys, session summary) |
| A18 | `orchestrator-prompts.md` | 20 | Delegation prompts and provider defects |
| A19 | `orchestrator-quota-recovery.md` | 5 | Temporary verifier quota recovery: one new bounded run only after human asks |
| A20 | `orchestrator-skills.md` | 50 | Skill Registry Protocol; intent-driven skill discovery |
| A21 | `orchestrator-tracking.md` | 49 | ODD tracking: feature doc, delivery strategies (feature-branch-chain, stacked-to-main, single-pr) |
| A22 | `orchestrator-verification.md` | 42 | Verification rule (normative), agent escalation, verifier preparation failure, proportionality, parallel review protocol |
| A23 | `orchestrator-writer.md` | 42 | Writer handoff; Judgment Day 5-section fix dispatch (`## Judgment Day activation`, `## Exact authorized severe IDs`, `## Judgment Day correction batch`, `## Exact frozen finding rows`, `## Allowed edit surfaces`) |

### 3.4 Support, migrations, sounds, misc assets

| ID | Path | Content |
|---|---|---|
| A24 | `assets/support/strict-tdd.md`, `strict-tdd-verify.md` | "Applicable test-first" policy: RED → GREEN → TRIANGULATE → REFACTOR; legacy filename, not a Strict-TDD switch; verify variant for verifiers |
| A25 | `assets/migrations/*.json` (5) | `agent-body-history.json` + managed-asset manifests v0.10.7 / v0.13 / v0.14 / v2.5.0 for upgrading installed agent files |
| A26 | `assets/sounds/` | `success.wav`, `error.wav`, `attention.wav` (original synthetic sine tones, mono PCM 16-bit 22050 Hz) + `LICENSE.md` |
| A27 | `assets/install-wizard/` | `index.html`, `wizard.css`, `wizard.js` (browser installer UI) |
| A28 | `assets/design-canvas/` | 31 files: `canvas*.js` modules, `canvas.css`, `index.html`, `inspector.js`, `theme-early.js`, ES i18n |
| A29 | `assets/gentle-logo-only.png` | logo |

### 3.5 Skills (`skills/*`, A30–A45)

All have `SKILL.md` with `name` + `description` (trigger text). Skill `name` values carry the `gentle-ai-` prefix except `gentle-ai`, `gentle-design`, `gentle-ui-design`.

| ID | Dir | `name` | Lines | Support files | Pi-specific references in body |
|---|---|---|---|---|---|
| A30 | `skills/branch-pr` | gentle-ai-branch-pr | 174 | – | none |
| A31 | `skills/chained-pr` | gentle-ai-chained-pr | 70 | `references/chaining-details.md` | none |
| A32 | `skills/cognitive-doc-design` | gentle-ai-cognitive-doc-design | 81 | – | none |
| A33 | `skills/comment-writer` | gentle-ai-comment-writer | 74 | – | none |
| A34 | `skills/design` | gentle-design | 113 | – | tools `gentle_design` (×6), `gentle_design_comments` (×3); writes `design/<slug>/` |
| A35 | `skills/gentle-ai` | gentle-ai | 60 | – | "Pi work" wording (2 mentions); describes harness discipline (clarify, track ODD, test-first, delegate, protect review workload) |
| A36 | `skills/gentle-ui-design` | gentle-ui-design | 46 | `references/` ×4 (adaptive-interfaces, browse-and-compare, composition-and-feedback, task-and-content) | none |
| A37 | `skills/issue-creation` | gentle-ai-issue-creation | 115 | `references/delegated-workflow-actions.md` | none (references delegated workflow actions) |
| A38 | `skills/judgment-day` | gentle-ai-judgment-day | 94 | `references/prompts-and-formats.md` | none in SKILL.md; reference prompts describe the 5-section dispatch consumed by R28 |
| A39 | `skills/provider-defect-report` | gentle-ai-provider-defect-report | 61 | – | none (depends on the Go binary's provider defect flow) |
| A40 | `skills/rdd-defect-workflow` | gentle-ai-rdd-defect-workflow | 54 | – | "Pi" ×2 (about RDD review authority) |
| A41 | `skills/skill-creator` | gentle-ai-skill-creator | 86 | – | "Pi" ×1 (target runtime) |
| A42 | `skills/skill-improver` | gentle-ai-skill-improver | 53 | – | "Pi" ×1 |
| A43 | `skills/skill-registry` | gentle-ai-skill-registry | 51 | – | "Pi" ×5 (registry location/runtime) |
| A44 | `skills/tui-design` | gentle-ai-tui-design | 56 | `NOTICE.md`, `references/` ×5 (commands, critique, design-doc, terminal-craft, visual-loop) | `todo` ×3 |
| A45 | `skills/work-unit-commits` | gentle-ai-work-unit-commits | 99 | – | none |

Pi tool mentions were found by grep over `SKILL.md` + `references/` for `subagent_*`, `gentle_*`, `ask_user_*`, `bash_background`, `todo`, `codegraph`, `mem_*`, `/gentle:*`, `GENTLE_PI_*`, `orchestrator_*`, `Pi`. Skills other than the ones listed carry no tool-name coupling.

### 3.6 Prompt template

| ID | Path | Content |
|---|---|---|
| A46 | `prompts/skill-creation.md` | Pi prompt template; frontmatter `description`, `argument-hint`; body uses `$ARGUMENTS`; delegates to skill `gentle-ai-skill-creator`, falls back to reading `skills/skill-creator/SKILL.md` and `docs/skill-style-guide.md` |

### 3.7 Contracts

| ID | Path | Content |
|---|---|---|
| A47 | `contracts/review-integration/v1`, `v2` (`schemas/`, `fixtures/`) | JSON schemas for the review host↔provider protocol; v2 schemas include `start`, `operation`, `capabilities`, `consent`, `failure`, `repair`, `admitted-result`, `artifact-subject`, `last-event-closure`, `opencode-provider-role` |
| A48 | `contracts/review-provider-contract-mirror/` | `provider-contract.lock.json` + `v1.6.0/{bundle,generated}`; mirror of the Go provider's contract, checked by `scripts/check-provider-contract.mjs` |
| A49 | `contracts/telemetry/runtime-aggregate-v1.schema.json` | runtime aggregate schema; `host` enum `claude-code | opencode | codex | pi` |

### 3.8 Themes

| ID | Path | Content |
|---|---|---|
| A50 | `themes/Gentle.json`, `Gentleman-Cute.json`, `Gentleman-Sexy.json` | Pi theme JSON |

### 3.9 herdr (A51)

| Path | Content |
|---|---|
| `herdr/layouts/gentle-shell.json`, `herdr/themes/gentle-shell-{dark,light}.json` | layout and themes for the herdr multiplexer |
| `herdr/keys.json` | key map (`cmd-k` palette, `cmd-j` status, `cmd-.` stop, `cmd-o` chat, `cmd-alt-1..6` inspector tabs: changes, todo, agents, jobs, review, session) |
| `herdr/RECIPE.md` | build recipe naming **10** mods: gentle-agents, gentle-chat, gentle-confirm, gentle-inspector, gentle-palette, gentle-sidebar, gentle-spaces, gentle-status, gentle-tabs, gentle-tokens |
| `herdr/mods/` | **11** dirs present: `gentle-agents` (`mod.json` `{place:none,title:"Gentle agents"}`, `main.js`, `snapshot.js`, `tokens.js`), `gentle-chat`, `gentle-confirm`, `gentle-inspector`, `gentle-palette`, `gentle-pane`, `gentle-sidebar`, `gentle-spaces`, `gentle-status`, `gentle-tabs`, `gentle-tokens` |
| Fidelity notes | `FIDELITY-*.md`, `PERF.md`, `mods/gentle-chat/{FIDELITY,MINIMAL,SPIKE}.md` (excluded from the npm package) |

> Correction to the brief: the working tree has **all** mod directories (11, including `gentle-pane` which is not in `RECIPE.md`), not just `gentle-agents` and `gentle-confirm`. Mods are plain JS (`main.js` + `mod.json`) for herdr, **a different host than Claude Code mods**; see [open-questions.md](./open-questions.md).

### 3.10 Web, design, ODD, docs

| ID | Path | Content |
|---|---|---|
| A52 | `web/tower/` | Tower SPA (pixi.js scene `scene.ts`/`art.ts`, mermaid panels `panels.ts`, tour `tour.ts`, data `model.ts`/`types.ts`); built with `pnpm build:tower`; served by `lib/tower-server.ts` |
| A53 | `design/` | `system.md` design system + 3 HTML exploration sets with `design.json` (herdr-desktop, herdr-gentle-shell [11 variants + `SPEC.md`, `spikes/`], shell-rework [`inventory.md`]) |
| A54 | `odd/` | ODD feature documents (230 in `tasks/`, 3 in `prs/`, `notes/contracts-for-cristian.md`, `diagnostics/work-continuity-windows`). **Format** (see `odd/tasks/background-jobs.md`): title + `Branch:`/`Related:`/`References:` header; `## Specs` with `S#` (verbatim user quotes, `(L#)` log refs); `## Tasks` with `T#` (`- T1 — S4: …; inline|delegated; done, commits …`, nested `T5a`); `## Delivery`; `## Risks`; `## Log` with `L#` |
| A55 | `docs/` | 39 `.md` files, grouped below |

`docs/*.md` (39 files; the brief said 40, the tree has 39 plus the `assets/` and `images/` dirs):

| Group | Files |
|---|---|
| Core / overview | `gentle-shell.md`, `readme-reference.md`, `native-authority-architecture.md`, `prompt-budget.md`, `work-continuity.md`, `odd-preparation-continuity.md`, `skill-style-guide.md` |
| Permissions | `permission-modes.md`, `yolo-mode.md`, `auto-permission-answers.md`, `auto-permission-evidence.md` |
| Review / RDD | `review-coordinator.md`, `review-delivery-preflight.md`, `review-integration.md`, `review-request-context.md`, `review-windows-acl.md`, `delegated-verification.md`, `rdd-odd-friction-triage-2026-11-07.md` |
| Agents / models | `gentle-agents-activity.md`, `agent-status.md`, `session-profile-format.md`, `fast-mode.md` |
| Desktop / install | `gentle-shell-desktop.md`, `desktop-rpc.md`, `desktop-feed.md`, `bundled-install.md`, `install-wizard.md`, `gentle-shell-uninstall.md`, `windows-startup-console-visibility.md` |
| Audio / voice / UX | `sound-notifications.md`, `sound-notifications-proposal.md`, `gentle-music.md`, `voice.md`, `prompt-history.md`, `star-prompt.md` |
| Integrations / telemetry / perf | `mcp-status.md`, `telemetry.md`, `ci-performance.md`, `render-cache-performance.md` |

### 3.11 Scripts (`scripts/`, A56)

| Group | Files | Purpose |
|---|---|---|
| Install / bundle | `install-gentle-ai.mjs` (postinstall), `bundled-install.mjs`, `bundled-wizard.mjs`, `bundled-engram-migration.mjs`, `installer-{downloads,preflight,probes,runner,server,windows}.mjs`, `installer-windows-artifacts.json`, `gentle-ai-installer.mjs`, `gentle-ai-proxy.mjs`, `download-progress.mjs`, `install-wizard-preview.mjs`, `install-tui-mode-setting.mjs`, `bootstrap.sh/.cmd`, `build-installer-bundles.mjs`, `build-distribution.mjs`, `main-channel.mjs`, `pi-update.mjs`, `verify-installer-tap.mjs`, `test-installer-acceptance.sh` | install Pi + gentle-ai + engram, update channel |
| Build / generate | `build-runtime-modules.mjs`, `build-full-delegation-card.mjs`, `update-agent-body-history.mjs`, `mirror-provider-contract.mjs` | generate `runtime/`, A16, migration history, mirror |
| Verify / test | `run-test-suite.mjs`, `check-types.mjs` (+`types-baseline.json`), `check-provider-contract.mjs`, `verify-package-files.mjs`, `test-packed-runner.mjs`, `npm-pack-result.mjs`, `measure-native-authority-slimming.mjs`, `render-cache-*.mjs`, `shell-snapshot.mjs`, `maintainer/provider-relay-matrix.mjs` | CI and packaging |
| Runtime helpers | `prepare-verifier.mjs` (offline single-root git prep for a verifier scratch tree), `voice-worker.cjs` (STT worker) | used at runtime |

---

## 4. External dependencies

| Dependency | Used by | Notes |
|---|---|---|
| **Pi** (`@earendil-works/pi-coding-agent` ≥1.2.0, `pi-ai`, `pi-tui`, `typebox`) | everything in `extensions/`, `lib/agents-runner.ts` (spawns `pi --mode rpc`) | the host being replaced |
| **gentle-ai Go binary** | R29–R33, R37, R38, A39, `contracts/*` | review authority, receipts, lineage; **source not in this upstream**; located by `lib/gentle-ai-binary.ts`; installed by `scripts/install-gentle-ai.mjs` |
| **engram** | R38, A17, agent tool `mem_save`, `bin/engram-guard` | persistent memory (`ENGRAM_BIN`, `ENGRAM_URL`) |
| **codegraph** CLI / MCP | R13, agent tools `mcp__codegraph__codegraph_explore`, `lib/background-cache-warming.ts` | |
| **herdr** | R61, R70–R71, A51 | terminal multiplexer |
| **gentle-stream** | R59 | external music TUI |
| `git`, `gh` | R32, skills `branch-pr`, `chained-pr`, `issue-creation`, `work-unit-commits` | |
| `powershell.exe` | R57 (Windows/WSL audio), R08 (`windows-session-transport.ps1`) | fixed paths |
| `afplay` / `paplay` / `pw-play` | R57 | macOS / Linux players |
| Node ≥22.19, pnpm | build, runtime modules | |
| npm deps | `@heyhuynhgiabuu/pi-pretty`; tower: `pixi.js`, `mermaid`, `vite` | |
| Network endpoints | GitHub (star prompt, update checks, release downloads), npm registry (update), provider usage APIs (`lib/shell-usage.ts`), voice model downloads (`lib/voice-artifacts.ts`), `lib/design-canvas-server.ts` / `tower-server.ts` (**local** `127.0.0.1` servers), corporate proxy support (`scripts/gentle-ai-proxy.mjs`) | exact hostnames: see the cited files |

---

## 5. Cross-cutting mechanisms

### 5.1 System prompt assembly (`extensions/gentle-ai.ts` `before_agent_start`, `:13053`)

1. Classify the start: `isNamedAgent` (subagent launched by name), `isChildSession` (`GENTLE_PI_AGENTS_CHILD=1`), else **primary session**.
2. Primary only: reset exploration budget; subagent-depth bookkeeping; (telemetry nudge `:13065+`, excluded from the port).
3. Primary sessions get the orchestrator prompt (`assets/orchestrator.md`, or the full-delegation variant by R02) with placeholders resolved (`{{GENTLE_PI_ASSETS_ROOT}}` → absolute assets path so the model can lazy-read cards; `{{GENTLE_PI_BACKGROUND_POLICY}}` → R12 text), then optional fragments (set and order inferred from the helpers around `:1389-:1698`, not traced line by line): review provider contract (R03), permission directive (R24 `<gentle-auto-permissions>`), persona, skill registry (R53), reply-language anchor, profile info.
4. Everything is appended through `appendSystemPromptOnce` (idempotent per turn).
5. Children get a reduced prompt and filtered context files (R04).

### 5.2 `tool_call` admission order (`gentle-ai.ts:13315-13421`)

| # | Step | Source |
|---|---|---|
| 1 | Skip nested `gentle_review*` calls from codemode | `:13316-13320` |
| 2 | Exploration budget counts the call (R14) | `:13322` |
| 3 | Count verifier launch attempt before any rejection (R27) | `:13324` |
| 4 | One early mode read (binds session mode + epoch) | `:13325` |
| 5 | Sensitive path guard (R22) | `evaluateSensitivePathTool` |
| 6 | Execution-surface guard | `evaluateExecutionSurfaceTool` |
| 7 | Delivered-test lint | `evaluateDeliveredTestTool` |
| 8 | If `subagent_run`: Judgment Day dispatch (R28) → bounded writer scope (R26) → undocumented writer / context backstop (R26/R34) → unrisked verifier (R27) | `:13341-13364` |
| 9 | Mode-config tamper guard | `modeConfigDenied` |
| 10 | Non-shell tools: permission gate and return | `gate()` |
| 11 | Shell tools: child destructive-command block (R23) when `GENTLE_PI_AGENTS_CHILD=1` | `:13385` |
| 12 | Bash policies (destructive confirm, allow-always, mode: normal/auto/yolo) (R21, R20, R24) | `evaluateBashPolicies` |
| 13 | Review delivery preflight (R32) after any dialog, then epoch recheck | `checkReviewDeliveryPreflight` |
| 14 | Cost-speed P9 checks (fail open), final epoch recheck (no `await` after it) | `:13410-13421` |

### 5.3 Bounded writer admission (`lib/bounded-writer-admission.ts`)

Writer names: `gentle-ai-worker`, `worker`, `jd-fix-agent`. A `subagent_run` for one of them is rejected unless the prompt contains a non-empty `## Allowed edit surfaces` with narrow repository-relative paths/globs (the rejection text ends with a fixed rule sentence), no overlap with other writers of the same assistant message (`writer-surfaces.ts`, `writer-batch-admission.ts`), a feature document when the mode requires one (`odd/tasks/<feature>.md`), and context usage below the backstop (R34). Worktree is resolved per session via R50.

### 5.4 Child safety

`GENTLE_PI_AGENTS_CHILD=1` is set by the runner; children get filtered context (R04), `child-safety.ts` blocks destructive shell commands, writer/verifier admission applies to what they may be launched with, and `subagent_parent_message` is their only channel to the parent (R06).

### 5.5 Super yolo and permission modes

Modes are stored per session with an epoch; any mode change during an in-flight admission invalidates the action ("Permission mode changed during delivery preflight…"). `super-yolo` skips prompts and uses a scratch temp dir (`yolo-temp-scratch.ts`); `auto` adds the classifier (R24) which may ask the human; `normal` asks for destructive/unknown actions with allow-always memory.

### 5.6 Quota recovery (`lib/model-fallback-policy.ts`)

`FALL_BACK` set = quota, auth, rate-limit, transient provider categories; request errors never fall back. A cooldown map (`sharedCooldown`) is shared across runs; `pickModel` takes the next entry in a `FallbackChain` (`model-fallback-store.ts`); `fallbackContinuePrompt` tells the child to continue. Parent-side rule: A19 (verifier quota recovery needs an explicit human request).

### 5.7 Telemetry (described for completeness; excluded from the port)

`lib/telemetry-trigger.ts` spawns the Go binary's own telemetry op at most once per process; `runtime-metrics*.ts` aggregate provider requests/turns into the schema in A49; `/gentle:telemetry` relays JSON. See [../README.md](../README.md) for the decision record.

---

## 6. Coverage gaps

What this inventory did **not** read in depth (so claims are from headers, greps and file lists):

| Gap | What is missing |
|---|---|
| `extensions/gentle-ai.ts` | ~14k lines; only the handlers around `:13053`, `:13315-13421`, tool registrations and command list were read |
| `lib/` (294 entries) | Only headers/imports of `agents-runner`, `auto-permission-*`, `bounded-writer-admission`, `model-fallback-policy`, `telemetry-trigger`, `background-jobs-tools` read; the 37 `review-*` files grouped by name, not read |
| Slash commands | Registered: `gentle:profiles, persona, dev-binary, doctor, review-session-permission, status-timing, rdd, review-mode, telemetry, background-subagents, status, install-<owner>` (gentle-ai.ts); `customize, vim, animations, panel, usage, images, changes, commands, double-esc-cancel` (gentle-shell.ts); `agents, jobs` (gentle-agents.ts); plus `design, guide, music, stats, tower, scratch, voice, desktop-rpc` and `skill-registry:refresh`. `/gentle:mode` and `/gentle:yolo` were not located by registration grep (registered via a helper); `startup-banner.ts` registers 3 more under dynamic names |
| `subagent_*` tool definitions | Names confirmed from messages and schemas; their registration site was not located by literal-string grep (likely generated from a list) |
| Skill bodies | Frontmatter, size and Pi-tool greps only; the 16 bodies were not read line by line |
| Orchestrator cards | Headings and numbered rules only |
| Go binary | Not in upstream; behavior inferred from `lib/native-review-cli.ts` and contracts |
| herdr mods | File lists and `mod.json` of one mod; JS not read |
| `tests/` (610) and `odd/tasks` (230) | Not read; only the format of one task doc |
| `docs/` | Names only; not re-read for contradictions with code |
| Tower | Sizes and package.json only |
