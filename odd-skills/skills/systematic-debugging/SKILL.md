---
name: systematic-debugging
description: "Trigger: bug, failing test, test failure, unexpected behavior, build failure, flaky test, regression, depurar. Find and prove the root cause before changing code."
license: MIT
metadata:
  author: odd-skills
  version: "1.0"
---

## Activation Contract

Use when something breaks or behaves unexpectedly: a failing test, a build failure, a regression, a flaky test, a wrong result. Use it before the first fix attempt, including "quick" ones.

## Hard Rules

- No fix, and no fix proposal presented as the answer, before the root cause is named with observed evidence (output, trace, value, diff). Listing candidate hypotheses or options when the human asks is fine.
- When something unexpected breaks, stop adding features or changes; preserve the error output first.
- Reproduce it. If it does not reproduce, record the conditions and widen the evidence (timing, environment, state) instead of guessing.
- Localize: instrument component boundaries to see where good data turns bad, use `git bisect` for regressions, trace a bad value backward to where it originates, and fix there, not where it surfaces.
- One written hypothesis at a time, tested with the smallest change and one variable. A failed hypothesis means a new hypothesis, never stacked fixes.
- The fix is one change with a regression test seen failing without it, then passing (see "Completion gate" section of the `odd` skill). No drive-by refactors.
- Three failed fix attempts: stop, do not try a fourth. The pattern points at the design, not the code; bring the architecture question and the evidence to the human (AskUserQuestion when available; a delegated worker must return `partial`).
- Wait for the condition, not a fixed sleep, unless timing itself is the behavior under test.
- No root cause found is valid only with the list of what was investigated, plus handling and logging so the next occurrence is diagnosable.

## Execution Steps

1. Read the full error and stack; note exact messages and the first failing point.
2. Reproduce with the smallest deterministic case.
3. Check recent changes (diff, dependencies, config, environment).
4. Localize with the techniques in `references/techniques.md`.
5. State the hypothesis, test it, record the result.
6. Write the failing regression test, apply the single fix, run the authorized suite and checks.

## Red flags

Each means go back to reproduce or localize:
- "Just try this and see."
- Several changes at once, or "it probably is X" without evidence.
- Skipping the reproduction because the cause seems obvious.
- A fix that works but you cannot explain why.
- Each fix reveals a new problem elsewhere.

## Output Contract

Return the root cause with its evidence, the fix and its regression test (seen failing, then passing), or the no-root-cause report.

## References

- `references/techniques.md`: backward tracing, boundary instrumentation, bisection, defense in depth, condition-based waiting.
