# v0.2 core: declarative ODD layer (Phase 2)
Goal: the ODD workflow as text/config: prompt, cards, agents, skills, native-tool mappings. No enforcement code. Branch: `feat/v0.2-core`.
Runner: `node:test` via `npm test` inside `plugins/odd-claude` + `claude plugin validate` / `claude plugin test`.

## Specs

### S1 Roadmap Phase 2 (docs/roadmap.md, "### Phase 2: Core declarative layer")

- **Goal:** the ODD workflow as text/config: prompt, cards, agents, skills, native-tool mappings. No enforcement code.
- **Matrix IDs:** R01, R02, R05, R06, R10, R11, R12, R13, R15, R16, R50, R53, R72, A01, A02, A03, A04, A05, A06, A12, A13, A14, A17, A18, A19, A20, A21, A22, A23, A24, A26, A30, A31, A32, A33, A35, A36, A37, A38, A41, A42, A43, A44, A45, A46, A54
- **Deliverables:** persona via a forced output style `odd` with `force-for-plugin: true` (R01, verified in Q2; no `/setup` needed) plus SessionStart/UserPromptSubmit `additionalContext` for the rest of the prompt text (R01, R02); never mod `prompt.compose/section/context`, blocked for third-party mods (Q1). Mods are used only for panes, tools and commands UX (Phase 5); `/odd-claude:persona` (R02); reply-language anchor (R72); `cards/*.md` (A12–A14, A17–A23) with tool names rewritten (`subagent_run` → `Agent`, `todo` → TodoWrite) and the "Pi Runtime Overlays" section rewritten (A14); agents `odd-explore`, `odd-verify`, `odd-worker`, `odd-jd-fix`, `odd-jd-judge-a`, `odd-jd-judge-b` (A01–A06); skills under `odd-claude:` (branch-pr, chained-pr, cognitive-doc-design, comment-writer, `odd`, ui-design, issue-creation, judgment-day, skill-creator, skill-improver, skill-registry, tui-design, work-unit-commits); `/odd-claude:skill-creation` (A46); `support/test-first*.md` (A24); `odd/tasks/<feature>.md` format (A54); codegraph MCP + SessionStart warm-up (R13); `/odd-claude:background-subagents` (R12); `/odd-claude:skill-registry` + hook `odd-skill-registry` (R53); `assets/sounds/` (A26).
- **Dependencies / gates:** Phase 1; Q2 (R01), Q6 (agent tool allowlists), Q3 (read-only agent claims; R10 behaviour).
- **Exit criteria:** `claude plugin validate` passes; a fresh session shows the ODD persona (observed in system prompt/behaviour); every skill and agent lists with the `odd-claude:` namespace; grep over shipped files finds no `gentle` string other than attributed notices (A44 `NOTICE.md`, A26 `LICENSE.md`); each `odd-*` agent runs a smoke task using the engram/codegraph MCP names confirmed in Q6; a documented fallback exists if a subagent cannot ask questions (R10).

### S2 Project decisions (user, verbatim)

- "El proyecto se llamara odd-claude no gentle-ai o gentle-shell"
- "ignora completamente otros proyectos como gentle-py tomaremos todo 100% del upstream de este repo"
- "no usaremos nada de prefijo gentle- o gentle-ai todo sera odd-claude nuestro plugin entonces el prefijo sera odd"
- "y sin nada de telemetria"

### S3 Delivery conventions (docs/roadmap.md, "## Delivery conventions")

- **Work-unit commits:** one reviewable unit per commit, about 400 lines of change at most, with its tests and docs together (skill `work-unit-commits`).
- **Tests with behaviour:** behaviour changes ship with tests written first where a deterministic runner applies; guards reuse upstream tests adapted to Node (A58). Docs-only changes state the exception.
- **Checks on every change:** `claude plugin validate` and `claude plugin test` must pass, plus the focused tests of the touched unit.
- **Naming and telemetry checks:** no `gentle-` identifiers we name (attributed notices excepted) and no telemetry code, enforced by grep in checks.

