---
paths:
  - "odd/tasks/**"
  - "odd/**/*.md"
---

# cds tracking: the ODD feature document

Applies to the main session when you read or edit a file under `odd/`. Use it for large work (the resume test in Task Size fails). Small work and a requested task list alone need no document.

## Document

One file per feature at `odd/tasks/<feature-name>.md` (descriptive, filename-safe; never overwrite another feature). It is the specification agents read by reference. Fixed order, stable content first, growing log last:

1. **Header** (2-3 lines): objective, branch, delivery strategy (`ask-on-risk` default, `auto-chain`, `single-pr`), test runner.
2. **`## Specs`**: numbered `S1`..`Sn` requirements and acceptance criteria. Quote the user's exact strings, error messages, commands and examples verbatim, in the user's language; never summarize or reword them. Add no requirement the user did not ask for; mark assumptions as assumptions.
3. **`## Tasks`**: one line per task: ID (`T1`..), linked `S#`, route (who writes it), status (`pending`, `done`, `blocked`, `dropped`), commit, and `done when: <observable check>`. An optional `Risk:` line names high-risk items.
4. **`## Log`**: `L1` is the user's request verbatim; later corrections are logged verbatim with their date. Analysis, evidence and next steps go here, briefly.

Optional sections (`## Delivery`, `## Risks`) go before `## Log`.

```markdown
# <feature title>
Objective: ... Branch: `feat/x`. Delivery: `ask-on-risk`. Runner: `npm test`.

## Specs
- **S1** "<user's exact words>" ...

## Tasks
- T1 | S1 | writer | pending | done when: <check>

## Log
- L1: "<verbatim request>"
```

## Maintenance

- Use targeted edits; never rewrite the whole file to change a task line or add a log entry.
- A requirement change appends its verbatim Log entry, rewrites only the affected `S#`, and reopens only its linked task. Findings alone never expand scope; new business scope needs the user's approval.
- When a `done when` check fails, fix it before starting dependent tasks, or ask the human; never mark it done.
- Check off only observed outcomes; record failed, skipped or pending checks honestly.
- Obsolete tasks are marked `dropped` with the reason in the Log; a dropped task never satisfies its dependents. A task waiting on something outside the list is `blocked`, naming what unblocks it.
- Keep the visible task list in step with the document at every task transition, in the same turn. The file is canonical; the list is a projection.
- Merge worker results yourself; never replace the document with one worker's partial view. Workers read it until `## Log` and report which `S#` they covered.
- To resume, read the file, reconcile requirements, code and proof, then continue the next unfinished task.

## Delivery

Commit work units on the feature branch, about 400 authored changed lines each (planning heuristic only, never a gate; never split artificially or trim comments or tests to fit). A unit whose Risk line names a high-risk item gets its own commit. Record the commit that holds each task in the document. Forecast the branch total; if it passes about 400 lines, record slice boundaries and, when the user asks to publish, offer in order: feature branch chain, stacked-to-main chain, or one single PR (least recommended). Use `/cds-work-unit-commits` and `/cds-chained-pr`. Push, pull request creation and merge stay the user's decisions.

## Research

For a named uncertainty, use `WebSearch`/`WebFetch` through a read-only `cds-explore` agent and prefer primary sources; attribute claims to URLs or code locations and separate facts from assumptions. If tools are unavailable, say so. Validate any premise whose failure would invalidate the approach before building.
