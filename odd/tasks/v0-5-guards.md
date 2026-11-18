# v0.5 guards: enforcement hooks and coordinator mode (Phase 3)
Goal: enforce destructive-command, sensitive-path, child-safety, writer/verifier admission and JD dispatch through plugin hooks, plus coordinator mode ON by default. Branch: `feat/v0.5-guards`.
Runner: `node:test` via `npm test` inside `plugins/odd-claude` + `claude plugin validate` / `claude plugin test`. Risk: HIGH, security-sensitive; every task touching hooks gets its own commit and independent `odd-verify` / `gentle-ai-verify`.

## Specs

### S1 Roadmap Phase 3 (docs/roadmap.md, "### Phase 3: Guards")

- **Goal:** enforcement of destructive-command, sensitive-path, child-safety, writer/verifier admission and JD dispatch through plugin hooks, plus coordinator mode.
- **Matrix IDs:** R14, R20, R21, R22, R23, R24, R25, R26, R27, R28, R34, A15, A16, A58
- **Deliverables:** hooks `odd-bash-guard` (R21), `odd-path-guard` (R22), `odd-child-guard` (R23), `odd-writer-admission` (R26), `odd-verifier-admission` (R27), `odd-jd-dispatch` (R28) with digest helper in `bin/`, `odd-explore-budget` (R14), `odd-context-backstop` (R34); coordinator mode (A15, A16: PreToolUse deny `Edit|Write|MultiEdit|NotebookEdit` in the main thread); permission-mode mapping to native `default`/`auto`/`bypassPermissions` with `defaultMode` through setup (R20, R24, R25); upstream pure-TS logic ported as-is; tests adapted from upstream to Node test runner (A58).
- **Dependencies / gates:** Phase 2 (agent names), Q3 (answered: hooks fire in subagents; guards target subagents by `agent_type` `odd-claude:<agent>`); also verify whether hooks stay active in `bypassPermissions` (R25).
- **Exit criteria:** adapted upstream tests for R21–R28 pass; destructive `Bash` fixtures return `ask`/`deny`; sensitive-path reads/writes are denied for the main thread and for subagents (Q3 outcome); a writer `Agent` call without `## Allowed edit surfaces` is denied; a JD fix dispatch with a bad section order or a wrong SHA-256 is denied; coordinator mode denies main-thread Edit/Write and allows them in `odd-worker`; Stop/PreToolUse hooks cannot loop; `claude plugin test` passes.
- **Risk:** **HIGH, security-sensitive.** Guards are the only enforcement point (plugins cannot ship `permissions.deny`); a hook error or timeout must fail safe for destructive/sensitive paths; bypass-mode behaviour is still unverified (subagent hooks confirmed by Q3). A16 is generated from A15 and moves with it. Candidate for independent verification (`odd-verify`) per unit.

### S2 Project decisions (user, verbatim)

- "El proyecto se llamara odd-claude no gentle-ai o gentle-shell"
- "ignora completamente otros proyectos como gentle-py tomaremos todo 100% del upstream de este repo"
- "no usaremos nada de prefijo gentle- o gentle-ai todo sera odd-claude nuestro plugin entonces el prefijo sera odd"
- "y sin nada de telemetria"

### S3 Delivery conventions (docs/roadmap.md, "## Delivery conventions")

- **Feature docs:** one per feature at `odd/tasks/<feature>.md` in the A54 format (header, `## Specs` `S#`, `## Tasks` `T#`, `## Delivery`, `## Risks`, `## Log` `L#`). Upstream's 230 task docs are not copied.
- **Work-unit commits:** one reviewable unit per commit, about 400 lines of change at most, with its tests and docs together (skill `work-unit-commits`).
- **Tests with behaviour:** behaviour changes ship with tests written first where a deterministic runner applies; guards reuse upstream tests adapted to Node (A58). Docs-only changes state the exception.
- **Checks on every change:** `claude plugin validate` and `claude plugin test` must pass, plus the focused tests of the touched unit.
- **Naming and telemetry checks:** no `gentle-` identifiers we name (attributed notices excepted) and no telemetry code, enforced by grep in checks.
- **Spikes:** results written to `docs/research/open-questions.md` with evidence before dependent work starts.
- **High-risk phase (3):** independent verification per unit; guards fail safe. Phase 4 is advisory and low-medium risk.