### S4 Spike facts (docs/research/open-questions.md, Findings)

- Q1: "**Prompt hooks do not reach third-party mods in `-p`**: `prompt.compose`, `prompt.section`, `prompt.context` each logged `its <event> hook was skipped. "cc-plugin-sec-default" runs first and sent the event on past it.`; model confirmed none of the 3 marker tokens was in its prompt/context."
- Q1: "Conclusion: the built-in `cc-plugin-sec-default` (tier prepend) bypasses `prompt.*` for third-party (tier user) mods in both interactive and `-p`."
- Q1: "Keep the persona on output styles (Q2) plus hook `additionalContext`; do not use mod `prompt.*`."
- Q2: "`spikes/02-output-style` (style `odd-persona`, `force-for-plugin: true`, body "End every answer with the exact token ODD-MARKER-42 ..."). Fresh `claude -p "Say hi in 3 words." --model haiku --plugin-dir spikes/02-output-style`:" "with plugin: `'Hi there, friend.\n\nODD-MARKER-42'`; control without plugin: `'Hi there friend!'`." "debug log: `Using forced plugin output style: odd-style-spike:odd-persona`. No `/setup` or settings change needed. Style id is namespaced `<plugin>:<style>`."
- Q3: "`agent_type` is the **namespaced** name `<plugin>:<agent>` and is absent for the main thread, so guards can distinguish both."
- Q3: "`tools: Write, Read` was honoured (the agent used Write)."
- Q3: "Ignored fields each emit a `[WARN]` in the debug log only: `Plugin agent file .../odd-probe.md sets permissionMode|hooks|mcpServers|initialPrompt, which is ignored for plugin agents. Use .claude/agents/ for this level of control.`"
- Q6: "Tool name is `mcp__plugin_odd-mcp_oddsrv__ping` (plugin name hyphen kept; log server id `plugin:odd-mcp:oddsrv`)."
- Q6: "Implication: ship agents with the full `mcp__plugin_<plugin>_<server>__<tool>` names; engram/codegraph are only grantable when that server is actually connected."

## Tasks

