# odd-claude v10 roadmap: Python migration

**Goal.** Rebuild odd-claude's deterministic code (hooks, lib, review engine, MCP server, CLI, installer, TUI) in Python 3.14 with Pydantic v2, at behavioral parity with v9, so that the harness can later host its own local-AI services: an own memory (replacing Engram), an own code graph (replacing codegraph) and a curator, backed by Qdrant and Ollama. The tool is personal: it is built to do the job well, not to be fast.

Status: **Phases 0-2 complete (PRs #69, #70, #71 merged); Phase 3 (review engine) in progress on `feat/py-review`.** Date: 2026-11-27. The v1-v9 history is in [roadmap.md](roadmap.md).

Everything marked *proposal* or *open question* below is not decided. Everything under [Decisions](#2-decisions) is.

---

## 1. Quick path

1. Phase 0 spikes settle the open technical questions with measurements.
2. Phases 1-8 reach v10.0.0: Python at parity with TS v9, contract tests as the arbiter (Phase 3 review engine, then Phase 4 hooks).
3. Phase 8.5 (v10.x cleanup) retires all legacy TS/JS after v10.0.0.
4. Only then: Phase 9 own memory, Phase 10 own code graph, Phase 11 curator discovery.

Each phase becomes a feature document `odd/tasks/<name>.md` when it starts, with its own specs and tasks.

---

## 2. Decisions

Product decisions from the grill rounds of 2026-11-27. The answer column is verbatim.

| Topic | Verbatim answer | Consequence |
|-------|-----------------|-------------|
| Host | "Solo Claude Code (Recommended)" | Stays a Claude Code harness (hooks, MCP, agents, rules). Multi-host and an own model runtime are out of scope. |
| Memory | "Reemplazar desde cero" | Own memory replaces Engram. No import of Engram data. |
| Code graph | "Reemplazar" | Own graph (tree-sitter + semantic layer) replaces codegraph entirely. |
| Migration | "Paridad primero (Recommended)" | Port behavior 1:1 with specs as the contract, ship v10, only then new features. |
| Curator | "La definicion de que hara lo haremos mas adelante" | Scope deferred. Phase 11 is a discovery phase; candidate jobs are options, not commitments. |
| Infra | "Compose + Ollama nativo (Recommended)" | Docker compose for daemon + Qdrant. Ollama native on macOS (Docker Desktop on Mac has no Metal GPU access). |
| Failures | "Degradar (Recommended)" | When daemon, Qdrant or Ollama are down, Claude Code keeps working without local-AI capabilities. Warn once, log. |
| Hardware | "Mac Apple Silicon 16GB" | Budget for 7-8B models and light embedding models. Claude Code + Docker + Ollama share 16GB, so a RAM budget is an explicit constraint. |
| Repo | "Mismo repo (Recommended)" | The Python package replaces `plugins/odd-claude/` in a new root. Resolves the backlog item to rename `plugins/odd-claude` to `src/`. |
| Python | "3.14 (Recommended)" | Managed with uv. |
| TUI | "Portar a Textual (Recommended)" | The ink/react TUI is rebuilt on Textual. |
| Cutover | "Al alcanzar paridad (Recommended)" | Engram and codegraph stay in use during migration. Each is uninstalled only when its replacement covers today's usage. |
| Upstream | "Referencia, no fuente (Recommended)" | gentle-shell is a reference for ideas, not the behavior source. The bench oracle against gentle-ai stays while useful. **Supersedes guiding principles 6-7 of [roadmap.md](roadmap.md) for v10.** |
| Post-v10 priority | "Memoria propia (Recommended)" | Order: own memory, then own code graph, then curator. |
| Legacy TS/JS (D1, 2026-11-27) | Request: "Agreda entre la fase 8 y 9 retirar completamente el codigo legado ts y js". Scope: "Todo, cero TS/JS (Recommended)" (option text: "La fase nueva porta la suite de contratos a pytest y el bench a Python, borra package.json, node_modules, scripts .mjs y toda dependencia de node. Revierte esas dos decisiones (quedan registradas como reemplazadas). El repo queda 100% Python.") | New Phase 8.5 between Phases 8 and 9. Supersedes the Phase 1 suite-language decision ("TS node:test (Recommended)", if recorded) and the bench decision ("Se queda en TS (Recommended)"), both kept as written and marked "Superseded by Phase 8.5 (2026-11-27)". |
| Phase order (D2, 2026-11-27) | "Invertir 3 y 4 (Recommended)" (option text: "Primero motor de revisión + servidor MCP + CLI review-mode; luego hooks (con los CLIs stats/retro/tasks que sus tests usan, que son envoltorios finos sobre lib ya portada). Cada fase termina con sus contratos en verde con ODD_IMPL=py.") | Phase 3 = review engine and MCP server (+ `review-mode`), Phase 4 = hooks (+ `stats`, `retro`, `tasks`). Reason: Stop and PreToolUse import the review engine (`hooks/stop.ts:5-10`, `hooks/pre-tool-use.ts:2`), ~5.6k lines of `src/review/`; 10 of the 17 hook contract tests also spawn `review-mode`, `review-server`, `stats`, `retro` or `tasks`. |
| Latency | User: "los ms no son relevantes" | The deterministic core can stay process-per-invocation and import Pydantic freely. A resident daemon exists only for AI/vector services (memory, graph semantic layer, curator), never for hooks. |

---

## 3. Guiding principles for v10

1. **Parity before features.** v10.0.0 does what v9 does. No new capability ships in a migration phase.
2. **Black-box contract tests are the arbiter.** If the contract suite passes against both implementations, they are equivalent.
3. **Persisted formats stay readable.** Session state, status files, review store and installer manifest keep their schemas; an installed v9 data directory is read by v10.
4. **Degrade, never block.** Optional AI infra down means a warning once and a log line, never a blocked Claude Code session.
5. **Deterministic core is process-per-call.** Hooks and CLI start, work, exit. A daemon serves only AI services.
6. **Pydantic v2 everywhere it crosses a boundary.** Every persisted format and every MCP tool input has a model. Exception: review-store records (`odd-claude.review-state/v2`, receipts) are plain dicts in v9's JSON shape validated by the ported hand-written validator, because it must reproduce v9's full error lists; decided in Phase 3 (`odd/tasks/py-review.md` L11).
7. **Upstream is reference, not source.** Ideas may come from gentle-shell; behavior is defined by this repo's specs and contract tests.
8. **Personal tool, serious releases.** No telemetry, no multi-user concerns. Releases and rollback stay, because a broken harness breaks every session.

---

## 4. Current system (v9, TypeScript)

Mapped 2026-11-27. About 19.3k non-spec TS lines plus 25.2k spec lines in `plugins/odd-claude/src` and `tui/src`. Runtime node >= 22. `dist/` is committed and referenced by fixed paths.

| Area | Facts | Evidence |
|------|-------|----------|
| Hooks | 9 events registered, all `node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/run.js" <Event>`. Stop is the only blocking hook (`{decision:"block"}`), fail-open otherwise. Errors give exit 0, empty stdout, logged. | `src/hooks` (~436 lines), `hooks/hooks.json`, `src/hooks/stop.ts:78` |
| Hook events | SessionStart (state, scratch dir, status, registry refresh + codegraph warm-up detached, additionalContext, feature-doc summary on compact/resume); UserPromptSubmit (counters, language anchor, quota advice); PreToolUse (Bash\|Edit\|Write\|NotebookEdit; RDD delivery notice, advisory only); PostToolUse (Read\|Grep\|Glob\|WebFetch\|WebSearch\|codegraph; exploration budget R14, context backstop R34 from transcript tail); StopFailure (async; error classification, quota advice); Stop; SessionEnd (scratch removal refusing symlinks, resume hint); SubagentStart/SubagentStop (silent). | `src/hooks/*` |
| lib | 31 files, ~3k lines: state/persistence (`state.ts`, `scratch.ts`, `agent-status.ts`, `transcript-tail.ts`, `subagents.ts`); locks/pids (`lock.ts` 260 lines: exclusive create, stale takeover, owned release; `pid.ts` kill(pid,0) ESRCH/EPERM); profiles/modes (`profiles.ts`, `context.ts`, `background-subagents.ts`, `advisory-notices.ts`); `doctor.ts`, `stats.ts`, `retro.ts`, `quota.ts`, `exploration-budget.ts`, `context-backstop.ts`, `feature-doc.ts` (tasks lint); `setup.ts`/`setup-fs.ts` (atomic settings apply, backups); `deny-profile.ts`, `skill-registry.ts`, `codegraph.ts`, `codegraph-trust.ts`, `session-integrations.ts`. | `src/lib` |
| Persisted formats | See [table below](#persisted-formats-contracts-the-port-must-read). | `src/lib/state.ts:10` and others |
| MCP review server | Hand-rolled JSON-RPC over stdio (no SDK), newline-delimited, 4 MiB line cap, protocol versions 2025-06-18 / 2025-03-26 / 2024-11-05, cancellation via `notifications/cancelled`. 10 tools: `review_assess`, `review_inspect`, `review_start`, `review_status`, `review_answer_consent`, `review_capture`, `review_capture_group`, `review_acknowledge_approved`, `review_complete`, `review_run`. Hand-written JSON Schemas with a restricted keyword validator and argument coercion. | `src/mcp`, `tools.ts:473` |
| Review engine | Pure transition functions (`start`, `admitLensResult`, `admitValidatorResult`, `admitRefuterResult`, `requireCorrection`, `beginValidation`, `approve`, `reopenCorrection`, `escalate`, `invalidate`, `burn`). States: reviewing, correction_required, validating, approved, escalated, invalidated. Limits `MAX_CORRECTION_ATTEMPTS`, `MAX_ADMITTED_ROLE_RESULTS=6`, `MAX_CORRECTION_CHANGED_LINES=200`. Consent binding and drift; forecast before the first reviewer batch. | `src/review/state.ts` |
| CLI | 15 commands: background-subagents, codegraph-trust, codegraph-warm, coordinator, doctor, profiles, retro, review-mode, scratch, setup, skill-registry, stats, status, tasks. Installer CLI: install, update, uninstall [--purge], rollback, models, backups [--restore], status, internal reapply; flags `--dry-run --yes --json --force --source`; exit codes 0/1/2. | `src/cli`, `src/installer/cli.ts` |
| Installer | Writes `~/.claude` settings.json hooks (merge/unmerge by path), skills/rules/agents (model + effort rewritten per profile)/workflows/output style, CLAUDE.md marker blocks `<!-- odd-claude:<id> -->` from `claude-md/*.md`, MCP registration via `claude mcp add -s user` (odd-review = `node review-server.js`; codegraph = `codegraph serve --mcp`), manifest ledger, backups, rollback, update from GitHub release assets with checksum verification (6h TTL via `gh release view`), `~/.odd-claude/{versions,current symlink,bin,data}`. Bootstrap `scripts/install.sh` requires node >= 22 and authenticated gh; repo `carsimax/odd-plugin`; launcher `~/.local/bin/odd-claude` does `exec node <bundle>`. | `src/installer` |
| TUI | ink/react, bundled to `tui/dist/odd-claude.mjs`. Menu: Install / Update / Configure models / Manage backups / Uninstall / Quit. Flows: install (welcome, detection, profile, models, extras, deps, review, installing, complete), models, update, uninstall, backups. Services call installer orchestrate functions. | `plugins/odd-claude/tui` |
| Release | Manual, no CI: `bump-version.mjs`, build with clean dist check, tui bundle, `release-payload.mjs` (deterministic tar.gz + `odd-claude.mjs` + `checksums.txt`), commit `chore(release): <v> [skip ci]`, tag, `gh release create` with 3 assets. | `scripts/` |
| Tests | node:test. Mixed style. Black-box: `conformance/harness.testkit.ts:184-224` spawns the built server with fake PATH and sandbox HOME, drives JSON-RPC over stdin, kill -9 injection; `review-server.spec` spawn tests. Internal: `state.spec` pure functions, testkits with temp git repos. About 528 tests in mcp+review, ~92 conformance (some are text/budget checks on `rules/*.md`, e.g. `rules-from-cards.spec.ts` 24,000-byte budget), ~195 in `bench/src`. | `src/**/*.spec.ts` |
| bench | Repo root. Black-box: drives `dist/mcp/review-server.js`, `dist/hooks/run.js <event>` with stdin JSON, `dist/cli/review-mode.js`; oracle journeys compare normalized facts against upstream gentle-ai 4.6.0 (skipped when absent). The eval installs into a sandbox and imports `dist/installer/orchestrate.js` (not black-box). | `bench/` |
| Payload (language-agnostic, stays) | 10 agents, 9 claude-md fragments, 4 rules, 25 skills, 1 output style, `hooks.json`, `statusline.sh`, `support/` docs. | `plugins/odd-claude/` |

### Persisted formats (contracts the port must read)

| Format | Location / schema |
|--------|-------------------|
| Session state | `<dataDir>/sessions/<id>.json`, envelope `{version:1, sessionId, data}` (`STATE_SCHEMA_VERSION=1`, `state.ts:10`) |
| Plugin-wide state | `<dataDir>/<name>.json`, same envelope (delegation, setup, profiles) |
| Agent status | `status/<id>.json`, `odd-claude.agent-status/v1` |
| Scratch | `scratch/<id>/`, mode 0700 |
| Logs | `logs/hooks.log` |
| Output schemas | `odd-claude.retro/v1`, `odd-claude.stats/v1`, `odd-claude.tasks-lint/v1` |
| Review store | `<git commonDir>/odd-plugin/review-transactions/v2`, `review-state.json` schema `odd-claude.review-state/v2`, receipt files, revision-CAS writes |
| Installer | `~/.odd-claude/manifest.json` (path to sha256, blocks, models), `settings-state.json`, `backups/` |
| Data dir env | `ODD_CLAUDE_DATA`, `CLAUDE_PLUGIN_DATA`, `ODD_CLAUDE_HOME` |

Concurrency in place: session lock files, atomic tmp+rename writes, pruning of 7-day-old session/status files (skipping locked ones), installer lock `<oddHome>/.lock`.

### Coupling to rewrite

| Coupled to | Where |
|------------|-------|
| Node entrypoint text | `hooks/hooks.json` (9 lines); `rules/odd-tracking.md:29` (`node .../dist/cli/tasks.js`); `!`/instruction lines in skills odd-background-subagents, odd-coordinator, odd-doctor, odd-profiles, odd-retro, odd-scratch, odd-setup, odd-skill-registry, odd-stats, odd-status; `support/feature-doc-format.md:20` ("Runner: `npm test`"); README build/release sections |
| Engram | 34 references across 11 payload files (heaviest `claude-md/08-memory.md`, `rules/odd-tracking.md`) |
| codegraph | 33 references across 15 files (`claude-md/09-codegraph.md`, all agents) |

**Dependency on in-flight work.** None. `autonomous-review` (which changed correction limits) merged in PR #68 (v9.2.0); the review port (Phase 3) starts from it.

---

## 5. Target architecture (proposal)

### Stack

| Layer | Choice | Status |
|-------|--------|--------|
| Language / env | Python 3.14, uv | Decided |
| Models | Pydantic v2 | Decided |
| Tests | pytest | Proposal |
| CLI framework | stdlib `argparse` | Decided (Phase 0) |
| MCP server | Hand-rolled (port of `server-core.ts`); must preserve protocol versions, cancellation, error codes, 4 MiB cap | Decided (Phase 0) |
| Packaging / command shape | Wheel + payload installed into a uv-created venv under `versions/<v>/`; hook command `"$ODD/current/venv/bin/python" ...` (py-04) | Decided (Phase 0) |
| TUI | Textual | Decided |
| Post-v10 | docker compose (daemon + Qdrant), Ollama native at `host.docker.internal:11434` | Decided (infra); layout is a proposal |

### Repo layout (proposal)

```text
pyproject.toml
src/odd_claude/
  hooks/  lib/  review/  mcp/  cli/  installer/  tui/
payload/            # rules, agents, skills, claude-md, output-styles, statusline, hooks.json, support
tests/
  contract/         # implementation-agnostic, black-box
  unit/
bench/              # ported to Python in Phase 8.5 (was: stays TS, Phase 0; superseded by Phase 8.5, 2026-11-27)
```

Single console entrypoint `odd-claude` with subcommands, for example `odd-claude hook <Event>`, `odd-claude mcp review`, `odd-claude tasks`. The root `src/odd_claude/` is decided (`plugins/odd-claude/` is retired in Phase 8); bench is ported to Python and all TS/JS is removed in Phase 8.5.

### v10 (proposal)

```text
Claude Code
  |-- hooks.json -> odd-claude hook <Event>   (process per call, fail-open)
  |-- MCP stdio  -> odd-claude mcp review     (10 review tools)
  |-- CLI/skills -> odd-claude <command>
          |
          v
   odd_claude (Python 3.14, Pydantic v2)
          |
          v
   same on-disk formats as v9:
   <dataDir>/sessions, status, scratch, logs,
   <git commonDir>/odd-plugin/review-transactions/v2,
   ~/.odd-claude/manifest.json
```

### Post-v10 (proposal)

```text
Claude Code --hooks/CLI--> odd-claude (process per call)
     |                          |  warn once + degrade if daemon down
     |--MCP--> memory MCP ------+
     |--MCP--> graph MCP -------+--> odd-claude daemon (docker compose)
                                          |            |
                                          v            v
                                       Qdrant   host.docker.internal:11434
                                      (compose)   Ollama (native, Metal GPU)
```

---

## 6. Phases

Risk items use the ODD numbering: 1 persisted data, 2 security, 3 consumed contracts, 4 concurrency, 5 delivery/environment, 6 no regression test.

### Phase 0: Spikes and gates

- **Goal.** Replace assumptions with measurements before any port.
- **Scope.**
  - uv project skeleton.
  - MCP SDK vs hand-rolled: protocol versions, cancellation, error codes, 4 MiB cap.
  - Textual feasibility for the 5 install/models/update/uninstall/backups flows.
  - Hook and MCP command shape in `settings.json`.
  - RAM budget on 16GB: embedding model candidates and a 7-8B curator model alongside Claude Code + Docker; results recorded.
  - Feasibility of a language-neutral contract harness.
  - Resolve the [open questions](#9-open-questions).
- **Exit criteria.**
  - Each spike has a recorded result with the command that produced it.
  - Every open question in section 9 has a decision or an explicit deferral.
- **Risk.** Item 5 (environment: uv, Python 3.14 availability).
- **Depends on.** Nothing.
- **Becomes** `odd/tasks/py-phase0-spikes.md` (name is a proposal).

### Phase 1: Contract extraction

- **Goal.** Make the TS suite's black-box part the portable definition of behavior.
- **Scope.**
  - Black-box suites become implementation-agnostic: an env var such as `ODD_IMPL=ts|py` selects the entry commands.
  - Document every persisted format as a frozen contract, with fixtures captured from the TS implementation.
  - Decide which internal-style tests are ported per module and which are replaced by contract tests.
- **Exit criteria.**
  - The contract suite passes against TS v9.
  - Each persisted format has a frozen fixture.
  - A list maps each internal-only test to port, replace or drop, with a reason.
- **Risk.** Item 6 (behavior covered only by internal TS tests is lost if not mapped).
- **Depends on.** Phase 0.
- **Becomes** `odd/tasks/py-contract-extraction.md`.

### Phase 2: Core lib

- **Goal.** Python equivalents of the lib layer.
- **Scope.** State, locks, pids, atomic writes, scratch, profiles, context, quota, exploration budget, context backstop, transcript tail, feature-doc lint, stats, retro, doctor (checks python/uv instead of node). Pydantic models with schema-version validation.
- **Scope note.** The four dependency modules (background-subagents, system, subagents, transcript-path) are included; the other lib modules port with the phase that consumes them (decision L3 of `odd/tasks/py-core-lib.md`).
- **Exit criteria.**
  - Fixtures from Phase 1 load and round-trip byte-compatibly where the format is stable.
  - Lock semantics (exclusive create, stale takeover, owned release, EPERM/ESRCH handling) pass cross-process tests, including kill -9 injection.
  - Version mismatch is rejected the same way as v9.
- **Risk.** Items 1, 4.
- **Depends on.** Phase 1.
- **Becomes** `odd/tasks/py-core-lib.md`.

### Phase 3: Review engine and MCP server

Ordered before hooks by decision D2 (2026-11-27): the Stop and PreToolUse hooks import the review engine, so the engine must exist first.

- **Goal.** Review lifecycle, the odd-review MCP server and the `review-mode` CLI in Python.
- **Scope.** Pure state machine, revision-CAS store, consent binding and drift, forecast, capture, acknowledgement, 10 tools with identical names and input schemas (contract item 3), restricted validation and argument coercion as v9. The `review-mode` CLI (a command hook contract tests spawn). Starts from the merged `autonomous-review` state (PR #68, v9.2.0).
- **Exit criteria.**
  - MCP contract and conformance suites pass with `ODD_IMPL=py`.
  - Tool names and input schemas match v9 exactly (diffed from `tools/list`).
  - A review transaction written by TS is readable by Python and the reverse.
  - `review-mode` contract tests pass with `ODD_IMPL=py`.
- **Risk.** Items 1, 3, 4.
- **Depends on.** Phase 2.
- **Becomes** `odd/tasks/py-review.md`.

### Phase 4: Hooks

- **Goal.** The 9 events behind `odd-claude hook <Event>`.
- **Scope.**
  - Fail-open semantics (errors give exit 0, empty stdout, logged); Stop is the only blocking hook; async events (StopFailure); SubagentStart/SubagentStop silent.
  - The thin CLIs `stats`, `retro` and `tasks` that hook contract tests spawn (wrappers over lib ported in Phase 2). The other CLI commands stay in Phase 5.
  - The hook-layer lib modules mapped to this phase in `docs/contracts/test-mapping.md`: advisory-notices, agent-status, codegraph-trust, codegraph, root, session-integrations, skill-registry, status, terminal.
- **Exit criteria.**
  - Hook contract tests pass with `ODD_IMPL=py` (Stop and PreToolUse use the Phase 3 review engine).
  - Stop blocks only where v9 blocks.
  - A forced internal error yields exit 0 and an empty stdout.
- **Risk.** Items 3, 4.
- **Depends on.** Phase 3.
- **Becomes** `odd/tasks/py-hooks.md`.

### Phase 5: CLI

- **Goal.** All commands on the new entrypoint.
- **Scope.** The 15 commands (`review-mode`, `stats`, `retro` and `tasks` already landed in Phases 3-4); rewrite skills `!` lines and `rules/odd-tracking.md:29` to the new entrypoint.
- **Exit criteria.**
  - Every command's stdout, exit code and JSON schema match v9 in contract tests.
  - No payload line still references `node .../dist/cli/*`.
- **Risk.** Item 3.
- **Depends on.** Phase 2.
- **Becomes** `odd/tasks/py-cli.md`.

### Phase 6: Installer and distribution

- **Goal.** Install, update, roll back and migrate with Python.
- **Scope.**
  - uv-based install; bootstrap requires uv + gh instead of node.
  - Manifest, backups, rollback, update via GitHub release (wheel or payload + checksums; open question).
  - settings.json hook and MCP command rewrite.
  - Migration path from an installed TS v9: data stays readable, hooks are rewritten, rollback to v9 stays possible.
- **Exit criteria.**
  - In a sandbox HOME: install, update, rollback, uninstall --purge succeed and leave no stray files.
  - v9 to v10 migration then rollback to v9 leaves a working v9.
  - Rewritten settings.json keeps unrelated user entries.
- **Risk.** Items 1, 5 (and 2 for settings.json writes).
- **Depends on.** Phases 3, 4, 5 (hooks Phase 4, review Phase 3).
- **Becomes** `odd/tasks/py-installer.md`.

### Phase 7: TUI on Textual

- **Goal.** The existing menu and flows on Textual.
- **Scope.** Menu (Install / Update / Configure models / Manage backups / Uninstall / Quit); flows install, models, update, uninstall, backups; services call the Python installer functions.
- **Exit criteria.** Each flow completes in a sandbox using Textual's test pilot; install flow produces the same manifest as the CLI install.
- **Risk.** Item 6 (UI flows are hard to regress-test; mitigate with pilot tests).
- **Depends on.** Phase 6.
- **Becomes** `odd/tasks/py-tui.md`.

### Phase 8: Repo restructure, payload text and v10.0.0

- **Goal.** Ship v10.0.0.
- **Scope.**
  - Move to the new root; remove committed `dist/`.
  - Update README, docs, `support/`.
  - Adapt conformance text checks (e.g. the 24,000-byte rules budget).
  - bench drives the Python implementation black-box (the eval's `dist` import is replaced).
  - Tag the final TS as v9.x and freeze it.
- **Exit criteria.**
  - Contract suite green on py.
  - An installed v10 runs a real Claude Code session end to end.
  - v9.x tag exists.
- **Risk.** Items 3, 5.
- **Depends on.** Phases 1-7.
- **Becomes** `odd/tasks/py-release-v10.md`.

### Phase 8.5: Retire legacy TS/JS

Added by decision D1 (2026-11-27). Runs after v10.0.0 and before Phase 9.

- **Goal.** The repo is 100% Python: zero TS/JS and no node dependency.
- **Scope.**
  - Port the contract suite (`plugins/odd-claude/src/contract/`, TS node:test) to pytest, keeping test names and assertions.
  - Port `bench/` to Python.
  - Delete every TS/JS source, `package.json` and lockfiles, `node_modules`, `.mjs` scripts, `tsconfig*` and `dist/`.
  - Remove every node dependency from docs, CI-less release scripts and payload text.
- **Open item.** The v9 differential oracle (`tests/lib/v9_oracle.py`) and the `test_diff_*` tests that call node are retired or frozen to recorded outputs. Decide in this phase.
- **Exit criteria.**
  - `git ls-files` shows no `*.ts`, `*.tsx`, `*.js`, `*.mjs`, `*.cjs`, `package.json`.
  - The pytest contract suite passes.
  - The full test suite runs with no `node` on PATH.
- **Risk.** Items 5, 6.
- **Depends on.** Phase 8.
- **Becomes** `odd/tasks/py-retire-ts.md`.

### Phase 9: Own memory (replaces Engram)

- **Goal.** A memory service that covers today's Engram usage, started from scratch.
- **Scope.**
  - Daemon + docker compose + Qdrant introduced here; Ollama embeddings.
  - Memory MCP server exposing the operations ODD uses today. Derive the exact list from the 34 Engram references; candidates are save, search, context, get observation, session summary, topic-key upsert, project scoping, conflict judgment, lifecycle review.
  - Degradation when infra is down (warn once, log).
  - No import of Engram data.
  - Cutover checklist, then rewrite payload references and uninstall Engram.
- **Exit criteria.**
  - Every Engram operation referenced in the payload has a working equivalent.
  - With daemon, Qdrant or Ollama stopped, a Claude Code session still works and warns once.
  - RAM stays within the Phase 0 budget during a session.
  - Cutover happens only after this list passes.
- **Risk.** Items 1, 3, 4, 5.
- **Depends on.** Phase 8; Phase 0 RAM results.
- **Becomes** `odd/tasks/memory.md`.

### Phase 10: Own code graph (replaces codegraph)

- **Goal.** Cover today's `codegraph_explore` usage.
- **Scope.**
  - tree-sitter parsing, symbol/edge store.
  - Explore tool parity: verbatim line-numbered source, call paths, blast radius.
  - File watcher.
  - Semantic layer: embeddings in Qdrant, summaries via Ollama within the RAM budget.
  - Cutover replaces the 33 references, the codegraph MCP registration, and the warm-up and trust commands.
- **Exit criteria.**
  - Explore returns equivalent source, call path and blast-radius facts on a fixed set of reference queries (set defined at phase start).
  - Degrades to structural-only when the semantic layer is down.
  - Cutover checklist passes before codegraph is uninstalled.
- **Risk.** Items 3, 4, 5.
- **Depends on.** Phase 9 (daemon and Qdrant exist).
- **Becomes** `odd/tasks/code-graph.md`.

### Phase 11: Curator (discovery first)

- **Goal.** Decide what the curator does. The user deferred scope: "La definicion de que hara lo haremos mas adelante".
- **Candidate jobs (options only, **not decided**).**
  - Memory curation.
  - Task-document validation against L1.
  - Review triage.
  - Session/transcript summarization.
- **Scope.** First deliverable is a decision round with the user. Any job is constrained by the 16GB budget (7-8B model).
- **Exit criteria.** A decision record listing chosen jobs (or none) with the model and RAM budget each needs.
- **Risk.** Decided per job at the decision round.
- **Depends on.** Phase 9 (Phase 10 optional).
- **Becomes** `odd/tasks/curator-discovery.md`.

---

## 7. Milestones

Ordering only, no dates.

| Order | Milestone | Contains |
|-------|-----------|----------|
| 1 | v10.0.0 parity | Phases 0-8 |
| 2 | v10.x cleanup | Phase 8.5 (retire legacy TS/JS; after v10.0.0, before Phase 9) |
| 3 | v10.x memory | Phase 9 |
| 4 | v11 graph | Phase 10 |
| 5 | Curator | Phase 11 (scope decided first) |

---

## 8. Risk register

| Risk | Why it matters | Mitigation |
|------|----------------|------------|
| Persisted-format drift | v10 corrupts or rejects v9 session, review or manifest data | Frozen fixtures (Phase 1); cross-implementation read/write tests |
| Lock semantics | Stale takeover or owned release differ, causing lost or doubled state | Port `lock.ts` behavior with cross-process and kill -9 tests |
| settings.json rewrite breaks every session | A bad hook command fails in every Claude Code session | Backups and rollback; sandbox HOME tests; dry-run default path |
| MCP schema drift | Agents calling review tools fail | Diff `tools/list` against v9; contract suite |
| RAM pressure | Claude Code + Docker + Ollama on 16GB swap and slow everything | Phase 0 measurement; small models; degrade when infra is down |
| Scope creep mixing migration with features | Parity becomes unverifiable | "Paridad primero": no feature merges before v10.0.0 |
| Behavior covered only by internal TS tests is lost | Silent regressions after port | Phase 1 test mapping (port / replace / drop with reason) |
| `autonomous-review` base moving | Review port starts from a moving base | Resolved: merged in PR #68 (v9.2.0); Phase 3 starts from it |

---

## 9. Open questions

Resolved in Phase 0 (evidence: `spikes/py-07-open-questions/README.md`).

| Question | Decision |
|----------|----------|
| CLI framework | "argparse (Recommended)": stdlib argparse |
| MCP server | "A mano (Recommended)": hand-rolled |
| Packaging | "Wheel (Recommended)": the release publishes a wheel + payload; the installer creates the venv with uv and installs the wheel; rollback = flip the `current` symlink |
| Name of the new root | "src/odd_claude (Recommended)": stays as is; `plugins/odd-claude/` is retired in Phase 8 |
| bench | "Se queda en TS (Recommended)": stays TS; revisit after v10.0.0 if it stops being useful. Superseded by Phase 8.5 (2026-11-27): bench is ported to Python (D1) |
| Memory store design | Deferred to Phase 9 ("Diferir a Fase 9 (Recommended)"); hybrid FTS + vector stays the leading idea; the RAM measurement is an input |

---

## 10. Out of scope

- Multi-host support.
- An own model runtime.
- Engram data import.
- Telemetry.
- Latency optimization.
