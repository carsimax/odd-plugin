# v1.1 mods UX and v1.0 follow-ups (Phase 5)
Goal: ship the v1.0 verification follow-ups and the Phase 5 mods UX (agents, statusLine, changes, stats, profiles, routing, tool render) with non-mod fallbacks. Branch: `feat/v1.1-mods`.
Runner: `node:test` via `npm test` inside `plugins/odd-claude` + `npm run check` + `claude plugin validate` / `claude plugin test`.

## Specs

### S1 Roadmap Phase 5 (docs/roadmap.md, "### Phase 5: Mods UX (optional)")

- **Goal:** richer UI where mods are available, with the non-mod fallback already shipped in earlier phases.
- **Matrix IDs:** R09, R36, R39, R40, R42, R44, R45, R46, R51
- **Deliverables:** `/odd-claude:agents` (R09, text fallback first, pane via mod), `/odd-claude:stats` (R36, local only), `/odd-claude:profiles` (R39), dynamic per-spawn model routing via `agent.spawn` with static frontmatter `model`/`effort` as base (R40), statusLine script `odd-status` (R44, R42 TPS segment), startup banner (R45), `/odd-claude:changes` (R46), tool-render tweaks (R51).
- **Dependencies / gates:** Phase 2; Q1 (mods available), Q7 (types). Each item ships its non-mod version (command or statusLine via setup) regardless of Q1.
- **Exit criteria:** with mods enabled, each mod feature appears (pane/status/tool); with `modules` not loaded and in `-p`, the plugin loads without errors and the fallback commands work; no mod is referenced by any Phase 1–3 behaviour.
- **Risk:** medium: preview/gated API may change between Claude Code versions; types are per-version. R42 needs token/time data in the statusLine payload (verify).

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
- Effect: the plugin contains no hook that returns deny/ask/block (v0.5 S6, kept as a project decision; `src/lib/no-deny.test.ts`). No new hook may return a block decision or `continue:false`, and a Stop hook never forces continuation.

### S3 statusLine decision (user, verbatim)

- Question: "T5 /odd-claude:setup escribe en tu ~/.claude/settings.json siempre mostrando un diff, con confirmación, backup y restore. ¿Qué claves debería manejar en v0.1?" Answer: "Solo permissions.defaultMode (Recomendado)". Option text: "Eliges el modo (default, acceptEdits, auto o plan) y la clave statusLine se agrega cuando exista el statusline (fase de UX). Así no apuntamos a un script que todavía no existe."
- Effect: `/odd-claude:setup` gains the `statusLine` key only once `odd-status` exists (T2).

### S4 v1.0 verification advisories (verbatim, from the parent)

- A-R1: "un atacante del mismo usuario que cambia la raíz `scratch` por un symlink justo entre `realpath` y `rename` consigue que se borre `victim/sess-1`… En ambos casos hace falta un atacante del mismo usuario con sincronización exacta; en la carrera sin sincronizar de 200 iteraciones no ocurrió nunca."
- A-T1: "los tombstones que deja un crash no se limpian nunca; no hay barrido. No encontré 'tombstone' ni '.rm-' en el README del plugin ni en `docs/`. Vale la pena documentar que pueden acumularse."
- A-T2: "`src/lib/terminal.ts:11` deja pasar los marcadores bidi LRM/RLM/ALM (U+200E, U+200F, U+061C) y U+2028/U+2029"

## Tasks

