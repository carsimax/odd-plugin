# py-06: language-neutral contract harness feasibility

Spec: `odd/tasks/py-phase0-spikes.md` T6, S6, S8. Throwaway spike; nothing under `plugins/` was edited.

## Result

**Verdict: feasible, with a sizeable but mechanical prerequisite.** An `ODD_IMPL=ts|py` switch on the entry command works for process-boundary specs. Only 16 of 120 specs (13%) are black-box today, so Phase 1 must first extract or add contract specs; the other 104 pin TS internals and are not portable as-is.

### Classification

Method: `mcp__codegraph__codegraph_explore` for the testkits, then grep over `plugins/odd-claude/src/**/*.spec.ts` and `plugins/odd-claude/tui/src/*.spec.ts*` (120 files) for `spawn`, `spawnSync`, `execFile*` and the `conformance/*.testkit.ts` harness. Rules:

- **Black-box**: spawns a product entry (a `dist/cli/*.js` CLI, `dist/hooks/run.js`, the MCP stdio server, `statusline.sh`, a release script) or drives it through `harness.testkit.ts`, and asserts on stdout/stderr/exit code/files.
- **Internal**: everything else. Spawning only `git`, `mkfifo`, `sleep`, or `node -e`/testkit children that import a TS module is scaffolding, not a product boundary.
- The classification is a grep heuristic plus spot reads of the entry-spawning lines (`main.spec.ts`, the hook, MCP and harness callers), not a per-test review.

| Class | Specs |
|---|---|
| Black-box, no internal imports (pure) | 3 |
| Black-box, but also imports internals for setup or extra in-process tests (mixed) | 13 |
| Black-box total | 16 |
| Internal | 104 (includes both `tui/src` specs, which render Ink in-process) |

Pure black-box:
- `plugins/odd-claude/src/cli/main.spec.ts`
- `plugins/odd-claude/src/lib/check-naming.spec.ts`
- `plugins/odd-claude/src/review/vendor-naming.spec.ts`

Mixed black-box:
- `plugins/odd-claude/src/conformance/concurrency.spec.ts`
- `plugins/odd-claude/src/conformance/contract.spec.ts`
- `plugins/odd-claude/src/conformance/crash.spec.ts`
- `plugins/odd-claude/src/conformance/lifecycle.spec.ts`
- `plugins/odd-claude/src/hooks/lazy-load.spec.ts`
- `plugins/odd-claude/src/hooks/post-tool-use.spec.ts`
- `plugins/odd-claude/src/hooks/run.spec.ts`
- `plugins/odd-claude/src/hooks/stop.spec.ts`
- `plugins/odd-claude/src/installer/release-scripts.spec.ts`
- `plugins/odd-claude/src/installer/statusline.spec.ts`
- `plugins/odd-claude/src/lib/retro.spec.ts`
- `plugins/odd-claude/src/lib/simplify.spec.ts`
- `plugins/odd-claude/src/mcp/review-server.spec.ts`

Internal (104), per directory:

- `src/cli/`: 8
- `src/conformance/`: 13
- `src/hooks/`: 5
- `src/installer/`: 15
- `src/lib/`: 36
- `src/mcp/`: 1
- `src/review/`: 24
- `tui/src/`: 2

Internal file list:

```text
src/cli/coordinator.spec.ts
src/cli/profiles.spec.ts
src/cli/review-mode.spec.ts
src/cli/scratch.spec.ts
src/cli/setup-errors.spec.ts
src/cli/setup.spec.ts
src/cli/stats.spec.ts
src/cli/tasks.spec.ts
src/conformance/always-on-context.spec.ts
src/conformance/context-flags.spec.ts
src/conformance/delivery-default.spec.ts
src/conformance/escalation.spec.ts
src/conformance/payload-manifest.spec.ts
src/conformance/plan-check.spec.ts
src/conformance/rules-from-cards.spec.ts
src/conformance/skill-descriptions.spec.ts
src/conformance/skill-references.spec.ts
src/conformance/standing-consent.spec.ts
src/conformance/tools-guidance.spec.ts
src/conformance/verify-sensitive.spec.ts
src/conformance/workflow-4r-review.spec.ts
src/hooks/lazy.spec.ts
src/hooks/lifecycle.spec.ts
src/hooks/session-end.spec.ts
src/hooks/session-start.spec.ts
src/hooks/stop-failure.spec.ts
src/installer/args.spec.ts
src/installer/builtin-plugins.spec.ts
src/installer/claude-ai.spec.ts
src/installer/claude-md.spec.ts
src/installer/cli.spec.ts
src/installer/core.spec.ts
src/installer/deps.spec.ts
src/installer/extras.spec.ts
src/installer/files.spec.ts
src/installer/hooks-config.spec.ts
src/installer/managed-settings.spec.ts
src/installer/mcp.spec.ts
src/installer/orchestrate.spec.ts
src/installer/plugin-migration.spec.ts
src/installer/update.spec.ts
src/lib/advisory-notices.spec.ts
src/lib/agent-status.spec.ts
src/lib/agents-frontmatter.spec.ts
src/lib/agents-guard.spec.ts
src/lib/background-subagents.spec.ts
src/lib/codegraph-trust.spec.ts
src/lib/codegraph.spec.ts
src/lib/context-backstop.spec.ts
src/lib/context.spec.ts
src/lib/debug-feedback.spec.ts
src/lib/deny-profile.spec.ts
src/lib/doctor.spec.ts
src/lib/feature-doc.spec.ts
src/lib/lock.spec.ts
src/lib/no-deny.spec.ts
src/lib/pid.spec.ts
src/lib/pressure-testing.spec.ts
src/lib/profiles.spec.ts
src/lib/quota.spec.ts
src/lib/retro-skill.spec.ts
src/lib/root.spec.ts
src/lib/rule-hardening.spec.ts
src/lib/scratch.spec.ts
src/lib/session-integrations.spec.ts
src/lib/setup-safety.spec.ts
src/lib/setup.spec.ts
src/lib/skill-registry.spec.ts
src/lib/skills-guard.spec.ts
src/lib/state.spec.ts
src/lib/stats.spec.ts
src/lib/status.spec.ts
src/lib/subagents.spec.ts
src/lib/system.spec.ts
src/lib/terminal.spec.ts
src/lib/verify-calibration.spec.ts
src/lib/version.spec.ts
src/mcp/concise.spec.ts
src/review/ack.spec.ts
src/review/artifact.spec.ts
src/review/boot-id.spec.ts
src/review/canonical.spec.ts
src/review/capture.spec.ts
src/review/consent.spec.ts
src/review/contract.spec.ts
src/review/gate.spec.ts
src/review/lineage.spec.ts
src/review/lock-host.spec.ts
src/review/lock-race.spec.ts
src/review/lock.spec.ts
src/review/machine-id.spec.ts
src/review/mode.spec.ts
src/review/reviewer-model.spec.ts
src/review/risk.spec.ts
src/review/run.spec.ts
src/review/runner.spec.ts
src/review/schema.spec.ts
src/review/snapshot.spec.ts
src/review/start.spec.ts
src/review/state.spec.ts
src/review/status.spec.ts
src/review/store.spec.ts
tui/src/app.spec.tsx
tui/src/services.spec.ts
```

