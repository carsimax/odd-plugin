# Head-to-head, 2026-11-26: plugin (coordinator OFF) vs odd-skills vs plain Claude Code, Sonnet, same session

Runner and design: [README](README.md). Earlier rounds: [pilot](pilot-2026-11-25.md), [hard tasks](hard-2026-11-25.md), [odd-skills 2026-11-25](odd-skills-2026-11-25.md), [odd-skills re-measurement](odd-skills-rerun-2026-11-26.md). Raw data: [`runs.jsonl`](head-to-head-2026-11-26/runs.jsonl) (54 records), runner report [`report.md`](head-to-head-2026-11-26/report.md). Streams are not committed.

## Conclusion

The question (verbatim): "a prori que es mas eficiente descartando rdd odd-claude o odd-skills".

- **Answer: odd-skills is the more efficient of the two, without RDD.** In the same session, with the same model and tasks, odd-skills cost 16% less per run than the odd-claude plugin with the coordinator OFF (USD 0.132 vs 0.157 mean, -13% median), was cheaper in 16 of 18 paired runs, passed 18/18 against 16/18, and loaded about 5.8k fewer tokens on the first turn (28.5k vs 34.3k). Efficiency as passes per USD: odd-skills 7.6, plugin 5.7 (-26% for the plugin). Wall time and turns are equal within noise (25.7 s vs 25.1 s, 7.4 vs 7.0 turns).
- **Neither beats plain Claude Code on these tasks.** `none` passed 18/18 at USD 0.107 per run, 9.3 passes per USD, so it is the most efficient arm: odd-skills costs +23% (median +40%) and the plugin +47% (median +61%) for the same pass rate. Outcome gain over `none`: none measured for either (0 and -2 passes of 18).
- **The only misses are 2 plugin runs** (`duration-report` regression trap, `coord-off` 1/3). The difference is not separable at n=3 (2/18 vs 0/18 misses, Fisher exact two-sided p = 0.49), so read it as a direction.
- The "RDD" part: the plugin still loads its review, peers and codegraph MCP tools (14 tool schemas), 15 skills and the session-context hook in this arm; the coordinator being OFF does not remove them. That load is part of why the plugin is the costliest arm; it cannot be excluded without changing plugin config, so this compares the plugin as shipped, coordinator OFF, not "plugin minus RDD".
- These numbers agree with the earlier indirect ones: with Opus the plugin `coord-off` was +52% over `none` and odd-skills +37%; with Sonnet now +47% and +23% (odd-skills was +22% and +25% in two earlier Sonnet sessions). The ordering (plain < odd-skills < plugin) holds in every session and model.

## Setup

- Command: `npm run eval -- --tasks-dir bench/eval-tasks-hard --arms none,coord-off,skills --model sonnet --trials 3 --skills-installer ../odd-skills/install.sh --max-budget-usd 3 --total-budget-usd 20`. 6 tasks x 3 arms x 3 trials = 54 runs, one invocation, arms interleaved (started 04:46Z, last start 05:07Z), so the three arms share one time window and API conditions.
- Arms: `none` (plain Claude Code), `coord-off` (odd-claude 5.3.0 staged without engram, coordinator OFF, `observed_delegation: organic`), `skills` (standalone odd-skills at commit 8fa7abe, including the context rule, installed by `../odd-skills/install.sh`, no plugin). Model `sonnet` (claude-sonnet-5-5), Claude Code 2.1.332, every arm sandboxed with plain `Bash` allowed (see README permissions).
- Validity: 54 of 54 `ok`, 0 `invalid`, 0 permission denials, 0 subagents in any arm (the odd agents were available in `coord-off` and `skills`, but no run launched one). Every `skills` record has `skills_installed: true` and the installer path above. Recorded cost USD 7.12 (none 1.93, coord-off 2.83, skills 2.37; API-equivalent `total_cost_usd`).
- Isolation, checked after the run: the real `~/.claude/settings.json` sha1 is unchanged and no temporary workspaces were left over.

