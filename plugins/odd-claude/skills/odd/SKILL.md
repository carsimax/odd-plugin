---
name: odd
description: "Trigger: non-trivial, risky, or multi-step work. ODD harness discipline: completion gate (evidence before any done claim) and review-workload forecast. Always-on rules live in CLAUDE.md and rules."
---

# ODD Harness

Use this skill for non-trivial, risky, or multi-step ODD work. The rules themselves are always on; this skill holds only what they do not.

## Where the rules live

- Identity (odd-claude, a workflow harness): the always-on `identity` block.
- ODD steps (authorize, explore, classify, track, implement, close): the always-on `protocol` block.
- Task Size and high-risk items: the always-on `task-size` block.
- Delegation, triggers and writer handoff: the always-on `delegation` block.
- Skill registry and discovery: the `odd-skills` rule. Verification tiers: the `odd-verification` rule.
- Task document layout (`odd/tasks/<feature>.md`): `../../support/feature-doc-format.md`. Test-first: `../../support/test-first.md`.

## Review workload

Forecast review workload before large changes; ask before producing oversized or multi-area diffs.

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
