# Efficiency bench: odd-claude vs upstream oracle (friction + oracle)
Goal: an offline, model-free bench that ports ~20 friction journeys from the upstream gentle-ai bench, runs them against odd-claude and against the upstream `gentle-ai` binary (oracle), and compares normalized results plus odd-only latency, to corroborate that odd-claude is as efficient as upstream. Branch: `feat/efficiency-bench` (from main 56b5291).
Runner: `node:test` via `npm test` inside `plugins/odd-claude` + `npm run check`; the bench itself runs through a dev-only `npm run bench`. Docs only in this document; code arrives with T1..T5.

## Specs

### S1 User request (verbatim)

- "Y hay forma de evaluar la eficiencia no se si los upstream teienen forma de hacer evals que podamos utilizar para corroborar que funcione igual o similar"

### S2 User goal (verbatim)

- "La idea de hacer los evals es que sea igual de eificiente que el uptream"

### S3 User decision (option chosen, verbatim)

- Answer: "Bench de fricción + oráculo (recomendado)"
- Option text: "Portar ~20 journeys de gentle-ai-bench con sus métricas (comandos, prompts al humano, bloqueos, idas y vueltas, model runs, bytes mostrados, subprocesos git) + latencia; correr los mismos escenarios contra el binario gentle-ai y comparar. Offline, sin modelo. ~1 semana."

### S4 Design constraints (parent's design notes from the research; not user words)

- **Upstream reference:** `upstream/gentle-ai/bench` (gitignored, read-only clone). The `main.go` header says it measures friction, not wall-clock, tokens or a composite score.
- **Metric dimensions (`metrics.go` `MetricSet`):** `human_prompts`, `manual_tokens`, `commands_to_completion`, `blocks{self_recovered, in_band, out_of_band, by_design, dead_end}`, `recovery_round_trips`, `model_runs`, `human_surface_bytes`, plus `git_subprocesses`. Each carries a derivation: measured / proxy / unobservable.
- **Runner and data:** `runner.go` is a black-box sandbox (own HOME + repo). `testdata/journeys.manifest` lists ~80 journey ids. `results.json` is a baseline from a `gentle-ai dev` build.
- **Oracle binary candidate:** `/Users/carsimax/.local/share/odd-claude-oracle/gentle-ai-4.6.0/bin/gentle-ai`. Its version 4.6.0 differs from the pinned reference 08317b9, so verify which journeys it supports; unsupported rows are allowed and must be marked, not faked.
- **Adapter:** odd-claude exposes MCP tools (`review_*`) and hooks, not the gentle-ai CLI. An adapter maps journey steps to odd tools/hooks.
- **Comparison basis:** hashes differ by design (`odd-claude.*` domains), so compare normalized projections (outcome, state, gate decision, block class, counts), never bytes.
- **Latency:** add median/p95 per operation, fresh process each run, as an odd-only measured dimension.
- **Offline, no model:** reviewer outputs are synthesized, as the upstream bench does.
- **No copying:** never copy upstream code; re-implement. Vendored data is allowed only with provenance.
- **Placement:** the bench lives outside the shipped plugin payload or under a dev-only path.
- **No telemetry.**
- **Naming:** prefix `odd`; no gentle/gentle-ai identifiers in shipped plugin files. This document is not shipped and may name upstream projects as factual references.

## Tasks

Route `writer` for all; commit pending for all.

- T1 | S4 | writer | commit pending (ready) — Metric model and report format (JSON schema for results, derivation per metric, comparison report) and a bench runner skeleton (sandbox HOME + repo, fresh processes, timing).
- T2 | S3,S4 | writer | commit pending (ready) — Select and port ~20 journeys from `journeys.manifest` relevant to odd's surface (review lifecycle low/medium/high, consent decline, correction, gate push/PR allow/deny, Stop reminder, RDD off) as odd scenarios with expected outcomes.
- T3 | S3,S4 | writer | commit pending (ready) — Oracle adapter: run the same scenarios through the `gentle-ai` binary (CLI), normalize its outputs to the same projection, and mark unsupported journeys.
- T4 | S1,S2 | writer | commit pending — Comparison report per journey and per metric, odd vs oracle (equal/better/worse with thresholds), latency median/p95; dev-only npm script `bench`; docs section under `docs/` (not the shipped README) on how to run and read it.
- T5 | S2 | writer | commit pending — Baseline run and findings: record results and list efficiency gaps as follow-up tasks.