- T0 | S4 | writer | done (b023644, verified: S4/S2 met) — v1.0 follow-ups: verifier regression tests for the tombstone (planted entry, read-only root, foreign leftover), bounded stale-tombstone sweep at SessionStart + README note (A-T1), extra terminal-title strips (A-T2), A-R1 accepted and logged.
- T1 | S1,S2 | writer | done (98efc0b; test rename + sweep polish 97e7c44) — Mod skeleton + `/odd-claude:agents` (R09).
- T2 | S1,S2,S3 | writer | done (36bdebd + fix c9e0b30, verified twice: 2 BLOCKERs fixed) | Risk: high (setup writes `statusLine` to the user's settings.json) — statusLine `odd-status` + setup `statusLine` key + TPS segment (R44, R42).
- T3 | S1,S2 | writer | done (3a30c20) — `/odd-claude:changes` + startup banner (R46, R45).
- T4 | S1,S2 | writer | done (cae5c5f) — `/odd-claude:stats` + profiles + dynamic routing (R36, R39, R40).
- T5 | S1,S2 | writer | done (e972313; pane children fix 7746432) — Tool-render tweaks (R51).
- T6 | S1 | parent/writer | done-pending-commit (version 1.1.0, README, roadmap) — Close: README, roadmap, `claude plugin test`, version 1.1.0.

## Log

- L1: user's original request: "Vamos a trabajarlos como 1.1" (reply to the proposal to add the verifier's three regression tests and document tombstones as a small commit, or move on to v1.1 mods UX).
- L2: A-R1 accepted as residual risk (no code change): a same-user attacker with exact timing can swap the `scratch` root for a symlink between `realpath` and `rename` in `removeSessionScratch`; Node has no fd-based `unlinkat`, and the unsynchronized 200-iteration race never hit it. A same-user attacker can already delete the victim directly, so the boundary is not widened.
- L3: T0 covers S4 (A-T1, A-T2; A-R1 accepted in L2) and keeps S2 (no new deny: the sweep only deletes, outputs unchanged). Test-first: RED = `npm run build:test` TS2305 (`sweepStaleTombstones` missing); GREEN `npm test` 253 pass, 0 fail. Sweep: `.rm-<pid>-<ts>-*` real directories (lstat, realpath exactly `<realroot>/<name>`), age taken from the timestamp in the name (> 1 h), max 200 entries, run at SessionStart. Verifier regressions added: planted file/symlink at the predicted tombstone, read-only root, foreign leftover untouched. `npm run check` ok; `claude plugin validate plugins/odd-claude` passed with warnings.
- L4: Part A (S1): `claude plugin test` runs every `*.test.ts` under the plugin and refused the node:test files, so all node:test files under `src/**` were `git mv`ed to `*.spec.ts`; `hooks/register.test.ts` stays the mod test. Updated `tsconfig.json` exclude, `package.json` test glob (`node --test "dist-test/**/*.spec.js"`), `agents-guard`/`no-deny` specs and README. `npm test` 270 pass (265 + 5 new), `claude plugin test plugins/odd-claude` exit 0 (3 mod tests pass). Part B: `.gitignore` ignores `plugins/odd-claude/.claude-plugin/types/` (git check-ignore confirmed).
- L5: Part C (S4 polish, T0 follow-up), test-first: added specs for symlinks inside a stale tombstone (victim MARKER survives), malformed/future-dated names ignored, 200 cap (250 stale → 200 then 50), 250 non-tombstone dirs not starving the sweep, and concurrent sweeps not logging ENOENT. RED: the concurrent-sweep test failed (ENOENT logged). GREEN: the sweep now filters tombstone-matching entries before applying the 200 cap and skips ENOENT silently; `npm test` 270 pass x3, `npm run check` ok, `claude plugin validate` passed with warnings.
- L6: R3 accepted as residual risk next to A-R1 (no code change): a same-user attacker with exact timing can swap the tombstone root for a symlink between `realpath(p)` and `rmSync` in the sweep, provided a victim directory is named like a stale tombstone; Node has no fd-based `unlinkat`. A same-user attacker can already delete the victim directly, so the boundary is not widened.
- L7: slice note: 9 commits (T0 b023644, T1 98efc0b, rename 97e7c44, T2 36bdebd + c9e0b30, T3 3a30c20, T4 cae5c5f, T5 e972313, pane fix 7746432, plus the T6 close), about 5400 authored lines, one work unit each. A pane-children bug (panes rendered nothing) was found during T5 and fixed in 7746432.
- L8: T6 covers S1 (Phase 5 closed; mods and fallbacks documented) and keeps S2 (no deny added). Version 1.1.0 in plugin.json, marketplace.json, package.json and package-lock.json root fields; `ROADMAP_PHASE` is now "v1.1: mods UX shipped; next v1.2 web tools", test-first (RED: status.spec.ts failed on the roadmap line; GREEN after the change); dist rebuilt. S3 was met by T2 (statusLine through setup).
- L9: pending interactive checks (not observable in `claude -p`): panes `/odd-agents` and `/odd-changes`, quiet rendering, banner visibility, and the statusLine with a live payload.
- L10: verification follow-up of dcb9a49 (T3, T4, T5; S1 and S2 met, no BLOCKER), covers S1 (mods/lib parity, fallbacks keep working) and keeps S2 (no deny/continue:false added; the pane handlers only fall back to `next(e)`). (1) mod cleaner now strips whole OSC/CSI/C1/bidi sequences like `cleanText` (copy in `hooks/register.ts`; parity pinned by `src/lib/changes-parity.spec.ts`, which also compares the three replace() patterns of both copies, plus a mod test); the given assertion regex excluded `\n` because the summary is multi-line. (2) `collectChanges` spawns git with `killSignal: "SIGKILL"` and an injectable `timeoutMs` (test: fake git trapping TERM, 300 ms). (3) messages distinguish timeout ("git timed out; changes unavailable."), missing git ("git not found; changes unavailable.") and non-repo/missing dir (unchanged); the mod says "git unavailable or timed out; changes unavailable." when `process.run` throws and keeps the non-repo text for a non-zero exit. (4) both Pane handlers wrap `$.ui.resolve` and rendering in try/catch → `next(e)`. (5) `stats.ts` model names use `cleanText`; the changes pane caches the summary 4 s (module-level, shared in-flight; the command runs fresh). Verifier probe tests added as `hooks/probe.test.ts` (6 tests; one expectation adapted to the new mod message). Test-first caveat: implementation was written before the tests in this pass, so no RED run was observed; the parity assertion failed once for the `\n` reason above. `npm test` 348 pass, `claude plugin test` 24 pass. Mod rule learned: a mod may only pass `$` to top-level functions, so the cache is module-level, not inside `register`.
- L11: re-verification of fd21f71 found a BLOCKER I introduced (S1): the mod's `ui.close` called `cancel(...)`, which the L10 edit had removed, so closing a pane threw ReferenceError (swallowed by `.catch`) and the refresh timers were never cancelled. Test-first: RED = `hooks/close.test.ts` failed with `ReferenceError: cancel is not defined` (plus the new git-message test); GREEN = `cancel` restored as a top-level function in `hooks/register.ts` (mods only accept `$` and calls to top-level functions). Also: a guard test in the same file drives every registered handler once with a permissive `$` so a ReferenceError surfaces (tsc does not typecheck `hooks/`); the mod now distinguishes git non-zero exits: stderr "not a git repository" → non-repo message, otherwise "git failed; changes unavailable." (thrown run keeps "git unavailable or timed out; changes unavailable."), pinned in a test; the existing register.test.ts git-failing test now sends the real non-repo stderr. S2 kept: no deny added.

