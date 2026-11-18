# v0.1 skeleton: installable odd-claude plugin (Phase 1)
Goal: an installable `odd-claude` plugin that loads, declares Engram, and can diagnose and configure itself. Branch: `feat/v0.1-skeleton`.
Runner: `node:test` via `npm test` inside `plugins/odd-claude` + `claude plugin validate` / `claude plugin test`.

## Specs

### S1 Roadmap Phase 1 (docs/roadmap.md, "### Phase 1: Skeleton, setup, doctor, engram dependency")

- **Goal:** an installable `odd-claude` plugin that loads, declares Engram, and can diagnose and configure itself.
- **Deliverables:** `.claude-plugin/plugin.json` (+ marketplace entry), `dependencies` on `engram@engram`, `${CLAUDE_PLUGIN_ROOT}` layout (`cards/`, `agents/`, `skills/`, `hooks/`, `bin/`), `/odd-claude:doctor`, `/odd-claude:status` (R38), `/odd-claude:setup` (opt-in settings writer: statusLine, `defaultMode`; the persona does not need it: forced output style per Q2), hooks scaffolding with shared state-file helper.
- **Exit criteria:** `claude plugin validate` passes; `claude plugin test` passes; `/odd-claude:doctor` reports engram/codegraph/git presence and exits with the missing items listed; `/odd-claude:setup` shows a diff and writes nothing without confirmation (tested with a declined run and an accepted run on a temp settings file).

### S2 Layout decision (user answer, 2026-11-18)

Answer: "Marketplace en raíz + plugins/odd-claude/ (Rec.)"
Option text: "La raíz tiene .claude-plugin/marketplace.json y el plugin vive en plugins/odd-claude/. Instalas con /plugin marketplace add <repo> y después pueden convivir otros plugins."

### S3 Runtime decision (user answer, 2026-11-18)

Answer: "Node + TypeScript compilado (Recomendado)"
Option text: "Permite portar la lógica TS del upstream casi tal cual y es el mismo lenguaje que los mods. Se versiona un build a JS para no depender de un tsc local, que en tu máquina hoy está roto. Requiere Node ≥ 20."

### S4 Project decisions (user, verbatim)

- "El proyecto se llamara odd-claude no gentle-ai o gentle-shell"
- "ignora completamente otros proyectos como gentle-py tomaremos todo 100% del upstream de este repo"
- "no usaremos nada de prefijo gentle- o gentle-ai todo sera odd-claude nuestro plugin entonces el prefijo sera odd"
- "y sin nada de telemetria"

### S5 Delivery conventions (docs/roadmap.md, "## Delivery conventions")

- **Work-unit commits:** one reviewable unit per commit, about 400 lines of change at most, with its tests and docs together (skill `work-unit-commits`).
- **Tests with behaviour:** behaviour changes ship with tests written first where a deterministic runner applies; guards reuse upstream tests adapted to Node (A58). Docs-only changes state the exception.
- **Checks on every change:** `claude plugin validate` and `claude plugin test` must pass, plus the focused tests of the touched unit.
- **Naming and telemetry checks:** no `gentle-` identifiers we name (attributed notices excepted) and no telemetry code, enforced by grep in checks.

## Tasks

- T1 | S1,S2,S3,S4,S5 | writer | done (commit: 6bfb797) — Scaffold: root `.claude-plugin/marketplace.json` (plugin source `./plugins/odd-claude`, cross-marketplace dependency allowance for engram), `plugins/odd-claude/.claude-plugin/plugin.json` (name `odd-claude`, version `0.1.0`, engines `claude-code`, dependencies `engram@engram`), Node+TS build (`package.json`, `tsconfig`, `src/` → committed `dist/`), `npm test` with `node:test`, naming/telemetry grep check script; `claude plugin validate` passes.
- T2 | S1,S5 | writer | done (commit: 9fcf00e) — Hooks scaffolding + shared state-file helper under `${CLAUDE_PLUGIN_DATA}`, with tests.
- T3 | S1 | writer | done-pending-commit (commit: pending) — `/odd-claude:doctor` (port upstream R38 doctor semantics): reports engram/codegraph/git presence and lists missing items; tests.
- T4 | S1 | writer | done-pending-commit (commit: pending) — `/odd-claude:status` (port upstream R38 status semantics); tests.
- T5 | S1 | writer (own commit, independent verify: writes user settings) | pending — `/odd-claude:setup`: opt-in settings writer (statusLine, `defaultMode`) that shows a diff and writes nothing without confirmation; idempotent, reversible, write scope limited to listed keys; tested with a declined run and an accepted run on a temp settings file.
- T6 | S1,S5 | writer | pending — Plugin README/install docs, `claude plugin test` green, roadmap Status row Phase 1 updated.

## Log