### S4 User decision (verbatim)

- Question: "Coordinator mode (full delegation): el hilo principal no edita y todo cambio va a un odd-worker. ¿Cómo arranca por defecto en odd-claude?"
- Answer: "Encendido por defecto"
- Option text: "Delegación total desde la instalación: el hook bloquea Edit/Write en el hilo principal. Es más estricto y cuesta más tokens en tareas pequeñas."

### S5 Native-review advisory findings carried over from v0.2 (verbatim)

- R1-001: "The SessionStart warm-up decides to run `codegraph sync` purely from the presence of a `.codegraph/` directory in the session cwd, which is repository-controlled content. Opening any cloned repository that commits a `.codegraph/` directory makes the hook spawn a detached `codegraph` process (up to 60 s) against that repository without an explicit user opt-in; only the env opt-out `ODD_CLAUDE_NO_CODEGRAPH_WARMUP` prevents it. Impact is bounded (the user's own binary on PATH, arguments limited to `sync <cwd>` via spawnSync with an argument array, no shell, stdio ignored), so this is a hardening note rather than an exploitable defect."
- R4-sync-registry-on-hook-path: "The skill-registry refresh runs synchronously inside the SessionStart hook. Each start walks nine project dirs, three user dirs and every installed plugin's skills dir, stats every SKILL.md, and runs `git ls-files` with a 3000 ms timeout. A hung or slow git (for example a lock or a network filesystem) can delay session start by up to 3s on each start, even though the code comments say nothing here may slow session start. No latency measurement was given to rule it out."
- R4-warmup-no-dedupe: "Every SessionStart event (startup, resume, clear, compact) on an indexed project spawns a new detached `codegraph sync` process (up to a 60s bound, 300s for init) with no lock, pid file or in-flight check. Repeated /clear or compact events, or several sessions in the same project, can run overlapping syncs against the same `.codegraph` index. This risks contention or redundant CPU load, and nothing records that a previous warm-up is still running."

### S6 User decisions, no deny (user, verbatim, 2026-11-18)

- Message: "Por cierto se me olvido mencionar no quiero el tema del deny, se que es riesgoso pero así lo requiero que dejemos permisible el bloque de denegaciones que tiene originalmente gentle-shell"
- Question: "¿Qué hacemos con los comandos que hoy se deniegan (rm -rf /, git reset --hard, etc.)?" Answer: "Quitar el guard: todo permitido"
- Question: "¿Aplica también a los subagentes (child guard), que hoy niegan todo lo destructivo sin override?" Answer: "Sí, mismo criterio que el hilo principal"
- Question: "¿Y el guard de rutas sensibles (T2: secretos, .env, .ssh, keychains)?" Answer: "Igual: sin deny"
- Question: "Quedan otros dos mecanismos de la Fase 3 que también responden 'deny', aunque no por seguridad del sistema sino por disciplina ODD. ¿Los mantenemos?" Answer: "Ninguno: ni T3 ni T4". Option text: "Cero deny en el plugin. Admisión y coordinator quedan solo como reglas de texto en el prompt."
- Effect: the plugin contains no hook that returns deny/ask/block. T1, T2, T3 are dropped; T4 keeps coordinator mode only as prompt text; the S1 deliverables and exit criteria that require deny/ask/block are superseded by this decision (S1 text is kept unchanged as the original roadmap record).

## Tasks

