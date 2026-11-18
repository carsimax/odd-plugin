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

## Tasks

- T0 | S5 | writer | pending-commit — Harden v0.2 integrations per S5 (warm-up opt-in/trust, registry off the critical path or bounded, warm-up lock/dedupe).
- T1 | S1 | writer, high risk | pending-commit — Bash guard (R21) + child guard (R23): PreToolUse Bash destructive-command policy ported from upstream lib/destructive-command-guard.ts, ask/deny, subagent-stricter by agent_type.
- T2 | S1 | writer, high risk | pending-commit — Sensitive-path guard (R22) for Read/Edit/Write/MultiEdit/NotebookEdit/Grep/Glob/Bash, main thread and subagents.
- T3 | S1 | writer, high risk | pending-commit — Agent admission: writer (R26), verifier (R27), JD fix dispatch (R28) + digest helper in bin/.
- T4 | S1,S4 | writer, high risk | pending-commit — Coordinator mode (A15/A16) ON by default: PreToolUse deny Edit/Write/MultiEdit/NotebookEdit in the main thread, allowed in odd-worker/odd-jd-fix; `/odd-claude:coordinator on|off|status`; card.
- T5 | S1 | writer | pending-commit — Permission modes mapping (R20, R24, R25): native default/auto/bypassPermissions, verify hooks stay active in bypassPermissions, docs.
- T6 | S1 | writer | pending-commit — Exploration budget (R14) + context backstop (R34) via PostToolUse additionalContext.
- T7 | S1,S3 | writer | pending-commit — Exit-criteria E2E, loop-safety check, README, roadmap Status Phase 3, `claude plugin test` status.

## Log

- L1: user's original request: "ok sigamos" (reply to "¿Arranco?" for Phase 3 guards).
- L2: coordinator default decision (S4), 2026-11-18.
- L3: v0.2 merged to main at 7b4fc32.
