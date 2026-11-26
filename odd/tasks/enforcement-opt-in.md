# Enforcement: opt-in deny profile, advisory notices, agent tools, hygiene
Goal: improve odd-claude's Layer 3 (Enforcement of `docs/claude-code-extensibility.md`): keep no blocking by default, add a user-installed opt-in deny profile, new advisory (non-blocking) notices, tighter agent frontmatter, and hygiene. Branch: `feat/enforcement-opt-in` (base `ebc2d11`). Delivery: `ask-on-risk`, one work-unit commit per task (forecast ~600 authored lines, so slice at task commits), push/PR are the user's. Visible task list: TaskCreate/TodoWrite unavailable in this session, the document is the only tracker.
Runner: `node:test` via `npm test` inside `plugins/odd-claude` + `npm run check`; setup/installer tests run against temp `HOME`/`CLAUDE_CONFIG_DIR`, never the real `~/.claude`.

## Specs

### S1 Goal (verbatim)
- "Vamos a trabajar con el Layer 3 - Enforcement de Layer 3 - Enforcement para mejorar nuestro sistema"

### S2 Policy (verbatim answer)
- "Deny opt-in acotado (Recommended)": the default stays no-block. Add an optional profile that `/odd-setup` activates with `permissions.deny` for secrets (.env, ~/.ssh, credentials) and `git push`/`gh pr merge`. The user installs it, never the plugin, and it can be undone.

### S3 Fronts in scope (verbatim answer, multi-select)
- "Avisos nuevos (sin bloquear), Frontmatter de agentes, Higiene y tests, Permisos opt-in"

### S4 Advisory notices (parent proposal within S3, from the mapping)
- S4a PreToolUse on `Edit|Write|NotebookEdit` from the main thread (no `agent_id`/`agent_type` in hook input) while Coordinator mode is ON: one `additionalContext` notice that the coordinator delegates writes to `odd-worker`. Never deny, ask or block.
- S4b PreToolUse on `Bash` from a subagent (`agent_id` present) whose command is `git commit`, `git push`, `gh pr create` or `gh pr merge`: one `additionalContext` notice that writers never commit or push (the parent owns git). Never deny.
- S4c Risk line: at `Stop` of the main thread, when the working tree changed during the turn and the final assistant message has no `Risk:` line, a user-visible `systemMessage` (never `decision: block`). Only if the Stop hook input or transcript exposes the final assistant message reliably; otherwise record the gap in the Log and skip S4c.
- S4d Every new notice fails open (no output on any error), stays within the existing hook timeouts, and `src/lib/no-deny.spec.ts` keeps passing unchanged in its no-deny assertions.

