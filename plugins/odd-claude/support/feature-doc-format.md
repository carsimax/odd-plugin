# ODD Feature Document Format

For large authorized implementation, the parent session keeps one feature document at `odd/tasks/<feature-name>.md` in the project (descriptive filename-safe name; reuse the same identity, never overwrite another feature). It is canonical: the Engram recovery copy (topic `odd/<feature-name>/tasks`, current project) and the visible task list (`TaskCreate`/`TaskUpdate`; `TodoWrite` when they are unavailable) are projections refreshed at task transitions. Subagents read the document by reference (`Spec: odd/tasks/<feature>.md`, read until `## Log`).

Small work creates no document. A requested session task list alone needs no durable document or memory mirror.

## Fixed order (stable content first, growing log last)

1. **Header** (2-3 lines): objective, branch, delivery strategy (`single-pr` default, `ask-on-risk`, `auto-chain`, `exception-ok`), test runner.
2. **`## Specs`**: numbered `S1`..`Sn` requirements, constraints and acceptance criteria with their checks. Quote the user's exact strings, error messages, commands and examples verbatim, in the user's language; number and order them, never summarize or reword. Add no requirement the user never asked for; mark assumptions as assumptions.
3. **`## Tasks`**: one line per task with a stable ID `T1`..`Tn`: linked `S#`, route (who writes it), status (`pending`, `done`, `blocked`, `dropped`), and commit identity or RED/GREEN evidence. An optional `Risk:` line names high-risk items that need an independent verifier.
4. **`## Log`**: `L1` is the user's original request verbatim; later user corrections are logged verbatim with their date as `L2`, `L3`, ... Problem analysis, rationale for meaningful accepted changes, verification evidence, progress and next step go here. A human's standing review consent is logged verbatim with its date. Routine corrections stay brief; no exhaustive decision journal.

Optional sections (`## Delivery`, `## Risks`) go before `## Log` when needed; the Log stays last.

Example skeleton:

```markdown
# <feature title>
Objective: ... Branch: `feat/x`. Delivery: `single-pr`. Runner: `npm test`.

## Specs
- **S1** "<user's exact words>" ...

## Tasks
- T1 | S1 | writer | pending

## Log
- L1: user's original request: "<verbatim>".
```

## Maintenance rules

- Update with targeted edits; never rewrite the whole file to change a task line or append a log entry.
- A requirement change appends its verbatim `## Log` entry, rewrites only the affected `S#`, and reopens only its linked tasks; preserve valid completed and unrelated work. Findings alone never authorize scope expansion.
- Check off only observed outcomes with applicable proof; record failed, unavailable, skipped or pending checks honestly.
- Obsolete tasks are marked `dropped` in `## Tasks` with the reason appended to `## Log`; a dropped task never satisfies the tasks that depended on it.
- The parent merges bounded worker results rather than replacing the feature with one worker's partial view. Workers read the document until `## Log` before edits and report which `S#` they covered.
- Mirror the full current document and its repository-relative locator to Engram (`mem_save` / `mem_update`; tool names as in `~/.claude/rules/odd-tracking.md`: `mcp__engram__mem_*` or `mcp__plugin_engram_engram__mem_*`) once per task transition or material plan change, and at close. Persist the local file first. Writes are not atomic: after a failed or uncertain acknowledgement, check what applied before retrying; never replay an applied write.
- On resume, use `mem_context` and a project/feature-scoped `mem_search`, then `mem_get_observation` for the full copy; read the actual file and reconcile requirements, code and proof before continuing. A missing copy is not permission to overwrite surviving progress.
- Create or rebuild the task list from the same tasks before the first source write; update both durable copies and the visible list in the same turn after each transition. If the projection is unavailable, record that limitation.
- Use about 400 authored changed lines per task only as a planning heuristic; forecast and track the branch total from work-unit commits (see `/work-unit-commits` and `/chained-pr`).
