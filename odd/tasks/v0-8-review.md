# v0.8 advisory review: lens agents and 4r-review (Phase 4)
Goal: v1 independent review with agents and skills, advisory only: the four lenses plus the existing Judgment Day. Branch: `feat/v0.8-review`.
Runner: `node:test` via `npm test` inside `plugins/odd-claude` + `claude plugin validate`.

## Specs

### S1 Roadmap Phase 4 (docs/roadmap.md, "### Phase 4: Advisory review (agent-based)")

- **Goal:** v1 independent review with agents and skills, advisory only, as decided in Q4: the four lenses plus Judgment Day. No external binary and no native lineage/consent/capture tools.
- **Matrix IDs:** A07, A08, A09, A10, A11
- **Deliverables:** agents `odd-review-risk`, `odd-review-resilience`, `odd-review-readability`, `odd-review-reliability` (A07–A10) with `Read, Grep, Glob` and the candidate change passed in the prompt (no `odd_review_scope`); `4r-review` command/skill (A11) that launches the four lenses via `Agent` and merges their findings into one advisory report; Judgment Day agents and skill come from Phase 2 and guard dispatch from Phase 3 (A01–A06, R28); the review output states it is advisory and gates nothing.
- **Dependencies / gates:** Phases 1–3; Q3 (answered; reviewers are isolated subagents), Q6 (answered).
- **Exit criteria:** `4r-review` on a sample change runs four reviewers and returns a merged advisory report; each lens agent lists under `odd-claude:`; reviewers cannot write (`tools` allowlist excludes Edit/Write, verified by a guard test); a Judgment Day round still runs on the same sample; no external binary or `odd_review*` tool is referenced by any shipped file.

### S2 Project decisions (user, verbatim)

- "El proyecto se llamara odd-claude no gentle-ai o gentle-shell"
- "ignora completamente otros proyectos como gentle-py tomaremos todo 100% del upstream de este repo"
- "no usaremos nada de prefijo gentle- o gentle-ai todo sera odd-claude nuestro plugin entonces el prefijo sera odd"
- "y sin nada de telemetria"
- Message: "Por cierto se me olvido mencionar no quiero el tema del deny, se que es riesgoso pero así lo requiero que dejemos permisible el bloque de denegaciones que tiene originalmente gentle-shell"
- Question: "¿Qué hacemos con los comandos que hoy se deniegan (rm -rf /, git reset --hard, etc.)?" Answer: "Quitar el guard: todo permitido"
- Question: "¿Aplica también a los subagentes (child guard), que hoy niegan todo lo destructivo sin override?" Answer: "Sí, mismo criterio que el hilo principal"
- Question: "¿Y el guard de rutas sensibles (T2: secretos, .env, .ssh, keychains)?" Answer: "Igual: sin deny"
- Question: "Quedan otros dos mecanismos de la Fase 3 que también responden 'deny', aunque no por seguridad del sistema sino por disciplina ODD. ¿Los mantenemos?" Answer: "Ninguno: ni T3 ni T4". Option text: "Cero deny en el plugin. Admisión y coordinator quedan solo como reglas de texto en el prompt."
- Effect: the plugin contains no hook that returns deny/ask/block (v0.5 S6, kept as a project decision; `src/lib/no-deny.test.ts`).

## Tasks

- T1 | S1,S2 | writer | done-pending-commit — Lens agents A07–A10 → `agents/odd-review-{risk,resilience,readability,reliability}.md` (tools `Read, Grep, Glob` + codegraph both names; `disallowedTools: Edit, Write, NotebookEdit, Bash`; change passed in the prompt), skill `4r-review` (A11, `/odd-claude:4r-review [git range]`) with safe `!` snapshot, parallel `Agent` launch and merged advisory report, guard test `src/lib/agents-guard.test.ts`, NOTICE attribution.
- T2 | S1 | writer | done-pending-commit — Exit-criteria E2E (4r-review on a sample change, Judgment Day round on the same sample, `claude plugin validate` listing), plugin README advisory review section, roadmap Status Phase 4.

## Log

- L1: user's original request: "ok" (reply to "Siguiente: Fase 4 (v0.8): review advisory con los 4 agentes de lente y su skill. ¿Sigo?").
- L2: 2026-11-18 T1/T2 cover S1 and S2; no linked S# left unsatisfied. Test-first: `agents-guard.test.ts` written first; RED run of `npm test` failed with ENOENT on `agents/odd-review-reliability.md` and "skills/4r-review/SKILL.md missing"; GREEN after the agents and skill: `npm test` 212 tests, 212 pass, 0 fail.
- L3: Checks: `npm run check` -> `check-naming: ok`; `claude plugin validate plugins/odd-claude` -> passed with 1 warning (no icon), lists `skills: odd-claude:4r-review` and `agents: odd-claude:odd-review-{readability,reliability,resilience,risk}`.
- L4: The `!` injection uses plain `git diff --stat HEAD` / `git status --short` with no variable: the skills guard allows only CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA and CLAUDE_SESSION_ID, and the skill's `!` commands run in the project cwd. A git range argument is validated by the model and used with Bash, never inside a `!` line.
- L5: E2E (claude 2.1.327, temp git repo with a changed `calc.ts`: `add` returns `a - b`, hardcoded key, shell-concatenated `execSync`, non-retrying `fetchRetry`; `timeout 300 claude -p --model haiku --plugin-dir plugins/odd-claude "/odd-claude:4r-review" --output-format json`, exit 0, is_error false). Merged report excerpt: "All four lenses ran and returned valid JSON." Rows: "R-1 | BLOCKER | calc.ts:6-8 | reliability (risk rated CRITICAL) | `run()` passes concatenated input to `execSync`", "R-2 | CRITICAL | calc.ts:3-4 | reliability, resilience, readability | `add()` changed from `a + b` to `a - b`", "R-3 | CRITICAL | calc.ts:2 | ... `sk-live-1234567890abcdef` committed as a constant"; closing line "Advisory only: this review gates nothing and approves nothing. You decide what to fix."
- L6: Judgment Day on the same sample (`/odd-claude:judgment-day` review only, `timeout 300`, exit 0, success): "JUDGMENT: ESCALATED. Three severe defects survive, and both judges confirmed each one", rows JD-A-001 (hardcoded key), JD-A-002 (`add` returns `a - b`), JD-A-003 (command injection); 0 fix rounds, no fix authorized. Judgment Day still runs alongside the new agents.
- L7: Attribution: NOTICE extended (MIT, same upstream) for the review agents and `4r-review`; the skill has no Apache `license` field because the upstream chain is MIT.
- L8: Temp repo cleanup blocked: `rm -r` on the `mktemp -d` directory was refused by the child safety policy; the directory is left for the parent to remove.
