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
- T1 [S3] status: done (commit pending, lands with T2 to keep the suite green). route: delegated `odd-worker` (Coordinator mode ON; sequential: T1 and T2 both regenerate `dist/` via `npm test`) — remove the peers runtime. commit: pending. done when: `grep -rn "peers" plugins/odd-claude/src plugins/odd-claude/skills plugins/odd-claude/claude-md plugins/odd-claude/rules` shows only non-peer-subsystem hits, `npm test` and `npm run check` pass.
- T2 [S4] status: in_progress. route: delegated `odd-worker` after T1 — installer migration. commit: pending. done when: installer specs cover no-register, remove-when-ours, never-touch-foreign, peers dir removal, and pass.
- T3 [S5, S6] status: pending. route: delegated `odd-worker` after T1/T2 (README is shared) — delete workflows, docs. commit: pending. done when: `.github/workflows` absent, no doc points to `/odd-peers` or `mcp__odd-peers__*` except the migration note, `npm test` passes.
- T4 status: pending. route: parent — seam check (full suite), independent `odd-verify` (Risk: item 3 public MCP/skill removal; item 5 installer + CI), commits.

## Log
- L1 (verbatim): "Vamos con el Layer 6"
- L2: user chose "Retirarlo, usar lo nativo (Recomendado)" and "Eliminarlos" (S1).
- L3: CI jobs never started since v6: "The job was not started because recent account payments have failed or your spending limit needs to be increased."
- L4: T1 done. odd-worker removed peers wiring in hooks/claude-md; worker rules forbid file deletion, so the parent ran `git rm` on 18 src/spec/skill + 8 dist files. npm test 1523 -> 1420 tests, 1417 pass, 1 fail (`installer/mcp.spec.ts` planMcp expects peers-server.js, T2 scope); npm run check ok; grep peers outside installer: 0 hits.
