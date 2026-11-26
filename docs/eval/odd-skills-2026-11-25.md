# odd-skills eval (POC measurement), 2026-11-25

Runner and design: [README](README.md). Previous round (plugin arms, same 6 tasks): [hard tasks](hard-2026-11-25.md). Distribution under test: [`odd-skills/`](../../odd-skills/README.md) at commit f7424b8 (payload 053d6b6). Raw data: [`odd-skills-2026-11-25/opus-runs.jsonl`](odd-skills-2026-11-25/opus-runs.jsonl), [`sonnet-runs.jsonl`](odd-skills-2026-11-25/sonnet-runs.jsonl) (36 records each), runner reports [`opus-report.md`](odd-skills-2026-11-25/opus-report.md), [`sonnet-report.md`](odd-skills-2026-11-25/sonnet-report.md). Task descriptions: [`bench/eval-tasks-hard/README.md`](../../bench/eval-tasks-hard/README.md). Raw streams are not in git.

## Conclusion

- **Q1, does odd-skills keep outcomes while costing less than the plugin?** Cheaper: yes. Outcomes kept: not shown. With Opus, `skills` cost +37% over `none` (mean; +24% median) against +52% for the plugin's `coord-off` and +70% for `coord-on` (each vs its own `none`). In absolute terms `skills` was 7% below `coord-off` and 17% below `coord-on` in mean cost, 21% and 24% below in median cost, and 29% below `coord-on` in tokens (equal to `coord-off`, -2%). But `skills` passed 17/18 against 18/18 for `none` and for every plugin arm. The single miss (`async-notes.skills.2`) is not a coding failure: the agent loaded the `odd` skill, classified the work as large, edited nothing and stopped to ask the user three questions in a run with no user (see Failure analysis). One miss in 18 is statistically indistinguishable from none (the data cannot separate 17/18 from 18/18), but it is a real behavior the design produces in unattended runs, so "outcomes kept" holds for attended work only as an untested assumption.
- **Q2, does odd-skills improve outcomes with Sonnet as main model?** No. `none` and `skills` both passed 18/18 on both checks. The smoke hint (Sonnet `none` tripped a regression check on `duration-report` once, `skills` passed) did not replicate: `duration-report` was 3/3 in both arms, and no Sonnet run failed anywhere in 36. `skills` cost +22% (tokens +30%, wall +12%) with Sonnet.
- **odd-skills mostly did not engage.** The `odd` skill loaded in 3 of 36 `skills` runs, all Opus, all `async-notes`. Sonnet never loaded a skill or launched an agent. So most of the measured cost is the always-loaded `CLAUDE.md`, skill/agent listings and extra turns (Opus turns +3.6 per run, cache-creation tokens +4k per run, on the five tasks where the skill never loaded), not delegation.
- **Ceiling effect again.** Both models pass every task without help (Opus `none` 18/18, Sonnet `none` 18/18), so these tasks cannot show a benefit of the workflow, only its cost and its unattended-run risks.
- Bounded by n=3 per cell, same tasks, one CLI version (see Caveats).

## Setup

