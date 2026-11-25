# ODD tracking

Load when a task is large. Small work creates no durable artifact; a requested todo list alone needs no feature document.

## Feature document `odd/tasks/<feature-name>.md`

Create it after exploration and before the first source write, without asking. Reuse the same name when resuming; never overwrite another feature. Fixed order:

1. Header, 2-3 lines: objective, branch, delivery strategy, test runner.
2. `## Specs`: numbered `S1..Sn` requirements, constraints and acceptance checks. Quote the user's strings, error messages, commands and examples verbatim, in the user's language; number and order them but never reword. Add no requirements the user never asked for; mark assumptions as assumptions.
3. `## Tasks`: one line per task: ID, linked `S#`, route (inline or worker), status, commit or RED/GREEN evidence, ending `done when: <observable check>` (a test name, command output, file state).
4. `## Log`: last. `L1` = the user's request verbatim; later corrections are appended verbatim with date; analysis, rationale, verification evidence, progress and next step also go here.

Update with targeted edits; never rewrite the whole file to change a task line or add a log entry. The visible task list (`TaskCreate`/`TaskUpdate`, or `TodoWrite`) is a projection of the document: update both in the same turn at every task transition.

## Rules

- Done-when: when a task's check fails, fix it before starting a dependent task, or ask. Never mark done on a failing check.
- A requirement change: append the verbatim `## Log` entry, rewrite only the affected `S#`, reopen only its linked task, keep valid completed work. New business scope needs the user's authorization. Findings alone never expand scope.
- Obsolete tasks are `dropped` with the reason in `## Log`, never `done` or left `pending`. A task waiting on something outside the list is `blocked` with what it waits for. A prerequisite inside the list is ordering: add a task.
- Record the chosen route per task (inline or worker, and the trigger evidence) so skipped delegation is observable.
- Research: prefer primary sources (`WebSearch`, `WebFetch`) for external evidence, attribute claims to URLs or code locations, separate verified facts from assumptions. Research findings never authorize mutations.
- Reproduce a user-reported failure by running its example first; reading code is not reproduction.
- Test-first is the default: forward the policy, the exact runner and commands, and any exception rationale to every implementation delegation; record observed evidence in the document.
- About 400 authored changed lines per task is a planning heuristic only: keep the smallest coherent behavior with its tests and docs; never split artificially, omit tests or minify to fit.
- Delivery: forecast changed lines at document creation and keep a running count. Past ~400, record slice boundaries. Strategies: `ask-on-risk` (default), `auto-chain`, `single-pr`, `exception-ok`; apply one only when the user asks to publish. Chain choices (ask once, in the user's language): feature-branch chain, stacked-to-main chain (verify the default branch name), or one single PR (least recommended). Shape selection never authorizes push, PR or merge. See skills `work-unit-commits`, `chained-pr`.
- At closure: every pending task is either continued, tied to a launched child, or tied to a real blocker (declined consent, exhausted limit, open human decision). Check the document for stale open tasks, done tasks without a Log entry, tasks without `done when`; fix those for your own document.
