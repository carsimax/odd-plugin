# Harness eval, round 2: harder tasks where harness discipline can matter
Objective: a second outcome measurement with 6 harder tasks (regression traps, precise specs, multi-step changes) and graded sub-checks, so the eval can detect outcome differences the pilot could not (ceiling effect, `docs/eval/pilot-2026-11-25.md`). Branch: `feat/harness-eval` (after 4309b76). Delivery: `ask-on-risk`.
Runner: `npm run build:bench && node --test bench/dist/eval/*.spec.js`; tasks: `node bench/eval-tasks-hard/selfcheck.mjs`.

## Specs

- **S1** User request (verbatim): "vamos con la siguiente medicion"
- **S2** User choices (question tool, verbatim): "6 tareas × 3 × 3 (Recommended)"; "Trampas de regresión (Recommended), Especificación precisa (Recommended), Cambios de varios pasos (Recommended)". Option texts shown (verbatim): "6 tareas difíciles nuevas × 3 configuraciones × 3 intentos = 54 corridas, unos USD 45-100 equivalentes. Mismo diseño que el piloto, para comparar directo."; "Para hacer bien lo pedido hay que tocar código compartido. Los tests ocultos verifican que el comportamiento que no se pidió cambiar siga intacto."; "Un documento de requisitos con textos exactos (mensajes de error, formatos, casos borde) que los tests ocultos verifican al pie de la letra."; "Varias piezas en varios archivos, como una migración de API con sus usos, donde olvidar una parte rompe algo."
- **S3** Parent design, tasks (not user words): 6 tasks under `bench/eval-tasks-hard/<id>/`, same layout as `bench/eval-tasks/` (plain Node ESM, zero deps, `node --test`, README, `task.json`), 2 per difficulty type in S2: 2 regression-trap, 2 precise-spec, 2 multi-step. Each repo is realistic and larger than the pilot's (roughly 6-15 source files, existing visible tests). Prompts are solvable without asking questions (runs are unattended) and never hint at the trap. Hidden tests split into `hidden/acceptance/` (the requested behavior) and `hidden/regression/` (behavior the request did not ask to change, or spec details the prompt points to in a repo doc); `task.json` gains `checks` `{ "acceptance": "node --test hidden/acceptance/", "regression": "node --test hidden/regression/" }` and `grade` runs both. Overlays: `_reference/<id>/` (correct solution: passes everything) and `_naive/<id>/` (a plausible solution that satisfies the literal request but falls into the trap: must pass acceptance and FAIL regression, or for precise-spec fail on an exact-text detail). `selfcheck.mjs` proves for every task: shipped repo passes its visible tests and fails acceptance; reference passes visible, acceptance and regression; naive fails at least one hidden check. Target difficulty: an attentive senior engineer gets it right; a hurried one trips.
- **S4** Parent design, runner: optional `checks` in `task.json` (name -> command); when present, the runner runs each check after copying `hidden/`, records `checks: { <name>: boolean }` in the run record (schema stays `odd-claude.eval-run/v1`, field optional), and `passed` = every check passed (and `grade` is still recorded). `report.md` adds per-arm and per-task pass rates for each check name. Tasks without `checks` behave exactly as today.
- **S5** Parent design, run and report: smoke 1 run per arm on one hard task, then the 54-run measurement with `--tasks-dir bench/eval-tasks-hard --max-budget-usd 4 --total-budget-usd 100`, unless the smoke projects over USD 100 (then stop and ask). Report `docs/eval/hard-<date>.md` with the same structure as the pilot report plus per-check rates and a comparison with the pilot; raw `runs.jsonl` and `report.md` copied next to it (no streams).

## Tasks

- T1 | S3 | worker | pending — 6 hard tasks + references + naive overlays + selfcheck; done when: parent re-runs `node bench/eval-tasks-hard/selfcheck.mjs` and every task shows shipped-fails, reference-passes, naive-trips.
- T2 | S4 | worker | pending — named grade checks in runner and report (test-first); done when: eval specs RED then GREEN and the pilot tasks (no `checks`) still produce the same record shape.
- T3 | S5 | parent | pending — smoke 1 run per arm on one hard task; done when: 3 valid records with checks and cost, isolation re-verified.
- T4 | S5 | parent+worker | pending — 54-run measurement and `docs/eval/hard-<date>.md`; done when: 54 records (or budget stop reported) and the report committed.

Risk: item 2 (unattended sessions with edit and shell permissions inside temp dirs), item 6 (task difficulty and trap validity are only partly testable; the naive overlay is the proof).

## Log

- L1: user request (verbatim): "vamos con la siguiente medicion"; choices in S2. Context: pilot (4309b76) showed 100% pass in every arm; coord-on +81% cost vs none.
