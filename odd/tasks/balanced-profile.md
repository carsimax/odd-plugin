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
- **S6** User request (verbatim): "Y aprovecha para el outputstyle veo que vosea, debe ser español neutro completamente"
- **S7** User request (verbatim): "Solo debe existir neutral, borra mentor"

## Tasks

- T1 | S1,S2,S4 | writer | pending — profile lib/CLI/skill, `agent.spawn` mod table with fallback, SessionStart line, READMEs, tests (agent frontmatter `model` is NOT changed).
- T2 | S3 | writer | pending — RDD native review model routing from the table.
- T3 | S5 | writer | commit pending — `odd-explore` haiku in every preset; parallel explorers from distinct fronts in output style, cards, skill, exploration-budget notice, agent description, README.
- T4 | S6 | writer | commit pending — Spanish always neutral in every persona (shared rule in `persona.ts`), tests, README.
- T5 | S7 | writer | commit pending — `neutral` is the only persona and the default; `mentor` removed from lib, CLI, skill, README and tests; stored `mentor` reads as neutral; `persona mentor` is refused.
- T6 | S1-S7 | writer | release 2.3.0 pending — version bump 2.2.0 -> 2.3.0 (manifests, package, lock, marketplace), README "What's new in 2.3.0", docs current release and roadmap.

## Log

