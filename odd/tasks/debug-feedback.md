# Debug and feedback: root-cause debugging and review-feedback skills
Objective: add two on-demand skills adapted from external skill sets (systematic debugging; receiving review feedback) and wire them into the worker rules, skill hints, README and attribution, without growing always-loaded context. Branch: `feat/debug-feedback` (from `main` fa71498, after harden-rules #56). Ships in 5.1.0 together with harden-rules.
Runner: `npm test` + `npm run check` inside `plugins/odd-claude`; `dist/` is committed (specs are not in `dist/`).

## Specs

- **S1** Original request (verbatim): "Bien ahora quiero mejoras mas particulares de nuestro sistema, me giusta mucho https://github.com/obra/superpowers y https://github.com/addyosmani/agent-skills que me gustaria integrar cosas que tal vez nos podrian aportar a nuestro sistema"
- **S2** User package choice (verbatim): "Vamos con Depuración y feedback" — package description shown to the user: "Depuración y feedback: skills para buscar la causa raíz antes de corregir y para atender comentarios de revisión."
- **S3** Parent design notes (not user words):
  - (a) new skill `skills/systematic-debugging/SKILL.md`: no fix without an observed root cause; reproduce, localize, one hypothesis at a time, fix at the source with a regression test seen failing first; stop after three failed fix attempts and take the architecture question to the human; timing/flaky failures wait on conditions, not sleeps; "no root cause found" is reported with what was investigated.
  - (b) supporting reference `skills/systematic-debugging/references/techniques.md`: backward root-cause tracing, boundary instrumentation, bisection, defense in depth after the fix, condition-based waiting.
  - (c) new skill `skills/receiving-review/SKILL.md`: act on review feedback (human, PR comments, bots, 4r-review, Judgment Day, odd-verify) by reading all items, clarifying unclear ones before implementing any, verifying each against the code, then accept, push back with evidence, or ask; implement one item at a time with its check; conflicts with prior human decisions go to the human; replies state the change, without performative agreement.
  - (d) `agents/odd-worker.md` gets a bug-fix rule: root cause before code change, three failed attempts return `partial` with evidence.
  - (e) hints in `cards/skills.md`, both README skill lists, and MIT attribution rows in `cards/SOURCES.md`.
  - (f) a structural spec pinning (a)-(e).
  - (g) `output-styles/odd.md` stays unchanged.

## Tasks

- T1 | S2,S3a-g | worker | done — commit.

## Log

- L1: user request: "Vamos con Depuración y feedback"
- L2: Upstream read 2026-11-23 (MIT): obra/superpowers `skills/systematic-debugging/` (SKILL.md, root-cause-tracing.md, defense-in-depth.md, condition-based-waiting.md) and `skills/receiving-code-review/SKILL.md`; addyosmani/agent-skills `skills/debugging-and-error-recovery/SKILL.md`.
- L3: T1 done. RED: new `debug-feedback.spec.ts` before the content: 18 tests, 1 pass, 17 fail. GREEN: spec 18/18. `npm test` 1154 tests, 1152 pass, 0 fail, 1 skipped; `npm run check` check-naming ok. Fix on the way: `skills/*/SKILL.md` references to `.md` paths must resolve inside the skill dir, so the Completion gate is referenced by name, not path.
- L4: Independent verification of T1: B1 (spec caught 2 of 23 single-rule deletions), advisories A1 (license MIT), A2 (no-fix qualifier), A3 (authorized suite), A4 (one item at a time within the correction batch), A5 (count the first fix), A6 (in-thread `gh api` reply line: accepted as-is, mandated and short).
- L5: Correction batch applied (B1, A1-A5). Spec rewritten with `pin()` (each phrase occurs exactly once in its file): 27 tests. Mutation probe in an OS-temp scratch copy deleting each pinned phrase one at a time: 51 pins, 51 caught. Evidence: `npm test` and `npm run check` below in the worker return.
