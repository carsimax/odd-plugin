# Native peers: retire odd-peers for native cross-session messaging, drop GitHub workflows
Objective: remove the odd-peers subsystem (MCP server, skill, hooks, CLI, libs) in favor of Claude Code's native cross-session messaging, migrate existing installs, delete `.github/workflows`, and document Layer 6. Branch: `feat/native-peers`. Delivery: work-unit commits on the branch; ff to main, tag and release stay the user's decision. Runner: `node:test` via `npm test` + `npm run check` inside `plugins/odd-claude`; installer tests use temp `HOME`/`CLAUDE_CONFIG_DIR`.

## Specs

### S1 User decisions (verbatim)
- Request: "Vamos con el Layer 6" (Layer 6 - Beyond the interactive terminal, `docs/claude-code-extensibility.md`).
- odd-peers: "Retirarlo, usar lo nativo (Recomendado)" — option text: "Quitar el servidor MCP odd-peers, el skill /odd-peers y su hook; el update lo desinstala. Las reglas apuntan a ListAgents/SendMessage nativos y documentan crossSessionInbound. Cambio que rompe compatibilidad (9.0.0), tarea grande con documento de tareas y commits."
- CI: "Eliminarlos" — option text: "Borrar .github/workflows y documentar el release manual como el proceso oficial."

### S2 Native facts (official docs, verified 2026-11-26)
- Cross-session messaging (https://code.claude.com/docs/en/cross-session-messaging.md): on by default since v2.1.224 (macOS/Linux/WSL 2; v2.1.234 native Windows). Tools `ListAgents`, `SendMessage` (cross-session), `notify_when_idle` (v2.1.236+). Each inbound message is delivered, held or refused; default depends on permission modes (a bypass-mode session holds messages for approval, expiring after `dialogExpiry`). Setting `crossSessionInbound`: `accept` | `hold` | `refuse`; `isolatePeerMachines`; deny rules on `SendMessage`/`ListAgents`. A peer message is never consent, cannot answer a permission prompt, and slash commands in it do not run. No per-sender allowlist.
- Agent teams: experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), not adopted. `/goal`, `/loop`/`CronCreate` local; `/schedule` cloud (research preview). Channels research preview (Bun). Headless: `--settings`, `--plugin-dir`, `--bare`, `--setting-sources`, `--mcp-config`; `CLAUDE_CONFIG_DIR` not confirmed in the docs (the bench relies on it).

### S3 Removal scope
Everything that exists only for odd-peers is removed: `src/mcp/peers-server.ts`, `src/mcp/peers-tools.ts`, `src/cli/peers.ts`, `src/lib/peers*.ts`, `src/lib/peer-grants.ts`, their specs/testkits, the `skills/odd-peers/` skill, the peers wiring in `src/hooks/` (SessionStart current-session record, SessionEnd mailbox cleanup, UserPromptSubmit `/odd-peers allow|revoke` grant, lazy mail delivery), and the matching `dist/` output. Shared code used by other features stays (keep `server-core.ts`, keep `session-id.ts` if anything else imports it). The session context no longer advertises peers.

### S4 Installer migration
- `odd-peers` is no longer registered (`claude mcp add`).
- install/update on a machine where the installer state recorded `odd-peers` as added by us removes it (`claude mcp remove -s user odd-peers`) and drops it from the state; a server named `odd-peers` we did not add is never touched (existing rule in `src/installer/mcp.ts`).
- The `peers/` directory under the odd-claude data dir is removed on install/update (state only, no user content).
- uninstall keeps working on old and new state files.

### S5 CI removal
Delete `.github/workflows/ci.yml` and `.github/workflows/release.yml`. The README documents the manual release as the official process (the steps used for 8.2.0–8.3.0: build with no tracked `dist` diff, `npm --prefix tui ci && npm --prefix tui run bundle`, `node scripts/release-payload.mjs --version <v> --out <dir> --bundle tui/dist/odd-claude.mjs`, `chore(release): <v> [skip ci]` commit, annotated tag, push, `gh release create v<v> --verify-tag --generate-notes` with the three assets). Tests that read the workflow files are updated or removed. `src/review/risk.ts` keeps its generic `.github/workflows` classification (it classifies user repositories).

### S6 Docs
- `plugins/odd-claude/README.md` and `docs/README.md`: peers sections replaced by native cross-session messaging (`ListAgents`/`SendMessage`, `crossSessionInbound`), migration note, manual release.
- `docs/claude-code-extensibility.md` (untracked by design): `### odd-claude today` under Layer 6 with S2 facts and the decisions.
- Rules/claude-md: any peers mention points to the native tools.