### S5 Agent frontmatter (parent proposal within S3)
- Read-only agents with unrestricted `Bash` (`odd-verify`, `odd-jd-judge-a`, `odd-jd-judge-b`): tighten only with mechanisms Claude Code documents for subagent frontmatter (e.g. `disallowedTools` entries or Bash permission patterns). Verify support in the official docs first (<https://code.claude.com/docs>); if no documented mechanism restricts Bash without breaking their probes (tests, `git diff`, `mktemp -d` scratch copies), change nothing and record why in the Log.

### S6 Opt-in deny profile (parent proposal within S2)
- `/odd-setup` gets an explicit subcommand to install and remove a `permissions.deny` profile: secrets (`.env*`, `~/.ssh/**`, credentials files such as `~/.aws/credentials`, `**/*.pem`, `**/*.key`) for Read/Edit, and `Bash(git push*)`, `Bash(gh pr merge*)`.
- Same safety as the existing `defaultMode` path: shows a diff, asks for confirmation, takes a backup, merges (never overwrites other keys or foreign deny rules), records ownership so removal deletes only the rules it added, and `restore` still works.
- The installer never writes it; the default install stays no-deny. Help text, skill `odd-setup` and README document it.

### S7 Hygiene (parent proposal within S3)
- S7a Specs for the `StopFailure` and `SessionEnd` handlers (no dedicated spec today).
- S7b Statusline contradiction: README says the statusline was removed, but `src/installer/statusline.ts`, `args.ts` (`--no-statusline`) and `payload.ts` still install it. Make README match the code (do not remove the feature).
- S7c `docs/claude-code-extensibility.md` (untracked, user's file): add a short "odd-claude today" note to Layer 3 describing the final enforcement state after this feature.

## Decisions
- D1 The 2026-11-18 "no deny anywhere" decision (`odd/tasks/v0-5-guards.md` S6) is narrowed, not reversed: the plugin itself still ships no deny/ask/block; only the user-run `/odd-setup` opt-in profile adds `permissions.deny`.
- D2 Subagent identity in hook input: `agent_id`/`agent_type` (already used by `src/hooks/post-tool-use.ts:15`).

## Tasks
- [x] T2 S4 Advisory notices. Route: delegated odd-worker (Coordinator ON), parallel with T3. Risk: none. Commit: 6952407 (S4c skipped, see L5). done when: specs cover S4a/S4b (and S4c or its Log gap), no-deny.spec passes, `npm test` and `npm run check` pass.
- [x] T3 S5 Agent frontmatter. Route: delegated odd-worker (Coordinator ON), parallel with T2 (disjoint: `agents/`); docs via odd-explore. Risk: item 2 (agent tool sandbox). Commit: none (no change, see L4). done when: frontmatter changed only with documented support (or Log records no change), `npm test` passes; independent odd-verify PASS if changed.
- [x] T4 S6 Opt-in deny profile in `/odd-setup`. Route: delegated odd-worker after T2 (shares README). Risk: items 2 and 5 (permissions, user settings). Commit: 56240f0 (odd-verify PASS after one correction, L8-L9). done when: setup tests in temp HOME show install, idempotent reinstall, removal of only owned rules with foreign rules kept, restore; installer writes no deny; `npm test` passes; independent odd-verify PASS.
- [ ] T1 S7 Hygiene and docs. Route: delegated odd-worker after T4 (shares README). Risk: none. Commit: -. done when: StopFailure/SessionEnd specs exist and pass, README statusline text matches code, Layer 3 note added, `npm test` passes.

## Log
- L1 User request (verbatim): "Vamos a trabajar con el Layer 3 - Enforcement de Layer 3 - Enforcement para mejorar nuestro sistema"
- L2 Mapping (3 explorers): only blocker today is the RDD Stop settle reminder (`src/hooks/stop.ts:78`); PreToolUse Bash is notice-only; all hooks fail open; `src/lib/no-deny.spec.ts` pins no deny/ask. No mod ships. Installer writes no `permissions.allow/ask/deny`; `/odd-setup` writes only `permissions.defaultMode`. Unused events include PermissionRequest, PostToolUseFailure, TaskCompleted, PreCompact. StopFailure/SessionEnd have no dedicated spec. README says statusline removed but installer still installs it.
- L3 User answers: policy "Deny opt-in acotado (Recommended)"; fronts "Avisos nuevos (sin bloquear), Frontmatter de agentes, Higiene y tests, Permisos opt-in".
- L4 T3 closed with no change (S5 "change nothing and record why"). Official docs, https://code.claude.com/docs/en/sub-agents: "A `disallowedTools` entry with a specifier, such as `Bash(git push *)`, still removes the whole tool from the subagent, not only the matching commands. To keep Bash and block specific commands, add a Bash deny rule such as `Bash(git push *)` to `permissions.deny` in your settings. The rule applies to the main conversation and to subagents." So no frontmatter mechanism restricts Bash partially; odd-verify needs Bash for probes. The documented route is `permissions.deny`, which is T4's opt-in profile (it also covers subagents). Caveat from https://code.claude.com/docs/en/permissions: `Bash(git push *)` does not catch `git -C . push`. Hooks docs confirm `last_assistant_message` on Stop and `agent_id`/`agent_type` on subagent tool events (forwarded to T2).
- L5 T2 done, commit 6952407. S4a/S4b/S4d implemented in `src/lib/advisory-notices.ts` (PreToolUse matcher `Bash|Edit|Write|NotebookEdit`); RED observed first; differential vs ebc2d11: 24 runs identical. Parent approved changing only the PreToolUse matcher pin and title in `no-deny.spec.ts` (no-deny assertions unchanged). Worker: `npm test`: 1485 pass, 0 fail; `npm run check`: ok. Parent spot check: advisory-notices + no-deny specs 17/17 pass. S4c skipped (accepted gap): Stop exposes `last_assistant_message`, but "tree changed during the turn" needs a git baseline on every UserPromptSubmit (hot-path cost, misses already-dirty files). Known limit: S4b match is lexical (`echo git commit` also notifies).
- L6 T4 writer done (uncommitted): `--deny-profile install|remove` in setup CLI + `/odd-setup deny-profile install|remove`; ownership in setup plugin state (`denyProfileOwned`); 12 rules (`Read/Edit` of `**/.env*`, `~/.ssh/**`, `~/.aws/credentials`, `**/*.pem`, `**/*.key`; `Bash(git push *)`, `Bash(gh pr merge *)`). Worker: `npm test`: 1496 pass, 0 fail; `npm run check`: ok; differential vs 6952407: `--mode`/`--restore` identical. Parent spot check: deny-profile spec 11/11 pass. Writer-flagged concerns: stale ownership after restore to an older backup; misleading error if ownership write fails after settings write. Independent odd-verify and a docs check of the rule path syntax launched.
- L7 Rule syntax checked against https://code.claude.com/docs/en/permissions: all 12 rules valid ("Read and Edit rules both use gitignore pattern syntax"; `~/path` = "Path from home directory"; `**/` any depth under cwd). Limits to document: `Read` deny is "best-effort" for Grep/Glob and Bash file commands (`cat`, `head`, `sed`, `tee`); `grep -r` and scripts are not covered; `Bash(...)` deny rules "aren't a security boundary".
- L8 odd-verify T4: clauses 1,3,5,6 PASS; 2 FAIL after restore (blocker 1: `applyRestore` leaves `denyProfileOwned` stale, so remove deletes a hand-re-added rule); 4 FAIL on repeated `--deny-profile` (blocker 2: last value wins). Advisories: false "settings left as they were" when ownership write fails after settings write; bare `git push` match by `Bash(git push *)` unverified. One correction batch sent to the same writer (blockers 1-2 plus message fix, exact `Bash(git push)`/`Bash(gh pr merge)` rules, documented limits from L7).
- L9 T4 done, commit 56240f0. Correction batch: restore prunes `denyProfileOwned` to rules still present; repeated `--deny-profile` exits 2; truthful ownership-write failure message; 14 rules (adds exact `Bash(git push)`, `Bash(gh pr merge)`); documented limits in SKILL.md/README. Writer: RED 10 pass/4 fail, then `npm test`: 1499 pass, 0 fail; `npm run check`: ok. odd-verify re-check: blocker 1 PASS, blocker 2 PASS, clauses 1-6 unchanged. Verifier's concurrent full suite had 4 failures in `review-server.spec`/`crash.spec` (long-running, under load); parent re-ran both specs alone: 43/43 pass. Advisory kept (safe direction): after restore re-applies an installed state, ownership stays empty, so `remove` reports no changes and `restore` is the undo path.