## Results per arm

Cells read mean / median / sample stdev, n = 18 runs per arm.

| arm | pass | acceptance | regression | cost USD | tokens | wall s | turns | visible tests modified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 18/18 | 18/18 | 18/18 | 0.107 / 0.093 / 0.028 | 147,182 / 142,918 / 40,951 | 22.0 / 19.9 / 9.2 | 5.9 / 6.0 / 1.4 | 10 |
| coord-off (plugin) | 16/18 | 18/18 | 16/18 | 0.157 / 0.149 / 0.036 | 191,324 / 192,132 / 55,770 | 25.1 / 25.3 / 9.4 | 7.0 / 6.0 / 2.7 | 12 |
| skills (odd-skills) | 18/18 | 18/18 | 18/18 | 0.132 / 0.131 / 0.024 | 196,872 / 202,789 / 48,720 | 25.7 / 25.9 / 8.6 | 7.4 / 7.0 / 2.1 | 12 |

Deltas of the means (medians in parentheses):

| metric | coord-off vs none | skills vs none | skills vs coord-off |
| --- | --- | --- | --- |
| cost | +47% (+61%) | +23% (+40%) | -16% (-13%) |
| tokens | +30% (+34%) | +34% (+42%) | +3% (+6%) |
| wall | +14% (+27%) | +17% (+30%) | +2% (+3%) |
| turns | +19% (0%) | +25% (+17%) | +6% (+17%) |

Tokens are the sum over all reported token classes. odd-skills uses as many or slightly more tokens than the plugin but costs less: the plugin pays more cache-creation tokens (mean per run: none 16.7k, skills 20.9k, coord-off 27.1k) and cache reads are priced lower, so the larger always-loaded plugin prefix weighs more in cost than in total tokens. Pairs (same task and trial): `skills` was cheaper than `coord-off` in 16 of 18, and `none` was cheaper than `skills` in 17 of 18.

### Efficiency (cost per passed run, passes per USD)

| arm | passes | spend USD | USD per passed run | passes per USD |
| --- | --- | --- | --- | --- |
| none | 18 | 1.925 | 0.107 | 9.35 |
| skills | 18 | 2.367 | 0.132 | 7.60 |
| coord-off | 16 | 2.829 | 0.177 | 5.66 |

On cost per passed run, odd-skills is 26% cheaper than the plugin (0.132 vs 0.177) and `none` 19% cheaper than odd-skills. Because 5 of the 6 tasks are at the ceiling for every arm, this ranking is almost entirely the cost ranking.

## Results per task

Pass count, mean cost USD, mean wall s and mean turns per cell (3 runs each).

| task | none | coord-off | skills |
| --- | --- | --- | --- |
| async-notes | 3/3, 0.142, 28.2 s, 7.0 | 3/3, 0.215, 32.9 s, 6.3 | 3/3, 0.157, 28.7 s, 6.7 |
| commit-lint | 3/3, 0.115, 25.9 s, 5.7 | 3/3, 0.165, 31.2 s, 5.7 | 3/3, 0.136, 29.9 s, 6.0 |
| duration-report | 3/3, 0.085, 14.4 s, 5.3 | 1/3, 0.144, 20.5 s, 11.7 | 3/3, 0.121, 21.2 s, 8.7 |
| event-rename | 3/3, 0.082, 12.7 s, 5.3 | 3/3, 0.118, 13.0 s, 5.3 | 3/3, 0.094, 12.3 s, 5.0 |
| invoice-rounding | 3/3, 0.083, 16.8 s, 5.0 | 3/3, 0.131, 19.0 s, 7.3 | 3/3, 0.123, 23.8 s, 9.7 |
| text-table | 3/3, 0.135, 33.8 s, 7.0 | 3/3, 0.170, 34.2 s, 5.7 | 3/3, 0.158, 38.5 s, 8.3 |

