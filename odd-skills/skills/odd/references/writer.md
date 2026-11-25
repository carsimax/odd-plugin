# Writer handoff

Load when the Writer trigger fires. A reason holds only when the launch delivers it.

- Invariants: each writer prompt names the existing helpers its unit must reuse for shared state and the invariants they keep (ordering, uniqueness, validation, normalization); parallel units cannot see each other.
- Size: a subagent costs a minute or two of setup; delegate only units needing several minutes (several files or ~100+ changed lines). Several small independent changes are faster inline.
- Parallelism: one unit = one independent piece of behavior. Launch every independent unit in the same message (several `Agent` calls, `run_in_background: true` when useful), then wait for all before the seam check. Units that cannot launch together run inline.

## Allowed edit surfaces (mandatory)

The writer refuses to write outside its surfaces and stops with `interaction_required` without them. Every new launch carries the section; a `SendMessage` continuation inherits it.

- Exact repository-relative paths or narrow globs, one per line; never `.`, a bare root or absolute paths. Entries with whitespace use whole-entry backticks.
- The section ends at the next heading; every non-empty line before it must be an entry; prose goes under a later heading.
- List pre-existing untracked targets it may write explicitly. Nothing beyond the task.
- Test scratch lives outside the worktree (`mktemp -d`), never in the repo.
- If you cannot derive the surface, do not launch; offer the derived paths to the user as an approve/decline choice.
- A writer never widens its surface; it reports candidate paths with reasons. Add a necessary path yourself only inside the authorized objective after checking ownership, risk and concurrent writers; continue the same writer (`SendMessage`) with a replacement list that holds every still-needed path (not a union).
- After a rejection, repair what it names once; never relaunch the same prompt unchanged.

## Self-review and return

Writers run the `## Verification` commands exactly, one at a time, foreground, and report `<command>: <observed result>`. `## Known environmental failures` lists exact failures already present on the base: reported as evidence, not blockers; any other failing required command forces `status: partial`. One correction attempt per failing check, a second only if it still fails after a real fix, then `partial` with evidence.
