# Orchestrator — Writer Handoff (lazy-loaded)

Parent (main-thread) session only. Load it when the Writer rule fires or for an explicitly activated Judgment Day fix batch. The Writer rule (odd output style, Delegation item 5) fires on a named reason only. Writer prompts require the Parallel review protocol self-review (`${CLAUDE_PLUGIN_ROOT}/cards/verification.md`). A reason holds only when the launch delivers it:

- **Invariants**: each writer prompt names the existing helpers its unit must reuse for shared state and the invariants they keep; units built in parallel cannot see each other.
- **Size threshold**: a subagent costs one to two minutes of reading and setup before it writes anything; delegate a unit only when it needs several minutes of work (several files or roughly 100+ changed lines). Several small independent changes are faster inline, one after another.
- **Parallelism**: a unit is one independent piece of behavior with its own code, tests, and docs; never split one behavior into a test writer, a docs writer, and inline code, and never delegate a unit that depends on another unit still in progress. Launch every independent unit in the same turn: several `Agent` calls (`subagent_type: "odd-claude:odd-worker"`, `run_in_background: true` when background is useful) in one assistant message with no other tool call, then wait for all completions before the Seam check; serial launches void the reason: if units cannot launch together, work inline.

#### Allowed edit surfaces (MANDATORY)

The writer refuses to write outside its exact surfaces and stops with `interaction_required` without them. Every new writer launch carries the section (a continuation via `SendMessage` inherits it); after a rejection, repair what it names once, never relaunch the same prompt unchanged, and never end the turn on one: take the next step it names.

Before launching any bounded writer, even the general-purpose `Agent` fallback, derive its surface from the task (files the change touches, plus directories where it authorizes new files) and pass it under `## Allowed edit surfaces`:

- exact repository-relative paths or narrow globs, one per line; never `.` and never a bare repository root; whitespace needs whole-entry backticks (``- `My Dir/a.md` ``), not just a list marker;
- the section ends at the next heading of any level (0-3 leading ASCII spaces, 1-6 `#`, an ASCII space); every non-empty line before it must be an entry; prose goes under a later heading;
- pre-existing untracked targets it may write, listed explicitly;
- nothing beyond the task; wider is the same defect as none.

Test scratch stays outside the worktree (`mktemp -d`), never in the repository (nor caches or `TMPDIR`); inside state uses an excluded path the test removes. For isolated parallel work, an isolated worktree (`EnterWorktree` / `ExitWorktree`) replaces the disjoint-surface requirement between writers, never the surface section itself.

If the surface cannot be derived, do not launch or make the human author paths: offer the derived exact paths as an approve/decline choice (Lossless Blocking Prompts, `${CLAUDE_PLUGIN_ROOT}/cards/prompts.md`). Investigate technical route doubt; it is not a human question.

A writer never widens its surface; it reports exact candidate paths with reasons and awaits your replacement. Add a necessary path (test, helper) yourself, without the human, only in the authorized objective and repository, after checking ownership, existing work, risk, and concurrent writers and units; a cosmetic refactor never qualifies; an unresolved ownership or overlap conflict blocks it. New objective or scope, unapproved repository, private material, destructive or prohibited operation, missing consent, denial, or exhausted limit go to the human under existing protocols. Continue the same writer (`SendMessage`) with a replacement, not a union: every still-needed path plus a concise reason, never repository-wide, no budget reset. A surface grants no repository authority or prohibited operation.

#### Judgment Day fix dispatch

Use `odd-claude:odd-jd-fix` only for an explicitly activated Judgment Day fix batch, never as a lexical or generic-writer fallback. Judgment Day is independent: it neither enables nor replaces ordinary review. The exact dispatch shape (activation, round, frozen ledger hash, finding rows, `## Allowed edit surfaces`) is defined once in `/odd-claude:judgment-day` (Fix Boundary). No hook enforces it or the `## Allowed edit surfaces` rule: both are rules the parent follows.