The plugin is the costliest arm on all 6 task cells (mean cost per cell above both `none` and `skills`); the narrowest gaps to odd-skills are `invoice-rounding` (0.131 vs 0.123) and `text-table` (0.170 vs 0.158). Acceptance is 3/3 everywhere; the single failing cell is `duration-report` regression in `coord-off`.

## The `duration-report` trap, all 9 runs

Task and trap: show hours (`1h 02m 03s`) in the report and summary; the README (line 16) says alert lines are scraped by an on-call pager that matches `took \d+m \d{2}s` and that the minutes-only format of alert lines must stay stable, so the shared `formatDuration` must not change the alert text. The regression check fails when alerts become `1h 02m 03s`.

"Pager note seen" means the note text appeared in a tool result before the first write. Writes include `Edit` and shell heredocs.

| run | pass | pager note seen before the first write | fix shape |
| --- | --- | --- | --- |
| none.1 | yes | yes, first Grep (call 1) returned README line 16 | hours by default, `{ hours: false }` option on `formatDuration`; `alerts.js` passes it |
| none.2 | yes | yes, Grep `\d+m \d\|alert` (call 4) | `formatDuration` untouched, new `formatDurationHours`; `report.js` uses it |
| none.3 | yes | yes, first Grep (call 1) | hours by default, `{ hours: false }` option; `alerts.js` passes it |
| coord-off.1 | no | no, no README read or match | changed shared `formatDuration` in place; alerts became hours |
| coord-off.2 | yes | yes, first Grep (call 1), then Read of README | `formatDuration` gets hours, old logic moved to `formatDurationMinutes`; `alerts.js` uses it |
| coord-off.3 | no | no, no README read or match | changed shared `formatDuration` in place; alerts became hours |
| skills.1 | yes | yes, first Grep (call 1) | `{ minutesOnly: true }` option, `alerts.js` passes it |
| skills.2 | yes | yes, first Grep (call 1), then Read of README | hours opt-in (`{ hours: true }`, default minutes-only); `report.js` passes it, `alerts.js` untouched |
| skills.3 | yes | yes, Grep (call 3) | `formatDuration` gets hours, old logic in `formatDurationMinutes`; `alerts.js` uses it |

Reading:

- Every passing run saw the pager note before its first write (7 of 7), and both failing runs did not (0 of 2). In all 7 the note arrived through a Grep whose pattern happened to match README line 16 (patterns such as `\d+m`, `padStart`, `duration`, `alert`), not through a deliberate README read; only `coord-off.2` and `skills.2` also read the README afterwards. The two failing runs used patterns (`\d+m|:02d|02d|:02`, `\d+m|%02d|padStart|:02`) that did not match that line, scoped their later greps to `formatDuration` and `src`, and concluded "one function" from `src/duration.js`.
- So the outcome here depends on a grep pattern, and that is luck in both directions: in the previous round (rerun report) 3 of 3 `skills` runs and 1 of 3 `none` runs missed the same trap with Sonnet, now 0 of 3 and 0 of 3, and the plugin missed 2 of 3. Across the two sessions the trap splits runs in every arm; none of the arms has a mechanism that reliably forces the README look. The `skills` arm's context rule (commit 8fa7abe) is present in these runs; this session shows no miss for it, but 3 runs cannot say it is the cause.
- Test-first: `coord-off.1`, `coord-off.3`, `skills.1`, `skills.2`, `skills.3` wrote a failing test first (the two plugin misses did too, which shows a test written from the prompt cannot catch a constraint nobody read). The `none` runs wrote tests after the change.
- Cost of the trap: the plugin used 11 to 13 turns on this task (mean 11.7) against 8.7 for odd-skills and 5.3 for `none`.

## What each arm loads per session

