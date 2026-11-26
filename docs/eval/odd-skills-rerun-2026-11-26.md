# odd-skills re-measurement after the permission fix (Sonnet and Haiku), 2026-11-26

Runner and design: [README](README.md). Previous round (same arms and tasks, Opus and Sonnet): [odd-skills 2026-11-25](odd-skills-2026-11-25.md). Plugin rounds: [pilot](pilot-2026-11-25.md), [hard tasks](hard-2026-11-25.md). Distribution under test: [`odd-skills/`](../../odd-skills/README.md) at commit d6b117d (sandboxed full shell for every arm, unattended-run and denied-command rules). Raw data: [`sonnet-runs.jsonl`](odd-skills-rerun-2026-11-26/sonnet-runs.jsonl) (36 records), [`haiku-runs.jsonl`](odd-skills-rerun-2026-11-26/haiku-runs.jsonl) (32 records, 9 of them `timeout`), [`haiku-reruns.jsonl`](odd-skills-rerun-2026-11-26/haiku-reruns.jsonl) (13 records); runner reports [`sonnet-report.md`](odd-skills-rerun-2026-11-26/sonnet-report.md), [`haiku-report.md`](odd-skills-rerun-2026-11-26/haiku-report.md) (the Haiku report covers the main invocation only, so it understates the effective set). Task descriptions: [`bench/eval-tasks-hard/README.md`](../../bench/eval-tasks-hard/README.md). Raw streams are not in git.

## Conclusion

- **Does odd-skills improve outcomes after the permission fix? No, for both models.** Sonnet: `none` 17/18, `skills` 15/18 (Fisher exact p = 0.60, not separable). All 3 misses of the 36 runs are the same trap, `duration-report` (regression check; acceptance is 18/18 in both arms): `none` 2/3, `skills` 0/3. Haiku: `none` 18/18, `skills` 18/18 (effective set, see Infra). So no improvement was measured, and on the only task that discriminated, odd-skills was not better; it was worse (0/3 vs 2/3, p = 0.40, n=3 per cell, so this is a direction, not a finding).
- **Why the Sonnet `skills` runs missed the trap** (stream analysis below): none of the 3 opened or searched `README.md` for constraints; all three changed the shared `formatDuration` and so changed the alert text that the README says a pager scrapes. The single `none` miss did the same. The two `none` runs that passed read the README (via a grep that matched it) and kept alerts on the old format. The `odd` skill was loaded in 0 of 18 Sonnet `skills` runs, so the extra rules and test-first discipline came only from the always-loaded `CLAUDE.md`; those runs wrote a failing test and made it pass, but the test only covered the new hours format, so discipline did not surface the trap.
- **Cost: `skills` costs more with both models.** Sonnet +25% mean (+30% median), tokens +39%, wall +25%, turns +29%. Haiku +32% mean (+25% median), tokens +83%, wall +26%, turns +36%. In absolute terms: Sonnet USD 0.105 to 0.131 per run, Haiku USD 0.0117 to 0.0154 per run.
- **The permission fix worked.** Runs with at least one permission denial: 0 of 72 effective runs (36 Sonnet, 36 Haiku) against 16/18 (Sonnet `none`) and 18/18 (Sonnet `skills`) in the previous round. Every record is `sandboxed: true`. The "denied shell, so stop and ask" failure of the previous round did not recur: no Sonnet or Haiku run ended by asking a question (Opus was not re-measured).
- **odd-skills mostly did not engage here either.** The `odd` skill loaded in 0 of 18 Sonnet `skills` runs and 2 of 18 Haiku `skills` runs (both `async-notes`, both passed, both wrote an `odd/tasks/` doc). No run launched a subagent.
- Bounded by n=3 per cell, a ceiling on 5 of 6 tasks for both models, one CLI version (see Caveats).

## Setup