Notes on the internal class: `conformance/payload-manifest`, `skill-descriptions`, `skill-references`, `tools-guidance` and similar read payload files (rules, skills, cards) and are language-neutral in spirit (file content assertions) but import TS helpers to locate them; they can move to the harness as pure file checks.

### Run evidence

Picked `plugins/odd-claude/src/cli/main.spec.ts` (spawns `dist/cli/{coordinator,setup,status}.js`, imports nothing internal). Copy: `main.contract.spec.mjs`; only `entry()` differs (ts resolves to `plugins/odd-claude/dist/cli/<cli>.js` run with `process.execPath`; py is a placeholder `sh -c` that prints `ODD_IMPL=py: no Python port of odd-<cli> exists yet` to stderr and exits 97).

- `ODD_IMPL=ts node --test spikes/py-06-contract-harness/main.contract.spec.mjs`: exit 0, 4 tests, 4 pass, 0 fail (uses the existing `dist/`, no build).
- `ODD_IMPL=py node --test spikes/py-06-contract-harness/main.contract.spec.mjs`: exit 1, 1 pass, 3 fail. The placeholder fails clearly where the spec expects success.

### Obstacles

1. **Negative tests pass vacuously.** The py placeholder still passes `S21` ("exits non-zero, stderr not empty"), so a red/green gate must also run a positive control or assert exact messages.
2. **Only 13% black-box.** Internal specs assert on TS functions and types; they do not carry over. Phase 1 needs to extract the observable behavior of internal specs into process-level specs before porting.
3. **Mixed specs import internals for setup.** The 13 mixed specs (for example `hooks/stop.spec.ts` with 9 internal imports, `mcp/review-server.spec.ts`) call TS fixtures and builders. The setup must be replaced by files and CLI calls, or the spec split into a black-box half and an internal half.
4. **Entry paths differ by suite.** `cli` and `hooks` specs resolve `dist/` relative to `dist-test/`; `harness.testkit.ts` spawns `dist-test/mcp/review-server.js` (the test build) and puts a fake `claude` first on PATH. An `ODD_IMPL` switch has to live in one resolver (the testkit) rather than in each spec; hand-written `spawnSync(process.execPath, [join(DIST, ...)])` calls (about 12 specs) need a rewrite to use it.
5. **Spec runner is coupled to the TS build.** `npm test` runs `tsc` twice into `dist` and `dist-test`, then `node --test dist-test/**/*.spec.js`. A language-neutral harness needs a plain-JS (or Python) runner that does not require the TS build; the spike's `.mjs` shows this works with `node --test`.
6. **Process-environment assumptions.** Specs scrub the environment to `PATH` plus a few variables, use temp git worlds, `mkfifo`, and fake `claude`; these are portable, but Python needs the same scrubbed env and the node-based `node` hook command shape (see py-04).
7. **Timing assumptions.** Concurrency, lock-race and crash specs use child processes, sleeps and `SIGKILL` timeouts (for example 10 s hang backstops); these are the least portable and should stay TS-internal or be re-derived for Python.
8. **Paths.** Specs hardcode `dist/...` names and the `dist/hooks/run.js` string inside fixtures (S23 asserts on it), so settings fixtures also depend on the implementation's command shape.

## Rerun

```sh
cd /Users/carsimax/Developer/03-PERSONAL/odd-claude
ODD_IMPL=ts node --test spikes/py-06-contract-harness/main.contract.spec.mjs   # expect exit 0, 4 pass
ODD_IMPL=py node --test spikes/py-06-contract-harness/main.contract.spec.mjs   # expect exit 1, 3 fail (placeholder)
```

Requires an existing `plugins/odd-claude/dist/` (run `cd plugins/odd-claude && npm run build` first if absent).
