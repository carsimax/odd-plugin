# Refine v5: refinement, optimization and simplification round
Objective: strengthen the harness (never degrade it) by leaning on native Claude Code capabilities, removing duplicated prompt rules and per-event hook cost, and simplifying the review engine; measured before and after. Branch: `feat/refine-v5` (from `main` 913cd65, release 4.0.0). Target release: 5.0.0. Delivery: `ask-on-risk`; forecast well over 400 authored lines (escalation removal and prompt dedupe), slice boundaries recorded per wave.
Runner: `npm test` + `npm run check` inside `plugins/odd-claude`; `dist/` is committed and must be rebuilt (`npm run build`); `claude plugin validate plugins/odd-claude` at closure.

## Specs

- **S1** User request (verbatim): "Bien necesito ahora que pensemos en una ronda de cambios de refinamiento, optimizacion y simplificacion del sistema. La iodea no es degradar el estado actual del harness si no reforzarlo, recuerda que al ser exclusivo para calude code podemos aprovechar al maximo todas sus capacidades"
- **S2** User scope choice (verbatim): "Las cuatro olas" (waves 0, A, B, C and D of the parent's proposal, S7).
- **S3** User decision (question tool, verbatim): review engine -> "Conservar proceso hijo (Recomendado)": reviewers keep running as the `claude` child process; only lens definitions are unified, escalation is removed, routing and the pid probe are consolidated.
- **S4** User decision (question tool, verbatim): escalation -> "Quitarla (Recomendado)": remove `escalation.ts`, its store, lock and arguments; the tier is decided by assess alone.
- **S5** User decision (question tool, verbatim): wave D -> "Evaluar y documentar (Recomendado)": measure usage and value of stats, subagent recording, peers and scratch, record the recommendation here; remove nothing without a new user decision.
- **S6** User decision (question tool, verbatim): release -> "5.0.0 (Recomendado)".
- **S7** Parent's proposal (design notes, not user words):
  - Wave 0: baseline measurement before any change: bytes injected per session (output style + SessionStart context) and per prompt (UserPromptSubmit), per-hook latency (median/p95, fresh `node dist/hooks/run.js <Event>` process with fixture stdin), always-loaded prompt bytes. Re-measured at closure; "not degrading" is shown with numbers.
  - Wave A (native leverage): `skills:` preload (and `effort`, `color`) in agent frontmatter instead of hand-passed skill paths where the preload covers it; reinject the active feature document state (header, Specs IDs, open tasks, last Log entry) after compaction through a native hook that supports `additionalContext` (SessionStart `source=compact` or PostCompact, verify against https://code.claude.com/docs/en/hooks.md); `async: true` on pure-recording hooks whose output is not needed (never on hooks that inject notices); prompts name the native task tools (`TaskCreate`/`TaskUpdate`) with `TodoWrite` as fallback; `!` dynamic context in the `status` and `doctor` skills; an advisory `TaskCompleted` reminder to log evidence in the active feature document, only if the docs confirm it can inject context.
  - Wave B (prompt layer and hooks): one source per rule (task size, evidence budget, writer rule, verifier rule, test-first, allowed edit surfaces, language rule, coordinator rule, skill paths, batching); `output-styles/odd.md` acts as the index; `src/lib/context.ts` and `persona.ts` stop repeating rules already in the output style; long recipes in `agents/odd-worker.md` and `agents/odd-verify.md` move to on-demand cards; remove the `skill-creation` alias, the orphan `support/test-first-verify.md`, the dangling `pr-review` reference (`cards/skills.md`), the wrong namespace in `skills/skill-improver/SKILL.md`, the "mod" comment in `context.ts`, porting history in `cards/delegation-reference.md`; hooks: move `isValidSessionId` out of `lib/peers.ts` into a small module so UserPromptSubmit does not load peers, stop re-measuring the context backstop after its notice fired, remove the duplicated handler registry between `hooks/run.ts` and `hooks/lazy.ts`.
  - Wave C (review engine, keeps the `claude` child process per S3): remove escalation (S4); one source for the four lens definitions shared by `agents/odd-review-*.md` (used by `4r-review`) and the runner prompts; consolidate next-step routing duplicated between `review/status.ts` and `review/run.ts`; unify the pid liveness probe used by `lib/lock.ts`, `lib/peers-session.ts`, `review/lock.ts` and `review/snapshot.ts`.
  - Wave D (evaluate, per S5): stats and SubagentStart/Stop recording, peers vs native agent teams, custom scratch vs native scratchpad; recommendation recorded in the Log.
  - Not to do: replace persona/profiles with `userConfig`; drop the language rule in favour of the `language` setting (a plugin cannot set it).

## Tasks

- T0 | S1,S7 | worker | done — baseline measurement script (dev-only) and recorded numbers.
- T1 | S1,S7 | worker | pending — Wave A: agent frontmatter `skills`/`effort`/`color`, native task tool naming.
- T2 | S1,S7 | worker | pending — Wave A: post-compaction feature-doc reinjection, async recording hooks, `TaskCompleted` reminder (if supported), `!` context in status/doctor.
- T3 | S1,S7 | worker | pending — Wave B: prompt dedupe and stale references, agent recipes to cards.
- T4 | S1,S7 | worker | pending — Wave B: hook runtime optimizations.
- T5 | S3,S4,S7 | worker | pending — Wave C: remove escalation.
- T6 | S3,S7 | worker | pending — Wave C: unified lens definitions, routing consolidation, shared pid probe.
- T7 | S5,S7 | parent | pending — Wave D: evaluation and recommendation.
- T8 | S1,S6 | worker | pending — closure: re-measure, release 5.0.0 (versions, README what's new and upgrade notes, docs).

Risk: items 3 (removes the escalation contract, the `skill-creation` command, changes prompts other sessions consume) and 6 (prompt-layer changes are not caught by tests).

## Log

- L1: user request: "Bien necesito ahora que pensemos en una ronda de cambios de refinamiento, optimizacion y simplificacion del sistema. La iodea no es degradar el estado actual del harness si no reforzarlo, recuerda que al ser exclusivo para calude code podemos aprovechar al maximo todas sus capacidades"
- L2: user scope: "Las cuatro olas"; decisions S3-S6 taken through the question tool.
- L3: T0 baseline (main 913cd65 + doc only), `npm run measure` (node v26.12.1, 15 runs, isolated HOME/CLAUDE_PLUGIN_DATA, registry refresh off):
  - bytes always loaded: output style 10352; SessionStart additionalContext 3360; UserPromptSubmit additionalContext (plain prompt) 151; frontmatter descriptions 5334 (10 agents 1890 + 25 skills 3444).
  - agent body bytes: explore 2372, jd-fix 2534, jd-judge-a 2839, jd-judge-b 2902, review-readability 2914, review-reliability 3105, review-resilience 3075, review-risk 3249, verify 14652, worker 15825.
  - hook latency median/p95 ms (exit 0, dist modules loaded): SessionStart 80.1/89.9 (21); UserPromptSubmit 86.4/89.1 (15); PreToolUse 79.3/86.0 (7); PostToolUse 75.9/92.5 (10); StopFailure 73.4/77.9 (6); Stop 73.1/75.9 (8); SessionEnd 76.1/107.0 (11); SubagentStart 73.5/76.3 (6); SubagentStop 74.2/77.3 (6).
