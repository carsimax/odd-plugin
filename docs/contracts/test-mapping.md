# Test mapping: internal-only tests to port, replace or drop

Phase 1 deliverable (`docs/roadmap-v10-python.md`, section 6). One row per `*.spec.ts` or `*.spec.tsx` file under `plugins/odd-claude/src` and `plugins/odd-claude/tui/src`, outside `src/contract/`. File paths are relative to `plugins/odd-claude/`. Black-box tests already moved to `src/contract/` in T1 and T2 and are not listed. The completeness test `src/conformance/test-mapping.spec.ts` checks that the set of files below equals the set on disk.

- `port`: the behavior lives inside a module and gets a pytest unit test in the phase named in the last column.
- `replace`: a contract test under `src/contract/` proves it. No file needs this today: every contract test that overlaps an internal file was already moved out of it, and what remains is in-process logic the contract suite does not reach.
- `drop`: it pins something TS-specific with no Python equivalent.
- Payload text checks (Markdown rules, skills, agents) read only repository files and do not depend on TS. They are `port` to phase 8: keep them as TS `node:test` and re-point their paths when the payload moves, rather than rewriting them in pytest.

| file | disposition | reason | phase |
|---|---|---|---|
| `src/cli/coordinator.spec.ts` | port | in-process coordinator command logic; contract/main.spec only covers entry errors | 5 |
| `src/cli/profiles.spec.ts` | port | in-process profiles command output and exit codes | 5 |
| `src/cli/review-mode.spec.ts` | port | in-process review-mode command logic; ported with the Phase 3 review engine, which it switches | 3 |
| `src/cli/scratch.spec.ts` | port | in-process scratch command logic | 5 |
| `src/cli/setup-errors.spec.ts` | port | setup error text, exit codes and --help text must match v9 in the Python CLI | 5 |
| `src/cli/setup.spec.ts` | port | in-process setup command planning and output | 5 |
| `src/cli/stats.spec.ts` | port | in-process stats command output; ported in Phase 4, hook tests spawn it | 4 |
| `src/cli/tasks.spec.ts` | port | feature-document lint command output and exit codes; ported in Phase 4, hook tests spawn it | 4 |
| `src/conformance/always-on-context.spec.ts` | port | payload text check over rules Markdown; language-agnostic, keep as TS node:test and re-point paths | 8 |
| `src/conformance/context-flags.spec.ts` | port | payload text check over rules and skills Markdown; language-agnostic, keep as-is | 8 |
| `src/conformance/contract.spec.ts` | port | canonical JSON and domain hash vectors are in-process; black-box twin is contract/contract.spec.ts | 3 |
| `src/conformance/delivery-default.spec.ts` | port | payload text check over rules Markdown; language-agnostic, keep as-is | 8 |
| `src/conformance/escalation.spec.ts` | port | payload text check over rules Markdown; language-agnostic, keep as-is | 8 |
| `src/conformance/payload-manifest.spec.ts` | port | payload frontmatter and hooks.json checks; adapt to the v10 payload layout | 8 |
| `src/conformance/plan-check.spec.ts` | port | payload text check over the plan-check agent and rules; language-agnostic, keep as-is | 8 |
| `src/conformance/rules-from-cards.spec.ts` | port | rules byte budget and always-on checks; runs the TS installer to build rules, re-point in Phase 8 | 8 |
| `src/conformance/skill-descriptions.spec.ts` | port | payload text check over skill descriptions; language-agnostic, keep as-is | 8 |
| `src/conformance/skill-references.spec.ts` | port | payload text check over skill references; language-agnostic, keep as-is | 8 |
| `src/conformance/standing-consent.spec.ts` | port | payload text check over rules Markdown; language-agnostic, keep as-is | 8 |
| `src/conformance/test-mapping.spec.ts` | port | completeness check over this document; language-agnostic, keep as TS node:test | 8 |
| `src/conformance/tools-guidance.spec.ts` | port | payload text check over rules and agents Markdown; language-agnostic, keep as-is | 8 |
| `src/conformance/verify-sensitive.spec.ts` | port | payload text check over verifier text; language-agnostic, keep as-is | 8 |
| `src/conformance/workflow-4r-review.spec.ts` | port | payload text check over the review workflow skill; language-agnostic, keep as-is | 8 |
| `src/hooks/lazy-load.spec.ts` | drop | asserts TS module loading through an `--import` probe (lines 34 and 77); Python has no equivalent; hook behavior is covered by contract/run.spec.ts and contract/stop.spec.ts | - |
| `src/hooks/lazy.spec.ts` | drop | pins the TS lazy registry and its eager twin (`runHookLazy` vs `runHook`); Python has one dispatcher; fail-safe behavior is covered by contract/run.spec.ts | - |
| `src/hooks/lifecycle.spec.ts` | port | SessionStart, UserPromptSubmit, Stop, SessionEnd and StopFailure handler effects on scratch, status and title | 4 |
| `src/hooks/post-tool-use.spec.ts` | port | in-process exploration counter and notice logic; CLI and parallel cases moved to contract/post-tool-use.spec.ts | 4 |
| `src/hooks/run.spec.ts` | port | in-process dispatch, fail-safe and hooks.json registration; spawn cases moved to contract/run.spec.ts | 4 |
| `src/hooks/session-end.spec.ts` | port | SessionEnd handler behavior | 4 |
| `src/hooks/session-start.spec.ts` | port | SessionStart handler context and state writes | 4 |
| `src/hooks/stop-failure.spec.ts` | port | StopFailure classification and advisory arming | 4 |
| `src/hooks/stop.spec.ts` | port | in-process Stop block and silence rules; concurrency case moved to contract/stop.spec.ts | 4 |
| `src/installer/args.spec.ts` | port | installer argument parsing | 6 |
| `src/installer/builtin-plugins.spec.ts` | port | installer built-in plugin handling | 6 |
| `src/installer/claude-ai.spec.ts` | port | claude.ai defaults written into settings | 6 |
| `src/installer/claude-md.spec.ts` | port | managed CLAUDE.md block writes | 6 |
| `src/installer/cli.spec.ts` | port | installer CLI behavior | 6 |
| `src/installer/core.spec.ts` | port | installer core file and manifest logic | 6 |
| `src/installer/deps.spec.ts` | port | dependency probes; bootstrap changes from node and npm to uv and gh | 6 |
| `src/installer/extras.spec.ts` | port | installer extras | 6 |
| `src/installer/files.spec.ts` | port | installer file copy and backup logic | 6 |
| `src/installer/hooks-config.spec.ts` | port | settings.json hook rewrite; the command shape changes to the Python entry | 6 |
| `src/installer/managed-settings.spec.ts` | port | managed settings.json writes | 6 |
| `src/installer/mcp.spec.ts` | port | settings.json MCP server entry; the command shape changes to the Python entry | 6 |
| `src/installer/orchestrate.spec.ts` | port | install, update and rollback orchestration | 6 |
| `src/installer/plugin-migration.spec.ts` | port | plugin to installer migration; extended for v9 to v10 | 6 |
| `src/installer/statusline.spec.ts` | port | statusLineChanges and payload shipping; script cases moved to contract/statusline.spec.ts | 6 |
| `src/installer/update.spec.ts` | port | update flow | 6 |
| `src/lib/advisory-notices.spec.ts` | port | advisory notice state and text; ports with phase 4: imported by hooks | 4 |
| `src/lib/agent-status.spec.ts` | port | agent status persisted format; fixtures in test-fixtures/contracts/; ports with phase 4: imported by hooks | 4 |
| `src/lib/agents-frontmatter.spec.ts` | port | agent files must match profile roles (PRESETS); follows the profiles module; ports with phase 6: no code importer; checks the agent files the installer ships | 6 |
| `src/lib/agents-guard.spec.ts` | port | payload text check over agents Markdown; language-agnostic, keep as-is | 8 |
| `src/lib/background-subagents.spec.ts` | port | background subagent policy | 2 |
| `src/lib/codegraph-trust.spec.ts` | port | trusted-project list persistence; ports with phase 4: used by session-integrations (hooks) and CLIs | 4 |
| `src/lib/codegraph.spec.ts` | port | codegraph helper logic; ports with phase 4: used by session-integrations (hooks) and CLIs | 4 |
| `src/lib/context-backstop.spec.ts` | port | context backstop thresholds and transcript tail | 2 |
| `src/lib/context.spec.ts` | port | session context lines | 2 |
| `src/lib/debug-feedback.spec.ts` | port | payload text check pinning rule phrases; language-agnostic, keep as-is | 8 |
| `src/lib/deny-profile.spec.ts` | port | deny profile logic; ports with phase 5: imported only by cli/setup | 5 |
| `src/lib/doctor.spec.ts` | port | doctor checks; checks python and uv instead of node | 2 |
| `src/lib/feature-doc.spec.ts` | port | feature-document lint | 2 |
| `src/lib/lock.spec.ts` | port | lock semantics: exclusive create, stale takeover, owned release | 2 |
| `src/lib/no-deny.spec.ts` | port | scans shipped hook code for deny decisions; re-point the scan at the Python hook sources | 4 |
| `src/lib/pid.spec.ts` | port | pid liveness and EPERM and ESRCH handling | 2 |
| `src/lib/pressure-testing.spec.ts` | port | payload text check pinning rule phrases; language-agnostic, keep as-is | 8 |
| `src/lib/profiles.spec.ts` | port | profile presets and roles | 2 |
| `src/lib/quota.spec.ts` | port | quota logic | 2 |
| `src/lib/retro-skill.spec.ts` | port | payload text check over the retro skill; language-agnostic, keep as-is | 8 |
| `src/lib/retro.spec.ts` | port | retro transcript analysis; CLI case moved to contract/retro.spec.ts | 2 |
| `src/lib/root.spec.ts` | port | plugin root resolution; ports with phase 4: imported by hooks/stop | 4 |
| `src/lib/rule-hardening.spec.ts` | port | payload text check pinning rule phrases; language-agnostic, keep as-is | 8 |
| `src/lib/scratch.spec.ts` | port | scratch directory creation and sweep; fixtures in test-fixtures/contracts/ | 2 |
| `src/lib/session-integrations.spec.ts` | port | session integration detection; ports with phase 4: imported by hooks/session-start | 4 |
| `src/lib/setup-safety.spec.ts` | port | setup safety checks; ports with phase 5: tests setup-fs, used only by cli/setup | 5 |
| `src/lib/setup.spec.ts` | port | setup settings logic; ports with phase 5: imported by cli/setup and the installer; CLI is earlier | 5 |
| `src/lib/simplify.spec.ts` | port | repo-state checks that removed files and README text stay absent; language-agnostic, keep as-is; hook-runner case moved to contract/simplify.spec.ts | 8 |
| `src/lib/skill-registry.spec.ts` | port | skill registry writer; ports with phase 4: used by session-integrations (hooks) and the CLI | 4 |
| `src/lib/skills-guard.spec.ts` | port | payload text check over skills Markdown; language-agnostic, keep as-is | 8 |
| `src/lib/state.spec.ts` | port | session and plugin state persistence; fixtures in test-fixtures/contracts/ | 2 |
| `src/lib/stats.spec.ts` | port | stats aggregation | 2 |
| `src/lib/status.spec.ts` | port | status computation; ports with phase 4: imported by hooks/stop, the CLI and MCP | 4 |
| `src/lib/subagents.spec.ts` | port | subagent recording | 2 |
| `src/lib/system.spec.ts` | port | reads installed_plugins.json under CLAUDE_CONFIG_DIR | 2 |
| `src/lib/terminal.spec.ts` | port | terminal title escape sequence; ports with phase 4: imported by hooks | 4 |
| `src/lib/verify-calibration.spec.ts` | port | payload text check pinning rule phrases; language-agnostic, keep as-is | 8 |
| `src/lib/version.spec.ts` | port | plugin version lookup; reads pyproject.toml instead of package.json; ports with phase 5: imported only by cli/status and cli/doctor | 5 |
| `src/mcp/concise.spec.ts` | port | review_status detail concise and full output and schema | 3 |
| `src/mcp/review-server.spec.ts` | port | in-process protocol, schema validation and review_assess cases; stdio cases moved to contract/review-server.spec.ts | 3 |
| `src/review/ack.spec.ts` | port | acknowledgement logic | 3 |
| `src/review/artifact.spec.ts` | port | review artifact handling | 3 |
| `src/review/boot-id.spec.ts` | port | boot id lookup | 3 |
| `src/review/canonical.spec.ts` | port | canonical JSON and hashing | 3 |
| `src/review/capture.spec.ts` | port | reviewer output capture | 3 |
| `src/review/consent.spec.ts` | port | consent binding and drift | 3 |
| `src/review/contract.spec.ts` | port | in-process review envelope shapes | 3 |
| `src/review/gate.spec.ts` | port | delivery gate advisory notice | 3 |
| `src/review/lineage.spec.ts` | port | review lineage | 3 |
| `src/review/live-lineage-fixture.spec.ts` | port | frozen lineage vectors; the Python lineage must reproduce them | 3 |
| `src/review/lock-host.spec.ts` | port | review lock host identity | 3 |
| `src/review/lock-race.spec.ts` | port | review lock race handling | 3 |
| `src/review/lock.spec.ts` | port | review lock semantics | 3 |
| `src/review/machine-id.spec.ts` | port | machine id lookup | 3 |
| `src/review/mode.spec.ts` | port | review mode switch | 3 |
| `src/review/reviewer-model.spec.ts` | port | reviewer model selection | 3 |
| `src/review/risk.spec.ts` | port | risk classification | 3 |
| `src/review/run.spec.ts` | port | review run orchestration | 3 |
| `src/review/runner.spec.ts` | port | reviewer process runner | 3 |
| `src/review/schema.spec.ts` | port | review schema validation; version mismatch must reject as in v9 | 3 |
| `src/review/snapshot.spec.ts` | port | candidate snapshot | 3 |
| `src/review/start.spec.ts` | port | review start and forecast | 3 |
| `src/review/state.spec.ts` | port | pure review state machine | 3 |
| `src/review/status.spec.ts` | port | review status next_transition | 3 |
| `src/review/store.spec.ts` | port | revision-CAS store; fixtures in test-fixtures/contracts/ | 3 |
| `tui/src/app.spec.tsx` | drop | renders Ink components in-process; Phase 7 writes new Textual pilot tests for the flows instead of porting these | - |
| `tui/src/services.spec.ts` | port | services calling installer functions; re-written against the Python installer | 7 |