## Log

- L1: user's request (S1): "Y hay forma de evaluar la eficiencia no se si los upstream teienen forma de hacer evals que podamos utilizar para corroborar que funcione igual o similar"
- L2: user's goal (S2): "La idea de hacer los evals es que sea igual de eificiente que el uptream"
- L3: user decision (S3): "Bench de fricción + oráculo (recomendado)"
- L4: Parent: gate fail-open fix runs separately on branch fix/gate-budget.
- L5: T1 (S4) implemented, not committed: dev-only `bench/` at repo root (own tsconfig, builds to gitignored `bench/dist/`; root `package.json` with `bench`, `test:bench`, `check`), `docs/bench.md` stub. Metric model (`metrics.ts`, derivation per dimension, odd-only latency), result schema `odd-claude.bench-result/v1` + validator, comparison format `odd-claude.bench-comparison/v1`, sandbox with git-counting shim and fake `claude`, fresh-process MCP client, journey runner and one example journey against `dist/mcp/review-server.js`. 26 bench tests pass; plugin payload untouched.
- L6: T2 (S3,S4) implemented, not committed: subject-neutral step model in `bench/src/journey.ts` (`StepSpec`, `NormalizedFacts`, `MetricEvent`, `Subject`/`SubjectSession`, `JourneyDef`, `toJourney`; `runJourney` now also accounts friction from step events and the row carries `ref_id`), odd subject over the real MCP server, PreToolUse/Stop hooks and review-mode CLI (`bench/src/subjects/odd.ts`), 23 journeys as data in `bench/src/journeys/{lifecycle,correction,gate}.ts` (each with the closest upstream id as `refId`, all passing against odd), neutral fixtures (`journeys/fixtures.ts`). Sandbox now has a fully isolated env (own HOME, CLAUDE_PLUGIN_DATA, CLAUDE_CONFIG_DIR, XDG_*; nothing inherited) and a fake `claude` that synthesizes reviewer verdicts from the prompt's echo line plus a verdict plan; `cli.ts` runs the odd journeys; `docs/bench.md` documents isolation, the model and the catalog. T3 implements `Subject` for the oracle and may replace `Journey.expected`. `journeys/example.ts` (T1) is kept for its test but is no longer in the bench list.
- L7: T3 (S3,S4) implemented, not committed: oracle subject `bench/src/subjects/oracle.ts` runs the same 23 journeys against the upstream binary 4.6.0 (version recorded in `meta.binary.version`), one fresh process per command, same normalized facts and metric events as odd (accounting as in L6; the oracle has no cost forecast so its human prompt is the consent answer only; model runs are measured because the binary runs its reviewers through the sandbox fake `claude`, which now also answers the upstream provider prompts). Isolation: sandbox env plus the product's own telemetry kill switches (`DO_NOT_TRACK=1`, `GENTLE_AI_TELEMETRY=0`, endpoint pointed at a closed loopback port; the review commands do no other network); product state lands in sandbox `$HOME/.gentle-ai` and `<repo>/.git/gentle-ai`; the isolation test also covers oracle journeys. One explicit `MAPPING` table (comment per row). Findings from 4.6.0: `review validate --gate` is non-deciding (`delivery=unmanaged`, never denies), so the 6 journeys that need a denial are `unsupported` with that reason (the 2 allow-only gate journeys run); declared divergences: a decline persists nothing, no duplicate-start guard during a pending correction, reviewers read the frozen trees so drift after consent does not refuse the run, and RDD defaults to on and refuses reviews while off. Result: oracle 17 passed / 6 unsupported / 0 failed, odd 23 passed. `npm run bench -- --subject odd|oracle|both --out <path>`; `Journey.unsupported`, `UnsupportedError`, `Subject.expected` and `JourneyEnv.runCli` added to the journey model.
