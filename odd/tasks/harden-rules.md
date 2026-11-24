# Harden rules: short laws and excuse tables from external skill sets
Objective: harden the harness rules (completion gate, test-first excuse table, claim-free verifier handoff, never weaken tests) without growing always-loaded context. Branch: `feat/harden-rules` (from `main` 413eafc, release 5.0.0).
Runner: `npm test` + `npm run check` inside `plugins/odd-claude`; `dist/` is committed.

## Specs

- **S1** User request (verbatim): "Bien ahora quiero mejoras mas particulares de nuestro sistema, me giusta mucho https://github.com/obra/superpowers y https://github.com/addyosmani/agent-skills que me gustaria integrar cosas que tal vez nos podrian aportar a nuestro sistema"
- **S2** User scope choice (question tool, verbatim): "Endurecer reglas (Recomendado)" — option description shown to the user: "Leyes cortas y tablas de excusas en skills y cards de carga bajo demanda; el verificador no recibe la afirmación del worker; nunca debilitar pruebas; estados estándar del worker."
- **S3** Parent design notes (not user words):
  - (a) verification gate before completion claims, with rationalization table and red flags, in `skills/odd/SKILL.md`.
  - (b) test-first rationalization table in `agents/odd-worker.md` Test discipline and `support/test-first.md`.
  - (c) doubt-driven verifier handoff: pass artifact + contract, never the writer's claim.
  - (d) never weaken tests/assertions/thresholds/suppressions to reach green, and the verifier treats it as a blocker.
  - (e) MIT attribution in `cards/SOURCES.md`.
  - (f) a structural spec pinning (a)-(d).
  - (g) the "standard worker statuses" item is dropped: the worker already returns `completed | partial | blocked | interaction_required` with `risks`, so renaming would change a contract for no gain.
  - (h) `output-styles/odd.md` stays unchanged.

## Tasks

- T1 | S2,S3a-h | worker | done — commit.

## Log

- L1: user request: "Bien ahora quiero mejoras mas particulares de nuestro sistema, me giusta mucho https://github.com/obra/superpowers y https://github.com/addyosmani/agent-skills que me gustaria integrar cosas que tal vez nos podrian aportar a nuestro sistema"
- L2: user scope: "Endurecer reglas (Recomendado)" — option description shown to the user: "Leyes cortas y tablas de excusas en skills y cards de carga bajo demanda; el verificador no recibe la afirmación del worker; nunca debilitar pruebas; estados estándar del worker."
- L3: Upstream read: superpowers verification-before-completion, test-driven-development, subagent-driven-development; agent-skills doubt-driven-development, constraint-driven-development (MIT, fetched 2026-11-23).
- L4: independent verification of T1: one blocker (B1: odd-verify claim line contradicted the writer-check reuse rule) and advisories A1-A6. A5 accepted: the excuse table lives only in the worker agent; `support/test-first.md` keeps a pointer.
- L5: correction batch applied: B1 narrowed to claims and the verification handoff keeps the writer's reported commands; A1 rewording and SOURCES sentence; A2 passive readback exception; A3 regression-test row scoped to fixes; A4 "in this task"; A6 "or changes the behavior under test" in worker and verifier; two probe tests appended to `rule-hardening.spec.ts`. Evidence recorded in the handoff (npm test, npm run check).
- L6: Parent spot check 2026-11-23: npm test exit 0 (1134/1132 pass, 0 fail, 1 skipped), npm run check ok; B1 recheck met.