- T0 | S5 | writer | done (fcd0ec8, fb5bf55) — Harden v0.2 integrations per S5 (warm-up opt-in/trust, registry off the critical path or bounded, warm-up lock/dedupe).
- T1 | S1 | writer, high risk | dropped (user decision; built in 8473945, reverted by d15cb6b) — Bash guard (R21) + child guard (R23): PreToolUse Bash destructive-command policy ported from upstream lib/destructive-command-guard.ts, ask/deny, subagent-stricter by agent_type.
- T2 | S1 | writer, high risk | dropped (user decision) — Sensitive-path guard (R22) for Read/Edit/Write/MultiEdit/NotebookEdit/Grep/Glob/Bash, main thread and subagents.
- T3 | S1 | writer, high risk | dropped (user decision) — Agent admission: writer (R26), verifier (R27), JD fix dispatch (R28) + digest helper in bin/.
- T4 | S1,S4,S6 | writer, high risk | done (d17995c, independently verified: S4/S6 met) — Coordinator mode (A15/A16) as a prompt mode, ON by default, with no deny hook: `/odd-claude:coordinator on|off|status` (skill + CLI) stores the delegation mode in plugin state; SessionStart context states the active mode and points to `cards/full-delegation.md`; admission rules (R26/R27/R28) stay as text in cards and the judgment-day skill, never enforced.
- T5 | S1,S6 | writer | done (d17995c, independently verified: S6 met; advisory A1 closed in T7) — Permission modes mapping (R20, R24, R25): upstream normal/auto/yolo/super-yolo to native default/auto/acceptEdits/bypassPermissions, `bypassPermissions` added to `/odd-claude:setup` with an explicit warning in the dry run, README mapping and risk note; hooks observed active in bypassPermissions (Q3 spike evidence; the T1 E2E was reverted).
- T6 | S1 | writer | done (813df63) — Exploration budget (R14) + context backstop (R34) via PostToolUse additionalContext.
- T7 | S1,S3,S6 | writer | done-pending-commit — Exit-criteria E2E, loop-safety check, README, roadmap Status Phase 3, `claude plugin test` status.

## Delivery

- Commits on `feat/v0.5-guards`: T0 `fcd0ec8` + `fb5bf55`; T1 `8473945` reverted by `d15cb6b` (S6); T4+T5 `d17995c`; T6 `813df63`; T7 pending commit. T2 and T3 were never built (dropped, S6).
- Slice note: 6+ commits and about 2400 authored lines (non-reverted insertions: 852 + 211 + 561 + 699 = 2323, plus T7), above the ~400-line unit guideline of S3; the overshoot comes from T0/T6 volume and from the T1 build and revert, which was a user-decision reversal and not a split failure.
- Verification: T4+T5 independently verified (S4/S6 met). Advisory A1 (README and `modeWarning` cited an E2E that lived in the reverted commit) closed in T7 by citing the Q3 spike. T0, T6 and T7 verified by the writer's own checks only.

## Risks

- By decision S6 nothing in odd-claude blocks destructive or sensitive actions; `bypassPermissions` (offered via setup, with an explicit warning) removes every prompt. Other installed plugins or user hooks may still act; odd-claude does not rely on them.

## Log