## Tasks
Delivery: `ask-on-risk`; forecast ~-3000 authored lines (mostly deletions) + ~300 added; one commit per task.
- T1 [S3] status: done. commit: 7915c58. route: delegated `odd-worker` (Coordinator mode ON; sequential: T1 and T2 both regenerate `dist/` via `npm test`) — remove the peers runtime. commit: pending. done when: `grep -rn "peers" plugins/odd-claude/src plugins/odd-claude/skills plugins/odd-claude/claude-md plugins/odd-claude/rules` shows only non-peer-subsystem hits, `npm test` and `npm run check` pass.
- T2 [S4] status: done. route: delegated `odd-worker` after T1 — installer migration. commit: bf71eb2 (committed before T1 so each commit is green). done when: installer specs cover no-register, remove-when-ours, never-touch-foreign, peers dir removal, and pass.
- T3 [S5, S6] status: done. commit: 15abbe7 (parent ran `git rm` on both workflow files; worker did docs and `bench/src/eval/eval.spec.ts:242`, 3 -> 2 `mcp add` calls). route: delegated `odd-worker` after T1/T2 (README is shared) — delete workflows, docs. done when: `.github/workflows` absent, no doc points to `/odd-peers` or `mcp__odd-peers__*` except the migration note, `npm test` passes.
- T4 status: done. route: parent — seam check + independent `odd-verify` + commits. done when: odd-verify returns S3–S6 met. Evidence in L5.
- T5 [S4] status: done. route: continue T2 `odd-worker` — blocker: state-recorded `odd-peers` already removed by hand fails forever; advisory: guard `peers/` rmSync. commit: cf44123. RED observed by the parent in a scratch copy (old `mcp.ts` + new spec: 3 fail — hand-removed, not-found, unremovable peers/); GREEN 46/46 in mcp + orchestrate specs; full suite 1435/1433 pass, 0 fail (worker). done when: the five regression tests from the verifier pass in `mcp.spec.ts`/`orchestrate.spec.ts` and `npm test` is green.
- T6 [S1, S5, S6] status: done (re-verify pending). commit: 4de2781 (rules + README; the Layer 6 bullet fix lives in the untracked extensibility doc). Rules total 23,950 bytes; npm test 1435/1433 pass, 0 fail (worker); parent spot-checked the bullet against `bench/src/eval/argv.ts:16-27`. route: continue T3 `odd-worker` after T5 — fix the Layer 6 bench bullet (bench passes only `-p … --settings`, `bench/src/eval/argv.ts:20-24`); add the native-tools line to the rules as the S1 option promised ("Las reglas apuntan a ListAgents/SendMessage nativos y documentan crossSessionInbound"); README release steps gain the bump step and the correct cwd. commit: pending. done when: `npm test` green (rules byte cap) and the grep for `ListAgents` and `crossSessionInbound` hits the rules. route: parent — seam check (full suite), independent `odd-verify` (Risk: item 3 public MCP/skill removal; item 5 installer + CI), commits.

## Log
- L1 (verbatim): "Vamos con el Layer 6"
- L2: user chose "Retirarlo, usar lo nativo (Recomendado)" and "Eliminarlos" (S1).
- L3: CI jobs never started since v6: "The job was not started because recent account payments have failed or your spending limit needs to be increased."
- L4: T1 done. odd-worker removed peers wiring in hooks/claude-md; worker rules forbid file deletion, so the parent ran `git rm` on 18 src/spec/skill + 8 dist files. npm test 1523 -> 1420 tests, 1417 pass, 1 fail (`installer/mcp.spec.ts` planMcp expects peers-server.js, T2 scope); npm run check ok; grep peers outside installer: 0 hits.
- L5: odd-verify pass 1 (HEAD 15abbe7): S3 met, S5 met; S4 blocker (hand-removed odd-peers warned forever), S6 blocker (Layer 6 bench bullet claimed --plugin-dir/--mcp-config), S1 option text not met (rules lacked native tools). One correction batch: T5 cf44123, T6 4de2781. Re-verify limited to blockers (HEAD 4de2781): all three met; mcp/orchestrate/rules-cap specs 55/55; dist equals a fresh build. Parent checked the real CLI not-found text: `claude mcp remove -s user <absent>` prints `No MCP server named "<absent>" in user scope`, matched by the fallback. Full suite 1435 tests, 1433 pass, 0 fail; bench 239 (207 pass, 32 skipped); npm run check ok.