- Tasks: the 6 hard tasks of [hard-2026-11-25](hard-2026-11-25.md) (invoice-rounding, duration-report, text-table, commit-lint, async-notes, event-rename), two hidden checks each (`acceptance`, `regression`); `passed` needs both.
- Arms: `none` (plain Claude Code) and `skills` (`odd-skills/install.sh` into the run's private config dir, `--setting-sources user`, no plugin). 3 trials. Two invocations, one per main model: `npm run eval -- --tasks-dir bench/eval-tasks-hard --arms none,skills --trials 3 --model <opus|sonnet> --max-budget-usd 4 --total-budget-usd 50`. 2 x 36 = 72 runs.
- Models: `opus` (claude-opus-5-5) and `sonnet` (claude-sonnet-5-5) as main; odd-skills agents pin their own models (odd-explore haiku, odd-worker sonnet, odd-verify opus). Claude Code 2.1.332.
- Validity: 72 runs, 0 `error`, 0 `invalid`, 0 timeouts; every `skills` record has `skills_installed: true` and the `odd-worker` agent in the init message.
- Smoke before the run (`duration-report`, 1 run per cell): Opus `none` and `skills` both passed, USD 0.262 each; Sonnet `none` tripped the regression check (USD 0.062), Sonnet `skills` passed (USD 0.114).
- Spend (API-equivalent `total_cost_usd`; auth was a subscription): Opus 11.81, Sonnet 4.54 USD for the 72 runs.
- Isolation, re-verified after the run: the real `~/.claude/settings.json` sha1 is unchanged, the plugins/data list is unchanged, no odd-skills files in `~/.claude/skills` or `~/.claude/agents`, no leftover temp workspaces (three leftovers from an earlier killed spec run were removed; they were not part of the measurement).

## Results per model and arm

Cells: mean / median / sample stdev, n=18 per cell.

| model | arm | pass | acceptance | regression | cost USD | tokens | wall s | subagents | visible tests edited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| opus | none | 18/18 | 18/18 | 18/18 | 0.277 / 0.248 / 0.076 | 168,342 / 173,723 / 38,505 | 50.8 / 41.9 / 17.8 | 0.00 / 0.00 / 0.00 | 12 |
| opus | skills | 17/18 | 17/18 | 17/18 | 0.379 / 0.307 / 0.274 | 288,785 / 227,644 / 214,410 | 67.0 / 49.0 / 61.4 | 0.06 / 0.00 / 0.24 | 11 |
| sonnet | none | 18/18 | 18/18 | 18/18 | 0.114 / 0.116 / 0.036 | 130,801 / 131,192 / 29,447 | 30.0 / 29.0 / 10.2 | 0.00 / 0.00 / 0.00 | 8 |
| sonnet | skills | 18/18 | 18/18 | 18/18 | 0.139 / 0.138 / 0.031 | 170,685 / 163,394 / 36,647 | 33.6 / 31.1 / 9.8 | 0.00 / 0.00 / 0.00 | 12 |

Total cost: opus none 4.98, skills 6.83; sonnet none 2.05, skills 2.50 USD.

Deltas of `skills` vs `none` (same model, same invocation):

| model | cost mean | cost median | tokens mean | tokens median | wall mean | wall median |
| --- | --- | --- | --- | --- | --- | --- |
| opus | +37% | +24% | +72% | +31% | +32% | +17% |
| opus, without `async-notes` | +24% | n/a | +48% | n/a | +16% | n/a |
| sonnet | +22% | +20% | +30% | +25% | +12% | +7% |

The Opus mean is pulled up by `async-notes` (the three `skills` runs cost 0.499, 0.262 and 1.451 USD; the last one is the only run with a subagent, 1.10M tokens and 308 s). The other five tasks cost +24% in cost, +48% in tokens, +16% in wall over `none` with the skill not loaded in any of those 15 runs. For Sonnet the overhead is the same with no skill loaded in any run.

## Comparison with the plugin arms (Opus)

Plugin numbers are the effective view of [hard-2026-11-25](hard-2026-11-25.md) (earlier session, same 6 tasks, same model, 18 runs per arm; its `none` cost 0.268 vs 0.277 here, so the two windows are close but not paired).

| arm | pass | cost USD (mean / median) | tokens (mean) | wall s (mean) | subagents (mean) | cost vs own `none` | tokens vs own `none` | wall vs own `none` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none (hard round) | 18/18 | 0.268 / 0.248 | 164,667 | 49.0 | 0.00 | n/a | n/a | n/a |
| coord-off | 18/18 | 0.407 / 0.390 | 293,233 | 76.4 | 0.00 | +52% | +78% | +56% |
| coord-on | 18/18 | 0.455 / 0.404 | 408,563 | 95.5 | 1.06 | +70% | +148% | +95% |
| none (this round) | 18/18 | 0.277 / 0.248 | 168,342 | 50.8 | 0.00 | n/a | n/a | n/a |
| skills | 17/18 | 0.379 / 0.307 | 288,785 | 67.0 | 0.06 | +37% | +72% | +32% |

odd-skills is cheaper than `coord-on` on every metric and than `coord-off` on cost, wall and (marginally) tokens, mainly because it rarely delegates (1 subagent in 18 runs against 1.06 per run for `coord-on`). It still carries a cost over `none` of +24% to +37% in cost for a measured outcome gain of zero on these tasks, and the plugin comparison is across two sessions, not paired.

## Results per task (per model and arm)

Cells: pass (3 trials) / mean cost USD / mean tokens / mean wall s.

### Opus

| task | none | skills |
| --- | --- | --- |
| invoice-rounding | 3/3 / 0.210 / 169k / 37 | 3/3 / 0.278 / 216k / 46 |
| duration-report | 3/3 / 0.250 / 185k / 40 | 3/3 / 0.299 / 294k / 46 |
| text-table | 3/3 / 0.310 / 160k / 67 | 3/3 / 0.360 / 229k / 70 |
| commit-lint | 3/3 / 0.226 / 105k / 44 | 3/3 / 0.274 / 153k / 49 |
| async-notes | 3/3 / 0.420 / 199k / 80 | 2/3 / 0.737 / 536k / 142 |
| event-rename | 3/3 / 0.245 / 189k / 37 | 3/3 / 0.329 / 302k / 49 |

### Sonnet

| task | none | skills |
| --- | --- | --- |
| invoice-rounding | 3/3 / 0.061 / 94k / 15 | 3/3 / 0.099 / 178k / 21 |
| duration-report | 3/3 / 0.089 / 146k / 23 | 3/3 / 0.116 / 171k / 26 |
| text-table | 3/3 / 0.135 / 127k / 39 | 3/3 / 0.154 / 144k / 43 |
| commit-lint | 3/3 / 0.121 / 107k / 33 | 3/3 / 0.136 / 121k / 36 |
| async-notes | 3/3 / 0.169 / 138k / 43 | 3/3 / 0.190 / 206k / 46 |
| event-rename | 3/3 / 0.108 / 169k / 26 | 3/3 / 0.136 / 202k / 29 |

Acceptance and regression equal the pass count in every cell (the only failing run failed both checks).

## Behavior counts (from the streams)

Counted over the main session's tool calls of all 72 runs (n=18 per model and arm).

| model | arm | loaded the `odd` skill | other skills | launched Agent subagents | created `odd/tasks/` doc | ended by asking questions |
| --- | --- | --- | --- | --- | --- | --- |
| opus | none | 0 | 0 | 0 | 0 | 0 |
| opus | skills | 3 (async-notes 1, 2, 3) | 0 | 1 (async-notes.3: one `odd-verify`, opus, high effort) | 2 (async-notes.1 and .3; `.3` wrote `odd/tasks/async-store.md`) | 1 (async-notes.2) |
| sonnet | none | 0 | 0 | 0 | 0 | 0 |
| sonnet | skills | 0 | 0 | 0 | 0 | 0 |

Run-level detail for the three Opus runs that loaded the skill:

- `async-notes.skills.1` (passed, USD 0.499): loaded the skill, created the feature doc, made 13 edits, never ran tests; final message says Bash was blocked.
- `async-notes.skills.2` (failed, USD 0.262): loaded the skill, 0 edits, asked 3 questions (Failure analysis).
- `async-notes.skills.3` (passed, USD 1.451): loaded the skill, created the doc, ran `npm test` through the RED to GREEN cycle (so `Bash(npm *)` was usable), launched one `odd-verify` subagent, 27 edits.

Not counted as "asking": final messages that ask the user to run the tests afterwards (see next section).

## Failure analysis: `async-notes.skills.2` (Opus)

The only failing run of the 72 (acceptance false, regression false, USD 0.262, 37 s, 0 edits, 0 subagents). Sequence in its stream:

1. First tool call, a read-everything command: `git ls-files && cat package.json && for f in $(git ls-files 'src/*' 'test/*' 'bin/*' '*.js'); do echo "=== $f"; cat "$f"; done`. The tool result was an error: "Permission to use Bash has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat. But you *should not* attempt to work around this denial ..." The result message's `permission_denials` holds exactly this one entry.
2. It fell back to `Glob` and 13 `Read` calls, read the whole codebase, then called `Skill` with `odd` and the task description ("Touches public contract and introduces concurrency ...").
3. It edited nothing and ended with a message that classified the work as large, asked three questions and promised to proceed after the answers: (1) "I can't run anything. The shell is denied in this session, so I can't run `npm test`. My workflow requires watching the tests fail ... Can you allow `npm test` (or the shell generally)?", (2) which concurrency option for the read-modify-write races, with a recommendation, (3) whether `applyOps` stays sequential, with a recommendation.

Root cause, two parts:

- **Harness permission artifact (not the guard hook).** The eval runs with `--permission-mode dontAsk` and `--allowedTools "Agent,Read,Edit,Write,Glob,Grep,Bash(node *),Bash(npm *),Bash(git *)"` (`bench/src/eval/argv.ts:4`). The denied command starts with `git`, but it chains `&&` and contains a `for` loop with `cat` and a `$(...)` substitution; `cat` is not allowed, so the whole command is denied. It was not the guard hook (`odd-skills/hooks/guard.sh`): the denial text is Claude Code's don't-ask mode, and `npm test` was never attempted in this run. The agent then generalized one denied compound command into "the shell is denied in this session, so I can't run `npm test`", which the allow-list does permit (`async-notes.skills.3` ran `npm test` repeatedly and passed it).
- **Unattended-run "ask" penalty.** Given that belief, the `odd` skill's protocol (large work, test-first, ask when there are choices) led the agent to stop and ask instead of proceeding with stated assumptions. A human would have answered; in `-p` no one can, so the run ended with no change. This is the odd-skills design producing a stop in a non-interactive setting, not a coding error.

The artifact is common to both arms and both models, not specific to `skills`: runs with at least one permission denial (all in Bash, mostly `cat`, `sed`, `for`, `cd`, `git` compound commands): opus none 13/18, opus skills 14/18, sonnet none 16/18, sonnet skills 18/18. In a keyword scan of final messages (approximate; the pattern also matches a few false positives), agents told the user they could not run the tests in about 7 opus `none`, 6 opus `skills`, 16 sonnet `none` and 15 sonnet `skills` runs, yet nearly all of them still edited the code and passed the hidden checks. The same harness issue made Sonnet's `none` and `skills` runs mostly unverified by the agent itself, which is a caveat for any claim about test-first discipline in this round. The skill's differing response (stop and ask) in one run is what turned the artifact into a failure.

Other `skills` run with the same belief and different outcome: `async-notes.skills.1` (same denied command, then 13 edits without running tests, passed) and Sonnet `commit-lint.skills.3` (wrote code and tests, said it could not run them, passed).

## Caveats

- n=3 per cell, 18 per arm. At 17/18 vs 18/18 and 18/18 vs 18/18 nothing separates the arms in outcome; the 95% upper bound of a miss rate with 0 misses in 18 is about 17% (rule of three).
- The same 6 tasks as the plugin rounds. Opus is at the ceiling (18/18 in `none`) and Sonnet is also at the ceiling here (18/18 in `none`), so neither model leaves room to show an outcome benefit.
- The permission allow-list blocks many compound read commands in both arms (above), so the runs exercise a degraded, unattended tool environment; absolute behavior (asking, skipping tests) may differ in a normal session.
- Unattended runs penalize asking: any workflow that stops for a human answer scores a failure here, which a real session would not.
- Plugin comparison uses numbers from an earlier session (Opus `none` mean cost 0.268 vs 0.277 now), so it is an across-session comparison.
- Tasks were authored by an LLM worker and validated only by selfcheck. Pass/fail only; no review of diff or test quality.
- One CLI version (2.1.332), one prompt per task, nondeterministic runs, API-equivalent cost on a subscription, no engram memory in any arm.
- The count of final messages that claim "could not run tests" is a keyword scan, not a graded check; the permission-denial counts come from the `result` messages.

## Next steps (recommendations, not done)

1. Make the `odd` skill and the coordinator `CLAUDE.md` treat unattended or non-interactive runs (no human to answer) as "proceed with stated assumptions": ask only when a wrong guess is costly and irreversible, and otherwise record the assumption in the feature doc and continue. Then re-measure `async-notes` on Opus; that is the one cell that failed.
2. Fix or document the eval's permission artifact (allow-list patterns for compound read commands, or tell agents to use `Read`/`Grep`) before the next round, so test-first behavior is observable and the agents do not conclude the whole shell is denied. Changing it affects comparability with earlier rounds.
3. Harder tasks for Sonnet and Haiku (long-horizon, ambiguous specs, larger repos) where `none` does not already pass 18/18; only there can a workflow show an outcome benefit.
4. Haiku as main model, with the same arms, where discipline has the most room to matter.
5. Reduce the always-loaded cost: on the 30 runs where nothing loaded, `skills` still cost +24% to +25% over `none`, which comes from `CLAUDE.md`, the skill and agent listings and extra turns. Measure which of these contributes before trimming.
6. For the human to decide, not a recommendation to switch: whether to adopt odd-skills as the default distribution instead of the plugin. The evidence supports "cheaper than the plugin" and does not support "better outcomes than plain Claude Code" for either model on these tasks.