- L1: user's original request: "ok sigamos" (reply to "¿Arranco?" for Phase 3 guards).
- L2: coordinator default decision (S4), 2026-11-18.
- L3: v0.2 merged to main at 7b4fc32.
- L4: user decision S6 (no deny anywhere), 2026-11-18. The T1 bash guard (commit 8473945) was reverted in d15cb6b; T1, T2, T3 dropped; T4 rewritten to prompt-only coordinator mode; T5 now adds `bypassPermissions` to setup with a warning.
- L5: T4/T5 implemented (not committed): coordinator CLI + skill + card, context default ON, setup `bypassPermissions`, README mapping. A grep for a deny decision or `permissionDecision` over `src` and `hooks` returns nothing, and hooks.json registers only SessionStart and UserPromptSubmit.
- L6: 2026-11-18 T7 covers S1 (as amended by S6), S3 and S6; no linked S# left unsatisfied. A1: surviving evidence for "hooks active in bypassPermissions": `spikes/03-subagent-hooks/hook-log.jsonl` (local, untracked) has `permission_mode: bypassPermissions` on a `PreToolUse` for the main-thread `Agent` call and for the subagent `Write` (`agent_type` `odd-subhook:odd-probe`), documented in `docs/research/open-questions.md` Q3 (Claude Code 2.1.326). No re-run was needed. README and `modeWarning` now cite it and say it gives no protection (odd-claude has no blocking hook).
- L7: Regression tests added (all passed on current code, no code fix needed): setup symlink + 0600 + backups + WARNING, four near-miss invalid modes with exact stderr, corrupt `delegation.json` (`{garbage` reads `on (default)`, `--action ON` exit 1, sha256 unchanged), run.js emits `{exitCode:0, stdout:""}` for PreToolUse/Stop/SubagentStop/PostToolUse with a destructive Bash input.
- L8: `npm test` now runs `clean:test` first (`node -e "require('fs').rmSync('dist-test',{recursive:true,force:true})"`). Proof: a dummy `dist-test/stale.test.js` that throws exits 1 alone; `npm test` then exits green (188 tests, 188 pass, 0 fail) and the file is gone.
- L9: Exit criteria: `npm run check` -> `check-naming: ok`. `claude plugin validate plugins/odd-claude` -> passed with 2 warnings (plugin name reads as Anthropic's own; no icon). `grep -rn 'permissionDecision\|"deny"\|decision.*block' plugins/odd-claude/src plugins/odd-claude/dist plugins/odd-claude/hooks --exclude=*.test.*` -> no matches (exit 1). `hooks.json` events: SessionStart, UserPromptSubmit, PostToolUse (no Stop, no PreToolUse), so hooks cannot loop. `claude plugin test plugins/odd-claude` -> `no hooks module to load; hooks/hooks.json names none in "modules"` (expected, no mods).
- L10: E2E fresh session (`claude -p --model haiku --plugin-dir plugins/odd-claude --permission-mode bypassPermissions --output-format stream-json --verbose --include-hook-events`, cwd a temp dir): the model answered "Coordinator mode is ON (full delegation)" from the SessionStart context; `rm -r <tmp>/victim` ran, exit 0, and the directory was gone. Stream: every PreToolUse/Stop hook response had exit 0 and empty or `{}` stdout; the only `decision` fields were Claude Code's own `permission_decision: accept` by mode. Loaded plugins in that environment: odd-claude, orca-agent-view, engram, cc-plugin-sec-default; the PreToolUse and Stop hooks seen come from those other plugins or user config, since odd-claude registers neither. A host-level Gentle AI policy hook did block a later shell `rm` of my scratch files in the writer session, which is the environment and not odd-claude.
- L11: Docs: `docs/roadmap.md` Phase 3 section, Milestones v0.5 row and Status row updated (IDs R21, R22, R23, R26, R27, R28 kept and marked dropped by user decision 2026-11-18); `docs/README.md` Decisions gained items 4 and 5.
- L12: Scratch left behind outside the worktree (removal blocked by the host policy): `/tmp/odd-e2e.jsonl`, `/tmp/odd-e2e.err`, and the empty temp dir `/var/folders/3f/3v9dql657451v90kmmjx7nwr0000gn/T/tmp.otMOupxrZx`.
- L13: Independent verification of 1f87528: S6 met. Findings fixed in branch `fix/v0.5-verify-findings`: F1 parallel PostToolUse calls broke "one notice per turn" and undercounted (`updateSessionState` read-modify-write raced); it now runs under a short cross-process lock (`<session>.json.lock`, `lock.ts` semantics, ~1 s bounded spin, fails open on timeout) and the context backstop decides inside the same locked update, so 10 parallel calls give 1 notice and lookups 10. F2 a FIFO `transcript_path` hung `openSync`; non-regular files are now ignored. F3 this document's structure repaired (S3 bullets contiguous, single `## Log` last, entries merged and renumbered L1..Ln, no entry text lost). Covers S1, S6 (T6 follow-up) and S3 (F3).
- L14: Re-verification of d67bc80: F2, F3, S6 pass; F1 still MAJOR. Root cause: `acquireLock` created the lock with `wx` and wrote the content afterwards, so a concurrent reader saw an empty lock, treated it as stale and took it over (two owners, lost counts, orphan `.done-<pid>` markers). Fix in `src/lib/lock.ts` (shared with the codegraph/registry launch locks, their tests stay green): the lock is created atomically with content (unique temp file + `linkSync`, EEXIST means held); an unreadable or empty lock is stale only when its mtime is older than `staleMs`; `setLockPid` replaces the lock via rename; session-state locks use the new marker-free `releaseOwnedLock`. The `.done-<pid>` handoff marker stays only for the launch locks (M2: a child finishing before handoff leaves no lock). `UserPromptSubmit` retries the per-turn reset once on a lock timeout before logging. Tests: empty fresh lock times out within 1.5 s without calling the callback; same lock older than 2 s is acquired; 10 parallel spawns x 20 rounds give 1 notice, lookups 10 and no leftover lock/marker/tmp files. Covers S1, S6.
