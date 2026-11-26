---
name: cds
description: "Trigger: non-trivial, risky, or multi-step work. Development discipline: protocol, feature document, test-first, completion gate (evidence before any done claim) and review-workload forecast."
---

# CDS Discipline

Use this skill for non-trivial, risky, or multi-step work. The always-on rules live in `CLAUDE.md` and the `cds-delegation`, `cds-verification` and `cds-tracking` rules; this skill holds the detail they point to. Nothing here runs code: it is instructions only.

## Protocol

1. **Authorize.** Investigation, explanation, review and planning requests are read-only. Change nothing until the user explicitly asks for a change; ask one question when change intent is ambiguous.
2. **Explore.** Read the existing code and requirements first, in proportion to the request.
3. **Classify.** Small: understood, contained risk, and resumable from the original request plus `git diff`. Large: that resume test fails (several sessions, external waits, separate deliverables, requirements too long to survive compaction). File or test counts never decide size.
4. **Track (large only).** Before the first write, create `odd/tasks/<feature>.md` in the format of `references/feature-doc-format.md` and keep a visible task list in step with it. Small work needs no document.
5. **Implement task by task.** Apply `references/test-first.md`; hand work to subagents by reference (document, task, specs), never by paraphrase.
6. **Close.** Report the verified outcome, every failed, skipped or pending check, and the next step.

Close every code change with `Risk: item N (reason)` or `Risk: none`. Before writing `Risk: none`, check whether the diff touches shared code (options, parsers, helpers) that behavior the request did not mention also uses; that is item 3. High-risk items: (1) migrations or irreversible data changes, (2) security: auth, permissions, secrets, (3) contracts others consume: public API, CLI flags, config formats, (4) concurrency, (5) delivery or environment: installers, release, CI, dependencies, (6) no test would catch a regression.

## Review workload

Forecast review workload before large changes; ask before producing oversized or multi-area diffs (see `/cds-work-unit-commits` and `/cds-chained-pr`).

## Completion gate

No completion, fix or pass claim without evidence observed this turn: name the proving command, run it fully, read its output and exit code, then state the result with that evidence. A passive documentation change needs only its readback.

| Claim | Requires | Not enough |
|---|---|---|
| tests pass | full run output with zero failures | a run from before the last edit, a prediction |
| build ok | build exit code 0 | a clean lint or typecheck |
| bug fixed | the original failing case now passing | code changed, tests green elsewhere |
| requirement met | each `S#` checked against its example | tests passing |
| delegated work done | the diff and one re-run command (check the diff, not the report) | the worker's summary |
| a fix's regression test is valid (not PRESERVE tests) | seen fail without the fix, then pass | green on first run |

Red flags, stop and verify: hedged wording ("should", "probably"); feeling done before any output; taking a subagent report at its word; a narrower check standing in for the full one; "just this once".

## References

- `references/feature-doc-format.md`: layout and maintenance of `odd/tasks/<feature>.md`.
- `references/test-first.md`: RED, GREEN, TRIANGULATE, REFACTOR policy.
