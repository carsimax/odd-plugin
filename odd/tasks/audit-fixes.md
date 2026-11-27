# audit-fixes: fix the 2026-11-27 ponytail audit of plugins/odd-claude
Objective: fix the 20 ranked findings and the 10 minor findings of the audit of `plugins/odd-claude`. Branch: `fix/audit-findings` (base `5021867`). Delivery: `ask-on-risk`, one work-unit commit per task; push/PR/release are the user's.
Runner: `cd plugins/odd-claude && npm run build && npm run build:test && node --test "dist-test/<area>/*.spec.js"` (focused); full suite `npm test` (parent seam check). TUI: `cd plugins/odd-claude/tui && npm test`. `dist/` is committed: the parent rebuilds once after all units and commits each unit's `dist/` files with it.

## Specs

### S1 Request (verbatim, L1)
- "Trabajemos en los 20 puntos mas + los 10 menores"
- Scope = findings S2-S31 below, each with the fix proposed in the audit. Smallest complete fix; prefer deletion; one regression test per behavior fix (RED first).

### Installer (T1)
- S2 (#1) Plugin migration loses state: `src/installer/orchestrate.ts:243-272` uninstalls the plugin (`claude plugin uninstall <id>`, no `--keep-data`, which deletes `~/.claude/plugins/data/{id}/`) and copies state from that dir AFTER. Copy state BEFORE uninstalling; `pluginDataDir` must use `ctx.paths.claudeDir` (honours `CLAUDE_CONFIG_DIR`), not `<home>/.claude`. Test: fake runner that deletes the data dir on uninstall still ends with state copied.
- S3 (#5) `backups --restore` (`src/installer/backup.ts:57-66`, `orchestrate.ts:631-641`) overwrites live files without a backup and leaves manifest hashes stale. Back up current targets before copying; refresh (or drop) restored paths in the manifest so they are not treated as user-edited.
- S4 (#6) `src/installer/managed-settings.ts:52-59`: corrupt `settings-state.json` is read as `{}`. Return `{}` only on ENOENT; throw on unparseable, like `readManifest` (`manifest.ts:37-51`).
- S5 (#10) `src/installer/extras.ts:42-66`: reinstalling with an extra turned off (e.g. `--no-statusline`, `--keep-claude-ai-connectors`) leaves odd's owned value in settings.json. Restore owned extras keys no longer in the plan.
- S6 (minor) `src/installer/hooks-config.ts:46-70`: `installHooks` never drops odd hook events a newer `hooks.json` no longer ships. Use `mergeHooks(unmergeHooks(s, oddRoot), entries)`; foreign hooks untouched.
- S7 (minor) No lock around install/update: two concurrent runs race on `renameSync` of the version dir. Exclusive lock file (`openSync(join(oddHome, ".lock"), "wx")`, released in `finally`) around `runFullInstall` and `runUpdateFlow` only (NOT `runReapply`, which the update's new-version child runs while the parent holds the lock). A held lock fails with a clear message.

### Update and release (T2)
- S8 (#9) `src/installer/update.ts:72-76,222`: explicit `update` uses the 6 h release cache. `runUpdate` calls `checkLatest` with `force: true`; cache stays for detect/status.
- S9 (#11) `scripts/release-payload.mjs:25,33,97-100`: `--bundle` must be required (`fail("--bundle <path> is required")`); update `release-scripts.spec.ts:80`.
- S10 (#15) Nothing stops a stale `dist/` from shipping: `release-payload.mjs` runs the build first and fails when `git diff --exit-code -- dist` (package-relative) is non-empty.
- S11 (#16) `src/installer/payload.ts:124-148` `listVersions` sorts prereleases after their release. Sort with `compareVersions` (move it to `payload.ts` if needed to avoid a circular import; `update.ts` re-exports or imports it) and delete `versionParts`.
- S12 (#20 part) Duplicates: delete `atomicWriteFile` copy in `src/installer/manifest.ts:24-35`, import `lib/state.ts`'s; `scripts/bump-version.mjs:18-39` imports `compareVersions` from `dist` like `release-payload.mjs`.

### Hooks and lib (T3)
- S13 (#4) `src/hooks/post-tool-use.ts:15`, `src/lib/advisory-notices.ts:20`: subagent = `agent_id` present only. Claude Code docs: `agent_type` is "Present when the session uses `--agent` or the hook fires inside a subagent". Update `post-tool-use.spec.ts:97`, `run.spec.ts:143`.
- S14 (#12) Per-session `sessions/<id>.json`, `status/<id>.json` never cleaned (159 files observed). On SessionStart prune files in `sessions/` and `status/` whose mtime is older than 7 days (never the current session, never lock files that are held); one test.
- S15 (#17) `src/lib/subagents.ts:45-54`: a late SubagentStart replaces a record that already has `endedAt`. Merge, keep `endedAt`.
- S16 (#18) `src/lib/context-backstop.ts:62-68,111-129`: delete the file-size/4 fallback; no `usage` line → `undefined`. Delete `estimateContextTokens` if then unused (spec `post-tool-use.spec.ts:177`).
- S17 (minor) `src/lib/state.ts:53-61,111-129`: `updateSessionState` must not overwrite a file that exists with a different `schemaVersion` (throw; caller is fail-open).
- S18 (minor) `src/lib/exploration-budget.ts:18`: legacy `mcp__plugin_odd-claude_codegraph__` alternative can never match (hook matcher is `mcp__codegraph__.*`); regex `/^mcp__codegraph__/`.
- S19 (minor) `src/hooks/session-start.ts:10` imports `recordTranscriptPath` from `../lib/transcript-path.js`, not `stats.js`.
- S20 (#20 part) Duplicates: one `truthy` (now in `lib/codegraph.ts:36`, `lib/session-integrations.ts:31`, `lib/skill-registry.ts:197`); `context-backstop.ts:25-39` `tail()` replaced by `readTail` from `lib/transcript-tail.ts`; `lib/lock.ts:27` `pidAlive` pass-through removed (import `isPidAlive`).

### CLI, TUI, docs (T4)
- S21 (#2) CLIs swallow errors and exit 0: `src/cli/coordinator.ts`, `codegraph-trust.ts`, `background-subagents.ts`, `review-mode.ts` (and every CLI with the same `try { if (isMain) main() } catch {}` block). Reproduced: `node dist/cli/coordinator.js --action on --data-dir rel/dir` prints nothing, exit 0. Only the isMain check may be guarded; a failing action prints to stderr and exits non-zero. One shared `runMain` + exported `CliResult` (in `src/lib/system.ts`) replaces the 6 copied blocks/interfaces.
- S22 (#3) `src/cli/setup.ts:95` default settings path and `src/lib/system.ts:33` `realInstalledPlugins` honour `CLAUDE_CONFIG_DIR` (`env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")`).
- S23 (#13) `src/cli/status.ts:15-25` reports hook events from `<config>/settings.json` commands running `dist/hooks/run.js` (same source as `realHooksInstalled`), not the payload template.
- S24 (#14) `claude-md/04-task-size.md:11` and `claude-md/03-protocol.md:12` small path: add "(Coordinator mode OFF; ON hands the write to one odd-worker)". Keep conformance specs green.
- S25 (#19) `tui/src/app.tsx:224-226`: step counter shown only while `stepNo <= total` (no "7/6").
- S26 (minor) `tui/src/services.ts:39-42`: delete the unreachable `uninstall` and default branches of `plan()`.
- S27 (minor) `src/cli/stats.ts:21-26`: `note` is "Transcript unreadable." only when the read failed.
- S28 (minor) `README.md:379` (repo root or package README, whichever has it): `~/.odd-claude/current/dist/cli/codegraph-trust.js` instead of `${CLAUDE_PLUGIN_ROOT}`.

### Review and MCP (T5)
- S29 (#7) `src/review/lineage.ts:16-22`: an unreadable lineage whose raw record matches the target is reported as unreadable; `status.ts:307-313` stops with `corrupted_or_unverifiable_authority`, `start.ts` refuses (`authority_error`), like `pendingCorrectionLineage` (`run.ts:296-301`). A truncated scan stays reported via `consumed.truncated` (not fail-closed, see L6). An already-acknowledged candidate keeps its terminal `target_already_acknowledged`. Test: corrupt lineage for the same target.
- S30 (#8) `src/review/runner.ts` (~439 spawn detached, ~473 timeout), `src/mcp/review-server.ts:111`: track live reviewer pids; on SIGTERM/SIGINT the server kills each process group (`process.kill(-pid, "SIGKILL")`) then exits.
- S31 (#20 part + minors) One exported StartTarget→SnapshotTarget mapping used by `start.ts:112-126`, `status.ts:99-107`, `run.ts:255-259`; delete alias `run.ts:313`. `src/review/consent.ts:219-225` `recordDecline` create-only (`linkSync`, EEXIST = exists) so first record wins. `src/mcp/tools.ts`: drop redundant try/catch (435-441), merge duplicate `risk.js` import (21,27), drop explicit `cwd` duplicated by `TARGET_PROPS` (405).

## Tasks
- T1 S2-S7 installer | route: odd-worker (parallel reason (a): 5 disjoint units) | Risk: item 1 (user config/state), item 4 (lock) | status: done, verified | commit: cb56ac3 | done when: `node --test dist-test/installer/*.spec.js` passes with new tests for S2-S7
- T2 S8-S12 update/release | route: odd-worker (parallel) | Risk: item 5 (release) | status: done, verified | commit: f9e2bf0 | done when: `node --test dist-test/installer/*.spec.js` passes; `node scripts/release-payload.mjs` without `--bundle` exits non-zero
- T3 S13-S20 hooks/lib | route: odd-worker (parallel) | Risk: item 1 (pruning stored files), item 4 | status: done, verified | commit: 9c25c28 | done when: `node --test dist-test/hooks/*.spec.js dist-test/lib/*.spec.js` passes with new tests
- T4 S21-S28 cli/tui/docs | route: odd-worker (parallel) | Risk: none (requested changes) | status: done | commit: cd67dc7 | done when: cli/lib/conformance specs and `tui npm test` pass; `coordinator.js --data-dir rel/dir` exits non-zero with stderr
- T5 S29-S31 review/mcp | route: odd-worker (parallel) | Risk: item 4 (signals, processes) | status: done, verified | commit: 4ba31a5 | done when: `node --test dist-test/review/*.spec.js dist-test/mcp/*.spec.js` passes with new tests
- T6 seam: parent `npm run build`, full `npm test`, tui test, one `odd-verify` over the high-risk units, work-unit commits | status: done | commit: (this doc) | done when: full suite green and every unit committed

## Log
- L1 2026-11-27 user: "Trabajemos en los 20 puntos mas + los 10 menores" (after the audit report in this session).
- L2 Parent offered to drop 4 minor items (install lock, recordDecline race, schema wipe, retired hooks); the user did not answer; all 30 kept as requested.
- L4 Workers T1-T5 returned completed with RED observed per behavior S# (T5 S29/S31 RED proven on a base-commit copy after one correction; T2 S10 corrected to `git status --porcelain -- dist` to catch untracked files). Accepted limits: S29 truncated scan stays reported via `consumed.truncated` (not fail-closed); S4 uninstall on corrupt state fails with a readable `odd-claude: settings state … is not valid JSON` exit 1.
- L5 Seam: `npm test` 1483 tests, 1481 pass, 0 fail, 1 skipped, 1 todo (pre-existing A1 limit); `tui npm test` 23/23; `npm run check` ok. T4 committed cd67dc7 (no high-risk item: requested changes). odd-verify launched for T1, T2, T3, T5.
- L6 Verify: T3 met 8/8 (+2 regression tests); T2 met 5/5 (+4 tests); T1 S5 blocker (builtin subset) fixed and re-verified by parent (RED 8/1 without the fix, GREEN 9/0); T5 S30/S31 met, S29 truncated-scan clause unmet. Decision: drop that clause: lineages are never pruned, so failing closed past MAX_LINEAGES (10,000) would block every review for that user forever; truncation stays reported. T5 correction: consumed check before the unreadable stop; a malformed existing decline file is replaced (first VALID record wins); verifier's 3 regression tests.
- L7 Close (T6 seam done): T5 correction applied (status ordering + malformed decline RED observed; 3 verifier tests added). Final seam on HEAD 4ba31a5: `npm test` 1497 tests, 1495 pass, 0 fail, 1 skipped, 1 todo (pre-existing); `tui npm test` 23/23; `git status --porcelain -- dist` empty after rebuild. Branch: 5 work-unit commits, 73 files +1092/-570 excluding dist (over 400 lines: slice per commit if published as a chain). Push/PR are the user's.
- L3 Decision: S14 prunes by age on SessionStart (not delete at SessionEnd) because `--resume` reuses the session id and `/odd-status` reads the latest session file.