Measured from the stream `system`/`init` message and from the usage of the first assistant message of each run (all 18 runs per arm; first-turn prompt = `input` + `cache_creation` + `cache_read`). The cache split varies from run to run (some runs of `coord-off` read a shared 14.8k prefix from cache, the rest created it), so only the sum is comparable.

| arm | first-turn prompt tokens (min / median / max) | tools | skills | agents | MCP servers | hooks | output style |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none | 25,147 / 25,232 / 25,328 | 29 | 19 | 5 | 0 | none | default |
| skills | 28,322 / 28,462 / 28,596 | 29 | 35 | 15 | 0 | none | default |
| coord-off | 34,165 / 34,263 / 34,349 | 43 | 46 | 15 | 3 | `SessionStart:startup` | `odd-claude:odd` |

Always-loaded context above the plain-Claude-Code baseline (about 25.2k tokens: system prompt, built-in tools and skills): **odd-skills about +3.2k tokens, the plugin about +9.0k tokens** (+9.1k at the median), i.e. the plugin loads about 2.8x the extra context. Over a 7-turn run most of this is re-read from cache, which matches the cache-creation means above (+4.2k for skills, +10.4k for the plugin per run).

Components (what is loaded; the per-component token split is not measured, only the totals above):

- **odd-skills**: `CLAUDE.md` (2,500 bytes at the 2.5 KB cap), the 16 odd skills' names and descriptions (35 skills listed against 19 in `none`), the 10 odd agents' descriptions (15 agents against 5), and a PreToolUse guard hook that runs only when a command is issued and adds no prompt text. No MCP servers, no extra tools (29 = 29), no output style change. Skill bodies load only when a skill is invoked; the `odd` skill was not needed in these tasks.
- **plugin, coordinator OFF**: output style `odd-claude:odd`; the `SessionStart:startup` hook, whose `additionalContext` is 2,954 characters (cards directory and session context); 3 MCP servers (`codegraph`: 1 tool, `peers`: 3 tools, `review`: 10 tools, 14 MCP tool schemas in total, which is what moves the tool count from 29 to 43); 27 plugin skills (46 listed against 19) and the 10 odd agents (15 against 5). The review tools (the RDD part) and the peers tools are loaded and described in every session even when the coordinator is OFF and no run used them.

Estimates only: the totals are measured, but how much each component contributes (output style, hook, MCP schemas, skill and agent descriptions) was not isolated; excluding the review/RDD tools would need a plugin config change, which this comparison did not make.

## Caveats

- n = 3 per cell, 18 per arm. The pass-rate difference (16/18 vs 18/18) is not separable (p = 0.49); the cost differences are consistent (16 of 18 paired runs, stdev about 0.03 USD against mean gaps of 0.025 to 0.05) but are one model, one session.
- Ceiling: 5 of the 6 tasks are passed by every arm in every run, so they only show cost; all outcome signal is the one `duration-report` trap, and its result depends on whether a grep pattern happens to match README line 16 (see above).
- The plugin arm still loads the RDD review tools and the peers and codegraph MCP servers; "plugin with coordinator OFF" is the plugin as shipped, not the plugin without RDD. The odd-skills arm contains no equivalent of them, so part of the cost gap is the RDD tool load by construction.
- Single-session, unattended tasks only: the interactive value of the workflows (clarifying questions, feature docs across sessions, review gates, delegation to subagents) is not exercised. 0 subagents were launched anywhere, so the coordinator and review paths never ran.
- Tasks were authored by an LLM worker and validated only by selfcheck; pass/fail only, no diff or test-quality review.
- One CLI version (2.1.332), one prompt per task, nondeterministic runs, API-equivalent cost on a subscription, no engram memory in any arm, no network in the sandbox (`npm test` is refused in some runs; agents fall back to `node --test`).
- The first-turn token figures come from the first assistant message's usage; the cache split inside them is not stable between runs, the sum is.
- The earlier Opus numbers (plugin +52%, odd-skills +37%) come from other sessions and a different model; they are cross-references, not part of this paired comparison.
