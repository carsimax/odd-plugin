# Feature Document Format

For large authorized implementation, keep one feature document at `odd/tasks/<feature-name>.md` in the project (descriptive, filename-safe name; reuse the same name for the same feature, never overwrite another feature). It is the canonical record; the visible task list (`TaskCreate`/`TaskUpdate`, or `TodoWrite` when those are unavailable) is a projection refreshed at task transitions. Subagents read the document by reference (`Spec: odd/tasks/<feature>.md, T2, S3-S4`), from the top until `## Log`.

Small work creates no document. A requested task list alone needs no document.

## Fixed order (stable content first, growing log last)

1. **Header** (2-3 lines): objective, branch, delivery choice (how a change over about 400 lines is delivered: chained PRs, one PR, or ask), test runner.
2. **`## Specs`**: numbered `S1`..`Sn` requirements, constraints and acceptance criteria with their checks. Quote the user's exact strings, error messages, commands and examples verbatim, in the user's language; never summarize or reword. Add no requirement the user never asked for; mark assumptions as assumptions.
3. **`## Tasks`**: one line per task with a stable ID `T1`..`Tn`: linked `S#`, route (inline or which worker), status (`pending`, `done`, `blocked`, `dropped`), commit identity or RED/GREEN evidence, and `done when: <observable check>`. An optional `Risk:` line names high-risk items that need an independent verifier.
4. **`## Log`**: `L1` is the user's original request verbatim; later user corrections are logged verbatim with their date as `L2`, `L3`, ... Analysis, rationale for meaningful changes, verification evidence, progress and next step go here. Keep routine entries brief.

Optional sections (`## Delivery`, `## Risks`) go before `## Log`; the Log stays last.

```markdown
# <feature title>
Objective: ... Branch: `feat/x`. Delivery: ask. Runner: `npm test`.

## Specs
- **S1** "<user's exact words>" ...

## Tasks
- T1 | S1 | inline | pending | done when: <observable check>

## Log
- L1: user's original request: "<verbatim>".
```

## Maintenance rules

- Update with targeted edits; never rewrite the whole file to change a task line or append a log entry.
- A requirement change appends its verbatim `## Log` entry, rewrites only the affected `S#`, and reopens only its linked tasks; preserve valid completed and unrelated work. Findings alone never authorize scope expansion.
- Check off only observed outcomes with applicable proof; record failed, unavailable, skipped or pending checks honestly. When a `done when` check fails, fix it before starting dependent tasks.
- Obsolete tasks are marked `dropped` with the reason appended to `## Log`; a dropped task never satisfies the tasks that depended on it.
- Merge bounded worker results into the document rather than replacing the feature with one worker's partial view. Workers read the document until `## Log` before edits and report which `S#` they covered.
- On resume, read the document, then reconcile requirements, code and proof before continuing the next unfinished task.
- Create the task list from the document's tasks before the first source write, and update both in the same turn after each transition.
- About 400 authored changed lines per slice is a planning heuristic only (see `/cds-work-unit-commits` and `/cds-chained-pr`).