- T1 | S1,S2,S4 | writer | done, commit bf0980c — Orchestrator prompt & persona: forced output style `odd` from upstream assets/orchestrator.md (A12) + persona modes (R02, `/odd-claude:persona`) + reply-language anchor (R72) + SessionStart/UserPromptSubmit additionalContext handler (R01) that points to the cards path; no mod prompt.* hooks.
- T2 | S1,S2 | writer | done, commit 78eba68 — Cards: cards/*.md from upstream A13, A14, A17–A23 with Pi tool names rewritten to Claude Code native tools (Agent, TodoWrite/Tasks, AskUserQuestion, Bash run_in_background + Monitor, worktree tools) covering R05, R06, R10, R11, R15, R16, R50 mappings.
- T3 | S1,S2,S4 | writer | done, commit 2a8c8bf — Agents A01–A06 → agents/odd-explore, odd-verify, odd-worker, odd-jd-fix, odd-jd-judge-a, odd-jd-judge-b with Claude Code frontmatter (tools mapped, "*": false → disallowedTools, MCP names per Q6).
- T4 | S1,S2 | writer | done, commit eb78d35 — Skills A30–A33, A35–A38, A41–A45 → skills/ under odd-claude:, `/odd-claude:skill-creation` (A46), support/test-first*.md (A24), assets/sounds (A26), feature-doc format reference (A54).
- T5 | S1,S2 | writer | done, commit 163d3ce — Native integrations: codegraph MCP + SessionStart warm-up (R13), `/odd-claude:background-subagents` (R12), skill registry hook + `/odd-claude:skill-registry` (R53).
- T6 | S1,S3 | writer | done-pending-commit — Exit-criteria E2E checks (fresh session shows persona; skills/agents listed under odd-claude:; no gentle string outside attributed notices; agent smoke tasks with engram/codegraph MCP names; R10 fallback documented), plugin README update, roadmap Status Phase 2.

## Log

- L1: user's original request: "dale con 0.2".
- L2: context: v0.1 merged to main by fast-forward on user request "todo de momento con ff a main" (main at 37be6c6).
- L3: out of Phase 2 per roadmap: A34 design skill (Phase 6), A39/A40 (v2), A15/A16 (Phase 3).

- 2026-11-18 slice: 5 commits (T4 eb78d35, T2 78eba68, T1 bf0980c, T3 2a8c8bf, T5 163d3ce), about 5400 authored lines in total, one work unit each; T6 is the sixth unit (docs, allowlists, evidence).
- 2026-11-18 naming rule: persona mode `gentleman` renamed to `mentor` (S2: no upstream-brand identifiers we name).
- 2026-11-18 engram naming: on this machine the engram MCP is user-level (`mcp__engram__mem_*`); `engram@engram` 0.1.22 ships no MCP server, so `mcp__plugin_engram_engram__mem_*` is valid only if a plugin ships one. Prose now names the tools generically with both forms; `odd-worker` lists both `mem_save` names.
- 2026-11-18 codegraph naming: plugin server gives `mcp__plugin_odd-claude_codegraph__codegraph_explore`; with a user-level `codegraph` server Claude Code suppresses the plugin one and the tool is `mcp__codegraph__codegraph_explore`. All agents that use it (odd-explore, odd-verify, odd-worker, odd-jd-fix, odd-jd-judge-a/b) list both names.
- 2026-11-18 T5 stall-and-resume: the T5 writer stalled mid-task and was resumed in the same child session; work was preserved and finished (commit 163d3ce).
- 2026-11-18 T6 evidence (claude 2.1.327, each run from a fresh temp cwd, `timeout 150`, `--model haiku`):
  - (a) persona: "I am odd-claude, a Claude Code workflow harness ... My style is the `odd` output style in its mentor persona". ODD expansion: unified to upstream's "Organic Driven Development" (output-styles/odd.md, cards/tracking.md and agents/odd-worker.md, the T3 drift, now agree).
  - (b) `claude plugin validate plugins/odd-claude`: passed with warnings (name "reads as Anthropic's own", no icon); lists 19 skills and 6 agents under `odd-claude:` plus output style `odd-claude:odd` and the codegraph MCP.
  - (c) `grep -rniE gentle plugins/odd-claude --exclude-dir=node_modules`: only cards/SOURCES.md (attribution table, `odd-check: allow`), NOTICE, README.md (2 lines, `odd-check: allow`), assets/sounds/LICENSE.md ("Gentle AI", attributed A26 notice), scripts/check-naming.mjs (the guard itself), src and dist-test test files (context.test: `odd-check: allow`; persona.test: the rejected-argument "gentleman" case). `npm run check`: ok.
  - (d) agent smokes: odd-explore Glob listing returned the 4 entries; odd-verify ran `pwd` (the user's shell aliases `ls` to eza which printed nothing, an environment quirk); odd-worker created out.txt with `hello` inside `## Allowed edit surfaces` (bypassPermissions only in the temp cwd) and reported status completed; odd-jd-judge-a returned a JSON finding for `a - b` in r.py (shape was `rows`, not the requested keys); codegraph: odd-explore called `mcp__codegraph__codegraph_explore`, server connected, reported no `.codegraph/` index (expected, not initialised); engram: odd-worker inventory showed `mcp__engram__mem_save` and `mcp__codegraph__codegraph_explore`. An allowlist with an unavailable plugin name (`mcp__plugin_engram_engram__mem_save`, `mcp__plugin_odd-claude_codegraph__...`) plus available tools launches fine. No memory was written. Subagents ran in the background by default even when asked for foreground.
  - (e) R10 verified: `AskUserQuestion` is removed from every subagent tool pool (docs "Available tools", first filter), and a probe showed odd-explore without it. The `interaction_required` fallback stays mandatory; cards/prompts.md updated.
  - Checks: `npm run build` ok, `npm test` 140 pass / 0 fail, `npm run check` ok.