- L1: user's original request: "3. si vemos con 0.1" (in reply to "¿Arrancamos v0.1 (el esqueleto instalable) como primera feature ODD?").
- L2: "2. dejemos para la v2" (conflict-marker gate stays v2 with R32).
- L3: 2026-11-18: decisions S2 (layout) and S3 (runtime) taken by the user.
- L4: T1 scaffold done (uncommitted), covers S1 (manifest, marketplace entry, `dependencies: ["engram@engram"]`), S2 (root marketplace + `plugins/odd-claude/`), S3 (Node+TS, committed `dist/`, shipped dist excludes tests; tests build to git-ignored `dist-test/`), S4/S5 (`scripts/check-naming.mjs` via `npm run check`, tested by `check-naming.test.ts`). Evidence: RED `tsc` TS2307 missing `./version.js`, then GREEN `npm test` 6 pass/0 fail; `npm run check` ok; `claude plugin validate plugins/odd-claude` and `claude plugin validate .` pass with warnings only (name reads as Anthropic's own: user-mandated name; README missing and icon missing are T6; no unknown-field warning for `allowCrossMarketplaceDependenciesOn`). `claude -p --plugin-dir` loaded (result `OK`); engram was already installed locally so it resolved from the existing cache, fresh resolution not proven. `claude plugin test` not run (no mod yet).
- 2026-11-18 T2 (S1,S5): `hooks/hooks.json` registers only SessionStart (the one event v0.1 needs to prove the pipeline; guards/context add events later) -> `node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/run.js" SessionStart`. `src/hooks/run.ts` (`runHook` dispatch, fail-safe exit 0, errors to `<data>/logs/hooks.log`, unknown event no-op), `src/hooks/session-start.ts` (records `startedAt`/`source`, no output), `src/lib/state.ts` (CLAUDE_PLUGIN_DATA or explicit `dataDir`, `sessions/<id>.json`, schema `version: 1`, atomic temp+rename, sanitized session id). Upstream had no reusable state-file code (only ad hoc atomic writes in agent-assets/agent-profiles), so nothing was ported. RED: `npm test` failed to compile (missing `./run.js`, `./state.js`). GREEN: `npm test` 23 pass / 0 fail; `npm run build` ok; `npm run check` ok; `claude plugin validate plugins/odd-claude` passed with warnings (README not found; T6). E2E `claude -p --model haiku --plugin-dir plugins/odd-claude "reply OK"` returned OK and wrote `~/.claude/plugins/data/odd-claude-inline/sessions/845dda10-755b-40de-ba54-4286b19a646e.json` (`{version:1, sessionId, data:{startedAt, source:"startup"}}`), confirming `${CLAUDE_PLUGIN_ROOT}` expansion and that `--plugin-dir` uses the `<name>-inline` data dir.
- 2026-11-18 delivery slice boundary: slice 1 = 6bfb797..9fcf00e (796 authored lines, past ~400); remaining v0.1 tasks continue on the same branch as slice 2.
- 2026-11-18 T3+T4 (S1,S4,S5): ported the R38 semantics of upstream `/doctor` and `/status` (upstream treats Engram as a `warn`, never a failure; pass/warn/fail lines with remedies; status lists package state) adapted to Claude Code; dropped dev-binary, launcher, model-config and herdr parts, no telemetry, odd names only. Pure logic in `src/lib/doctor.ts` and `src/lib/status.ts` with injected exec/env/fs; real probes in `src/lib/system.ts`; CLIs `dist/cli/doctor.js [--json] [--data-dir]` and `dist/cli/status.js [--json] [--session] [--data-dir]`; `listSessionIds` added to `state.ts`; skills `skills/doctor` and `skills/status` (`disable-model-invocation: true`). Required: node >=20, git (doctor CLI exits 1 when missing; the skill appends `|| true`). Optional: engram (binary on PATH or `engram@*` in `~/.claude/plugins/installed_plugins.json`), codegraph, plugin version, data dir writable (checked read-only via access, no probe file). Variable findings: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_SESSION_ID}` and `${CLAUDE_PLUGIN_DATA}` ARE expanded inside skill `` !`cmd` `` commands, but `CLAUDE_PLUGIN_DATA` is NOT in the injected command's environment, so the skills pass it as `--data-dir "${CLAUDE_PLUGIN_DATA}"`; no `bin/` helper was needed. RED: `npm test` failed to compile (missing `./doctor.js`, `./status.js`, `listSessionIds`). GREEN: `npm test` 39 pass / 0 fail; `npm run build` ok; `npm run check` ok; `claude plugin validate plugins/odd-claude` passes with warnings only (README missing, icon missing: T6; name warning), listing `odd-claude:doctor` and `odd-claude:status`. E2E `claude -p --model haiku --plugin-dir plugins/odd-claude "/odd-claude:doctor"` returned the injected table (`engram optional ok binary 3.7.0, plugin engram@engram`, `data dir optional ok /Users/carsimax/.claude/plugins/data/odd-claude-inline`, `missing: none`); `/odd-claude:status` returned `session: 1fbbc303-... (flag) startedAt="2026-11-18T17:01:05.201Z" source="startup"`, `hooks: SessionStart`, `roadmap: Phase 1: ...`. `claude plugin test` not run (no mod yet).