- Tasks: the 6 hard tasks of [hard-2026-11-25](hard-2026-11-25.md), two hidden checks each (`acceptance`, `regression`); `passed` needs both.
- Arms: `none` and `skills` (`odd-skills/install.sh` into the run's private config dir, `--setting-sources user`, no plugin). Every arm now gets plain `Bash` in `--allowedTools` and the same native Bash sandbox through `--settings` (`sandbox.enabled`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands: false`, `failIfUnavailable`); see the README permissions section.
- Invocations: `npm run eval -- --tasks-dir bench/eval-tasks-hard --arms none,skills --trials 3 --model <sonnet|haiku> --max-budget-usd 3 --total-budget-usd 30`. Plan 36 runs per model.
- Smoke before the run (`duration-report`, 1 run per cell, not part of the 72): Sonnet `none` failed the regression check (USD 0.088), Sonnet `skills` passed (0.130), Haiku `none` passed (0.008), Haiku `skills` failed the regression check (0.007). 0 permission denials, sandboxed. The smoke already showed that this trap splits runs in both directions.
- Models: `sonnet` (claude-sonnet-5-5) and `haiku` as main model; odd-skills agents pin their own models. Claude Code 2.1.332.
- Validity: Sonnet 36 `ok`, 0 `error`, 0 `invalid`, spend USD 4.25. Haiku: see Infra; effective set 36 `ok`, 0 `invalid`. Every `skills` record has `skills_installed: true`.
- Spend (API-equivalent `total_cost_usd`, subscription auth): Sonnet 4.25 USD; Haiku effective 0.49 USD (main `ok` runs 0.30 + reruns 0.18; the runner's "27.30 USD" is its budget accounting, not spend, see Infra).
- Isolation, re-verified after the runs: the real `~/.claude/settings.json` sha1 is unchanged, no odd-skills files in `~/.claude/skills`, no leftover temp workspaces.

## Results per model and arm

Cells: mean / median / sample stdev, n=18 per cell. Haiku is the effective set (23 `ok` runs of the main invocation plus the 13 reruns).

| model | arm | pass | acceptance | regression | cost USD | tokens | wall s | turns | subagents | visible tests edited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sonnet | none | 17/18 | 18/18 | 17/18 | 0.105 / 0.100 / 0.027 | 142,604 / 114,948 / 68,182 | 21.2 / 22.4 / 7.2 | 6.1 / 5.5 / 1.8 | 0.00 | 10 |
| sonnet | skills | 15/18 | 18/18 | 15/18 | 0.131 / 0.131 / 0.026 | 198,040 / 216,312 / 63,298 | 26.4 / 26.4 / 8.9 | 7.8 / 7.0 / 2.8 | 0.00 | 12 |
| haiku | none | 18/18 | 18/18 | 18/18 | 0.0117 / 0.0109 / 0.0040 | 234,419 / 232,099 / 60,490 | 40.9 / 33.9 / 21.0 | 11.6 / 11.5 / 4.7 | 0.00 | 12 |
| haiku | skills | 18/18 | 18/18 | 18/18 | 0.0154 / 0.0136 / 0.0058 | 428,875 / 353,991 / 209,714 | 51.5 / 44.3 / 24.8 | 15.8 / 14.0 / 5.6 | 0.00 | 12 |

Total cost: sonnet none 1.89, skills 2.36; haiku none 0.21, skills 0.28 USD.

Deltas of `skills` vs `none` (same model):

| model | cost mean | cost median | tokens mean | tokens median | wall mean | turns mean |
| --- | --- | --- | --- | --- | --- | --- |
| sonnet | +25% | +30% | +39% | +88% | +25% | +29% |
| haiku | +32% | +25% | +83% | +53% | +26% | +36% |

For reference, previous round: Opus +37% cost mean, Sonnet +22%; plugin `coord-off` +52%, `coord-on` +70% (Opus). Haiku mean wall includes the effective runs only (the timed-out runs, 15 to 28 minutes each, are not in it).

## Results per task (per model and arm)

Cells: pass (3 trials) / mean cost USD / mean tokens / mean wall s.

### Sonnet

| task | none | skills |
| --- | --- | --- |
| invoice-rounding | 3/3 / 0.087 / 137k / 18 | 3/3 / 0.131 / 271k / 26 |
| duration-report | 2/3 / 0.083 / 118k / 14 | 0/3 / 0.112 / 218k / 19 |
| text-table | 3/3 / 0.123 / 126k / 30 | 3/3 / 0.158 / 204k / 38 |
| commit-lint | 3/3 / 0.108 / 96k / 24 | 3/3 / 0.128 / 119k / 26 |
| async-notes | 3/3 / 0.149 / 252k / 28 | 3/3 / 0.164 / 244k / 35 |
| event-rename | 3/3 / 0.081 / 127k / 12 | 3/3 / 0.094 / 132k / 14 |

### Haiku (effective set)

| task | none | skills |
| --- | --- | --- |
| invoice-rounding | 3/3 / 0.008 / 205k / 26 | 3/3 / 0.010 / 274k / 31 |
| duration-report | 3/3 / 0.009 / 216k / 27 | 3/3 / 0.011 / 323k / 30 |
| text-table | 3/3 / 0.018 / 307k / 77 | 3/3 / 0.024 / 558k / 95 |
| commit-lint | 3/3 / 0.014 / 252k / 56 | 3/3 / 0.016 / 419k / 59 |
| async-notes | 3/3 / 0.012 / 244k / 38 | 3/3 / 0.021 / 703k / 61 |
| event-rename | 3/3 / 0.008 / 182k / 21 | 3/3 / 0.011 / 297k / 33 |

Acceptance equals the pass count in every cell except Sonnet `duration-report`, where acceptance is 3/3 and regression 2/3 (`none`) and 0/3 (`skills`).

## Permission denials, before and after

Counted as runs with more than 0 entries in the result message's `permission_denials` (the previous round's records lack the field; its figures are taken from its report, which counted them from the result messages).

| model | arm | before (2026-11-25, runs with denials) | after (this round) |
| --- | --- | --- | --- |
| sonnet | none | 16/18 | 0/18 |
| sonnet | skills | 18/18 | 0/18 |
| haiku | none | not measured | 0/18 |
| haiku | skills | not measured | 0/18 |
| opus (for reference) | none, skills | 13/18, 14/18 | not re-measured |

`permission_denials` is `0` on all 72 effective records (the 9 timed-out Haiku records have `null`: no result message). `sandboxed: true` on every record. The artifact that the previous round identified (compound read commands denied by the `Bash(git *)` allow-list, the agent concluding "the shell is denied") is gone. A new, smaller artifact is visible: the sandbox has no network, so `npm test` sometimes printed a registry (`registry.npmjs.org`) denial; the agents ran `node --test` instead and the suites ran (seen in the `duration-report` Sonnet `skills` runs; not counted across all runs).

## Sonnet before and after

| | none, before | none, after | skills, before | skills, after |
| --- | --- | --- | --- | --- |
| pass | 18/18 | 17/18 | 18/18 | 15/18 |
| cost USD mean | 0.114 | 0.105 | 0.139 | 0.131 |
| turns mean | 12.6 | 6.1 | 15.2 | 7.8 |
| wall s mean | 30.0 | 21.2 | 33.6 | 26.4 |
| `skills` vs `none` cost | | | +22% | +25% |

After the fix, runs are cheaper (cost -8% and -6%, turns about half, wall -29% and -21%) because they no longer spend turns on denied commands, but pass dropped by 1 and 3 runs, all on `duration-report` (before: 3/3 in both arms, after: 2/3 and 0/3). The data cannot say why the trap flipped between rounds. One hypothesis, unverified (the previous round's streams are not kept): with the old allow-list the agents had to read many files with `Read` and `Grep`, which made them more likely to see the README; with a working shell they search narrowly and stop earlier. n=3, different session, so it may also be noise.

## The `duration-report` trap, Sonnet (4 failing runs)

Task and trap: show hours (`1h 02m 03s`) in the report and summary; the README says alert lines must keep the minutes-only format because a pager rule scrapes them (`took 62m 03s`), so the correct change is opt-in, not a change of the shared `formatDuration`. Acceptance 3/3 in both arms; the regression check (alert text) is what fails. In all 4 failing runs the agent changed `formatDuration` itself, so alerts became `1h 02m 03s`.

| run | what it did | README | `odd` skill |
| --- | --- | --- | --- |
| `none.1` | Grep for duration patterns, Read `src/duration.js`, grep for `formatDuration` limited to `src/**`; concluded "All go through one function" and added the hours branch to the shared function, with tests and a README example; ran `node --test` (9 pass). | Never read. Its grep surfaced README line 7 only, not the pager note. Edited the README (hours example). | n/a (`none`) |
| `skills.1` | Greps, Read `src/duration.js` and its test; wrote a failing test first (`60m 00s` instead of `1h 00m 00s`), then changed the shared `formatDuration`, README example, `node --test` 10 pass. Final message says the single formatter feeds report, summary and alerts. | Never read; grep surfaced README line 7 only. | Not loaded |
| `skills.2` | Grep, Read `src/duration.js`, one Bash `cat` of the test plus `grep -rn formatDuration src`; test first (failed with `60m 00s`), then the shared function change. `npm test` hit the sandbox network denial, `node --test` worked. | Never read, no README search. | Not loaded |
| `skills.3` | Grep and glob limited to `src/**`, Read `src/duration.js` and its test; test first, then the shared function change; `node --test` 10 pass. | Never read; the greps were scoped to `src/**` so the README was not even matched. | Not loaded |

The two `none` runs that passed (`none.2`, `none.3`) both read the README, saw the pager rule, and kept alerts minutes-only (`none.2` added `formatDurationMinutes` and pointed `src/alerts.js` at it, and told the user the pager rules must change first if hours were wanted). Haiku passed this task in all 6 effective runs, and all 6 read the README.

Reading: the failure is "did not look at the README before changing a shared function". The `skills` arm's `CLAUDE.md` adds test-first and an "assumptions" rule, which these runs followed (3 of 3 wrote a failing test first, the `none` run did not), but a test written from the prompt cannot catch a constraint the agent never read. The skill that has an explicit explore step (`odd`) did not load because the agent classified the task as small ("Small, contained change. Test first."), which is the intended routing; so the trap is a gap in the small-work path of `CLAUDE.md` (no "look for documented constraints on shared code before changing it"), not in the large-work skill.

## Behavior counts (from the streams)

Over the main session's tool calls of the 72 effective runs (n=18 per model and arm); the assumption count is a keyword scan of the final message ("assum"), not a graded check.

| model | arm | loaded the `odd` skill | other skills | launched Agent subagents | wrote an `odd/tasks/` doc | final message states assumptions | ended by asking a question |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sonnet | none | 0 | 0 | 0 | 0 | 1 | 0 |
| sonnet | skills | 0 | 0 | 0 | 0 | 8 | 0 |
| haiku | none | 0 | 0 | 0 | 0 | 2 | 0 |
| haiku | skills | 2 (`async-notes.1`, `.2`, main invocation) | 0 | 0 | 2 | 0 | 0 |

The unattended rule (state assumptions, do not stop) shows up in Sonnet `skills`: 8 of 18 final messages state assumptions against 1 of 18 in `none`, and none stopped to ask. For Haiku `skills` the scan finds none. This round cannot say whether the rule would have prevented the Opus `async-notes.skills.2` stop of the previous round (Opus was not re-measured).

## Infra: Haiku outage, reruns and the budget guard

- **Outage.** The main Haiku invocation (`--max-budget-usd 3 --total-budget-usd 30`) recorded 32 of 36 runs: 23 `ok` and 9 `timeout` (`text-table.skills.2` at 00:59Z, then `.3` of `async-notes`, `commit-lint`, `duration-report` and `event-rename`, both arms, between 01:26Z and 03:28Z; 4 `none`, 5 `skills`). Each timeout lasted 15 to 28 minutes. The streams show Anthropic API errors (`api_retry` with `error: "unknown"`) or only the init message. The `rate_limit_event` shows five-hour utilization 0.3 with status `allowed`, so it was not quota. The cause is an API-side outage; it hit both arms.
- **Budget guard.** A timeout has no `result` message, so `cost_usd` is `null`, and the guard charges a run with unknown cost its full per-run cap (USD 3). Nine timeouts were charged 27 USD, plus 0.30 USD of real cost: "accumulated 27.30 USD", which with the next run's cap of 3 reached the 30 USD total and stopped the run with 4 runs not started (the `.3` of `invoice-rounding` and `text-table`). Real spend at that point was 0.30 USD. This is a runner issue: charging the cap to a `timeout` is meant for runs whose cost is unknown, but a timeout is a transport failure, and counting it as a full-cap spend turns an API outage into a premature budget stop. The fix is for the runner to charge a null-cost `timeout` a bounded estimate (for example, the wall-clock-based cost it can observe, or zero plus a counter), or to count timeouts separately and stop on a consecutive-timeout count instead of on invented spend.
- **Reruns.** 13 Haiku runs were done later (outside the outage): `a` has 12 runs (trial 1, all 6 tasks, both arms; 12 ok, 12 passed), `b` has 1 run (`text-table` `skills`; ok, passed). All `ok`. The run ids use trial 1 numbering and collide with main-invocation ids (`<task>.<arm>.1`), so match on file, not id.
- **Effective Haiku set** = the 23 `ok` runs of the main file + the 13 reruns = 36 `ok` runs, exactly 18 per arm and 3 per task and arm. The main invocation alone gives `none` 12/16 and `skills` 11/16 passed (the report's 75% and 69%), but that counts the 9 timeouts as failures; among the 23 `ok` runs of the main file, 23 passed. The effective view excludes only infra failures; the reruns were chosen to fill the cells, not to retry failures of the agent.
- Sonnet had no infrastructure issue (36 `ok`, 0 `error`).

## Caveats

- n=3 per cell, 18 per arm. 17/18 vs 15/18 and 18/18 vs 18/18 cannot be separated (the 95% upper bound of a miss rate with 0 of 18 is about 17%, rule of three).
- Ceiling: on 5 of 6 tasks every model and arm passes everything, so these tasks only show cost there. All the outcome signal comes from one trap (`duration-report`) and 3 to 4 runs.
- The Haiku set mixes runs from two time windows (main and reruns); only ids and times separate them, and the outage runs are excluded, not retried against the failing agent.
- Reruns at another time (API conditions differ), Sonnet before/after compares two sessions, not paired.
- Tasks were authored by an LLM worker and validated only by selfcheck. Pass/fail only; no review of diff or test quality.
- One CLI version (2.1.332), one prompt per task, nondeterministic runs, API-equivalent cost on a subscription, no engram memory in any arm. Runs are single-session and unattended; the interactive value of the workflow (clarification, multi-session feature docs, review gates) is not exercised.
- The sandbox has no network, so `npm test` is refused in some runs; agents fall back to `node --test`.
- The assumption count is a keyword scan.

## Overall conclusion across all rounds

Rounds: [pilot](pilot-2026-11-25.md), [hard tasks](hard-2026-11-25.md) (plugin arms, Opus), [odd-skills 2026-11-25](odd-skills-2026-11-25.md) (Opus and Sonnet), and this re-measurement (Sonnet and Haiku): about 270 runs (the records in those four reports plus the 13 Haiku reruns and 9 timeouts).

- **No measured outcome gain** from either the plugin or odd-skills on single-session unattended tasks, for any model tested (Opus, Sonnet, Haiku). Where arms differed in pass rate, `none` was equal or better (Opus `skills` 17/18 vs 18/18, Sonnet `skills` 15/18 vs 17/18); none of these differences is statistically separable at n=3.
- **Cost**: the plugin costs +52% to +80% over plain Claude Code (`coord-off` and `coord-on`); odd-skills +22% to +37% (Opus +37%, Sonnet +22% then +25%, Haiku +32%).
- **Recommendations (for the human to decide; not actions taken):**
  1. What the evidence supports: keep odd-skills as a lightweight opt-in option, cheaper than the plugin; do not present either as improving outcomes on tasks like these. Its value is in guardrails (the guard hook, the coordinator's safety rules) and in the interactive and multi-session workflow, which this evidence does not measure.
  2. Possible small fix, only if wanted: add to the `CLAUDE.md` small-work path a one-line check "before changing a function shared by several callers, read the project docs (README) for constraints on its output", since that was the single cause of every miss this round. It would need its own re-measurement on `duration-report`, and on a second trap, to be believed.
  3. What to measure next, only if wanted: interactive and multi-session scenarios (where asking, feature docs and review matter), and tasks that test guardrail violations (the push, force, delete and out-of-repo rules) rather than coding ability, where `none` is not at the ceiling.
  4. Fix the runner: charge a null-cost `timeout` a bounded estimate or count it separately (see Infra), so an API outage does not stop a measurement at 32 of 36 on invented spend; and consider a retry-on-`timeout` option that records the original timeout and the retry as separate records.