- L1: user's request: "Quiero que solo tengamos un perfil balanceado con estos [Image#1] y que siempre este por defecto"
- L2: the table of the image as the parent's transcription (all effort medium): review-refuter opus; review-validator opus; odd-jd-judge-a opus; odd-jd-judge-b sonnet; odd-jd-fix sonnet; odd-explore haiku; odd-verify opus; odd-worker sonnet; odd-review-readability sonnet; odd-review-reliability sonnet; odd-review-resilience sonnet; odd-review-risk opus. The orchestrator row (opus/medium) is the user's main session model, not set by the plugin.
- L3: user correction (S2): "Si deja el economy, max solo pedi los modelos que te pase para el balanceado". Scope revised: economy, max, custom, `use|set|clear` kept as they were; only `balanced` changes to the S1 table and becomes the default; agent frontmatter `model` stays untouched (profile routing carries the models); register.ts keeps reading `profiles.json` and falls back to the balanced table.
- L4: T1 evidence (S1, S2, S4): RED observed (11 failing in profiles.spec, 2 cli, 1 register parity) then GREEN; tsc both configs exit 0; focused specs profiles 16, cli/profiles 2, register 2, agents-frontmatter 1, lazy/lazy-load/lifecycle/session-start-shim/peers-delivery/no-deny/agents-guard/context all pass; `npm run check` ok; `claude plugin validate` passed (name warning only); default SessionStart context 3133 chars (profile line 575) within the 9000 budget. Mod tests `hooks/register.test.ts` and `hooks/probe.test.ts` updated to the S2 default (unreadable/absent state -> balanced model for odd-claude agents, other agents untouched). Not committed.
- L5: T2 evidence (S3): RED observed (5 of 6 new S3 run specs failing: no `--model`/`--effort` without an explicit model; the explicit-model case already passed) then GREEN. New `src/review/reviewer-model.ts` (+ spec, 3 tests) maps role/lens to the profile row and to runner options (haiku carries no effort; unknown lens/model -> no flag); `run.ts` reads `readProfile(deps.profileState)` once per `runReview` when `input.model` is undefined and passes per-slot options to the runner (new `RunDeps.profileState` seam for tests). Explicit caller model/effort still wins for every role. Tests: balanced 4-lens high run (risk opus/medium, others sonnet/medium), refuter and validator opus/medium, economy (lenses haiku without effort, refuter/validator sonnet/medium), explicit haiku overrides, unreadable state falls back to balanced, fake-claude argv equals `REVIEWER_ARGUMENTS` + `--model opus --effort medium`. tsc both configs ok; specs reviewer-model 3, runner 34, run 63, capture 31, review-server 38, lifecycle 7, contract 18, profiles 16 all pass. README RDD section and the MCP `model` property description updated. Risk item 3: the review engine's default reviewer model changes (previously Claude's default). Not committed.
- L6: user request: "Para todos los perfiles el explorador debe ser haiku y mejor reforzar que al usar un explorador barato siempre que se requiera un explorador lanzar varios en paralelo desde diferentes frentes, esto para tener un contexto mas profundo". T3 evidence (S5): RED observed (profiles.spec 14 pass / 3 fail before the max route change), then GREEN; max `odd-explore` now haiku/medium (balanced haiku/medium, economy haiku/low unchanged; `hooks/register.ts` balanced table unchanged). Parallel-explorers rule applied to output style, cards (full-delegation, delegation, delegation-reference), skill, exploration-budget notice, agent description, README. tsc both configs ok; `dist-test/lib/*.spec.js` 349 pass; `npm run check` ok; `claude plugin validate` passed. Not committed.
- L7: user request: "Y aprovecha para el outputstyle veo que vosea, debe ser español neutro completamente". T4 evidence (S6): RED observed (persona.spec and context.spec failing: mentor text lacked "Do NOT use voseo" and said Rioplatense) then GREEN; `persona.ts` now has one shared `SPANISH_RULE` used by mentor and neutral; grep of output style, cards, skills, agents, README and src found no other voseo/regional instruction; README persona line states Spanish is always neutral; `dist/lib/persona.js` rebuilt. tsc both configs exit 0; persona, context, lifecycle specs pass; `npm run check` ok. Not committed.
- L8: user request: "Solo debe existir neutral, borra mentor". T5 evidence (S7): RED observed (persona.spec: modes still mentor+neutral, stored mentor read as mentor; cli/context specs pinned mentor) then GREEN; `PERSONA_MODES = ["neutral"]`, `DEFAULT_PERSONA = "neutral"`, mentor text removed (SPANISH_RULE kept as the shared Spanish rule), stored/unknown mentor reads as neutral, `writePersona("mentor")` and `persona --mode mentor` fail with `invalid persona "mentor"; available modes: neutral` (exit 1, state untouched); skill and README updated; `dist/lib/persona.js` and `dist/cli/persona.js` rebuilt. tsc both configs exit 0; persona 7, cli persona 5, context 11, cli statusline 4, lib statusline 9, lifecycle 10, lazy 7 pass; `npm run check` ok; `claude plugin validate` passed with warnings. `src/hooks/run.spec.ts` (2 tests, `Persona mode: mentor`) fails until it is updated to neutral (outside T5 edit surfaces). Risk item 3: the `mentor` CLI value is removed. Not committed.
- L9: user request: "Si vamos con la 2.3.0". T6 release prep: version 2.3.0 in plugin.json, package.json, package-lock.json, marketplace.json; README "What's new in 2.3.0" with upgrade notes; docs/README.md and docs/roadmap.md updated. Not committed.
- L10: T2 verification BLOCKER B1 fixed (S3). The reviewer forecast binding (`run.ts` `domainHash("run-reviewer-batch")`) hashed only the explicit `input.model`/`input.effort`, so a profile change between forecast and acknowledgement ran another model (economy forecast, `useProfile("max")`, same binding -> ran opus/high, `closed`). RED observed (verifier repro as a spec: got `closed`, expected `binding-drift`), then GREEN: the binding now carries `routes` (the resolved `model/effort` of each slot from `optionsFor`, same single profile read of the run), and `ReviewerSlotView` gained optional `model`/`effort` (resolved; absent when Claude's default applies, e.g. haiku has no effort) so the human sees what they approve; no conformance SchemaPatch needed (the testkit only checks `reviewers.length`). Mutation check: dropping `routes` fails the new spec. Also A3: `renderPresetList` shows `judges=<judge-a>/<judge-b>` (spec added). Checks: both tsc, run.spec 65/0, review-server 38/0, conformance contract 18/0 and lifecycle 7/0, profiles 18/0, cli/profiles 2/0, `npm run check` ok. Not committed.
