# Balanced model profile as the default
Objective: change the `balanced` preset to the user's table and make it the default whenever no profile was chosen; economy, max and custom stay. Branch: `feat/balanced-profile` (from `main` df4582a, release 2.2.0). Delivery: `ask-on-risk`. Runner: `node:test` (`npx tsc -p tsconfig.test.json` then `node --test dist-test/...`) inside `plugins/odd-claude` + `npm run check`.

## Specs

- **S1** User request (verbatim): "Quiero que solo tengamos un perfil balanceado con estos [Image#1] y que siempre este por defecto". Exact meaning of the image (parent's transcription, all effort medium):

  | odd-claude role | model |
  |---|---|
  | review-refuter (RDD native refuter) | opus |
  | review-validator (RDD native targeted validator) | opus |
  | odd-jd-judge-a | opus |
  | odd-jd-judge-b | sonnet |
  | odd-jd-fix | sonnet |
  | odd-explore | haiku |
  | odd-verify | opus |
  | odd-worker | sonnet |
  | odd-review-readability | sonnet |
  | odd-review-reliability | sonnet |
  | odd-review-resilience | sonnet |
  | odd-review-risk | opus |

  The image's orchestrator row (opus/medium) is the user's own main session model; the plugin does not set it.
- **S2** Keep economy and max (and custom); only the balanced preset changes to the S1 table; balanced is the default whenever no profile was chosen. (A stored profile that is absent, unreadable, garbage or unknown reads as balanced; `clear` returns to balanced; an explicitly chosen economy/max/custom still wins.) The `review-refuter` and `review-validator` rows are also added to economy (sonnet/medium) and max (opus/xhigh), mirroring each preset's judges: parent-approved assumption.
- **S3** The RDD native review uses the table for its reviewer runs when the caller passes no explicit model: lens risk/resilience/readability/reliability -> the `odd-review-*` rows, refuter -> `review-refuter`, validator -> `review-validator`.
- **S4** Docs and help (README, skill, CLI usage) reflect S1-S2.
- **S5** User request (verbatim): "Para todos los perfiles el explorador debe ser haiku y mejor reforzar que al usar un explorador barato siempre que se requiera un explorador lanzar varios en paralelo desde diferentes frentes, esto para tener un contexto mas profundo"

## Tasks

- T1 | S1,S2,S4 | writer | pending — profile lib/CLI/skill, `agent.spawn` mod table with fallback, SessionStart line, READMEs, tests (agent frontmatter `model` is NOT changed).
- T2 | S3 | writer | pending — RDD native review model routing from the table.
- T3 | S5 | writer | commit pending — `odd-explore` haiku in every preset; parallel explorers from distinct fronts in output style, cards, skill, exploration-budget notice, agent description, README.

## Log

- L1: user's request: "Quiero que solo tengamos un perfil balanceado con estos [Image#1] y que siempre este por defecto"
- L2: the table of the image as the parent's transcription (all effort medium): review-refuter opus; review-validator opus; odd-jd-judge-a opus; odd-jd-judge-b sonnet; odd-jd-fix sonnet; odd-explore haiku; odd-verify opus; odd-worker sonnet; odd-review-readability sonnet; odd-review-reliability sonnet; odd-review-resilience sonnet; odd-review-risk opus. The orchestrator row (opus/medium) is the user's main session model, not set by the plugin.
- L3: user correction (S2): "Si deja el economy, max solo pedi los modelos que te pase para el balanceado". Scope revised: economy, max, custom, `use|set|clear` kept as they were; only `balanced` changes to the S1 table and becomes the default; agent frontmatter `model` stays untouched (profile routing carries the models); register.ts keeps reading `profiles.json` and falls back to the balanced table.
- L4: T1 evidence (S1, S2, S4): RED observed (11 failing in profiles.spec, 2 cli, 1 register parity) then GREEN; tsc both configs exit 0; focused specs profiles 16, cli/profiles 2, register 2, agents-frontmatter 1, lazy/lazy-load/lifecycle/session-start-shim/peers-delivery/no-deny/agents-guard/context all pass; `npm run check` ok; `claude plugin validate` passed (name warning only); default SessionStart context 3133 chars (profile line 575) within the 9000 budget. Mod tests `hooks/register.test.ts` and `hooks/probe.test.ts` updated to the S2 default (unreadable/absent state -> balanced model for odd-claude agents, other agents untouched). Not committed.
- L5: T2 evidence (S3): RED observed (5 of 6 new S3 run specs failing: no `--model`/`--effort` without an explicit model; the explicit-model case already passed) then GREEN. New `src/review/reviewer-model.ts` (+ spec, 3 tests) maps role/lens to the profile row and to runner options (haiku carries no effort; unknown lens/model -> no flag); `run.ts` reads `readProfile(deps.profileState)` once per `runReview` when `input.model` is undefined and passes per-slot options to the runner (new `RunDeps.profileState` seam for tests). Explicit caller model/effort still wins for every role. Tests: balanced 4-lens high run (risk opus/medium, others sonnet/medium), refuter and validator opus/medium, economy (lenses haiku without effort, refuter/validator sonnet/medium), explicit haiku overrides, unreadable state falls back to balanced, fake-claude argv equals `REVIEWER_ARGUMENTS` + `--model opus --effort medium`. tsc both configs ok; specs reviewer-model 3, runner 34, run 63, capture 31, review-server 38, lifecycle 7, contract 18, profiles 16 all pass. README RDD section and the MCP `model` property description updated. Risk item 3: the review engine's default reviewer model changes (previously Claude's default). Not committed.
- L6: user request: "Para todos los perfiles el explorador debe ser haiku y mejor reforzar que al usar un explorador barato siempre que se requiera un explorador lanzar varios en paralelo desde diferentes frentes, esto para tener un contexto mas profundo". T3 evidence (S5): RED observed (profiles.spec 14 pass / 3 fail before the max route change), then GREEN; max `odd-explore` now haiku/medium (balanced haiku/medium, economy haiku/low unchanged; `hooks/register.ts` balanced table unchanged). Parallel-explorers rule applied to output style, cards (full-delegation, delegation, delegation-reference), skill, exploration-budget notice, agent description, README. tsc both configs ok; `dist-test/lib/*.spec.js` 349 pass; `npm run check` ok; `claude plugin validate` passed. Not committed.
