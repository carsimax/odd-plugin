# cds delegation: launching agents

Applies to the main session only. Triggers are in CLAUDE.md; this rule covers how to launch and hand off. Nothing here lets an agent orchestrate or spawn agents.

## Launching

- Check the agent can do the task before launching (never give a read-only explorer shell work).
- `cds-*` agents have fixed models: do not pass `model`. For native agents (Explore, Plan, general-purpose) pass `model: "sonnet"`.
- If a `cds-*` agent is unavailable, use a general-purpose agent with `model: "sonnet"` and the same bounded instructions, and say so.
- Pass paths, the spec reference and what to change, never file contents. Subagent prompts are in English; keep user quotes, error messages and filenames verbatim.
- Continue a finished agent with `SendMessage` instead of relaunching equivalent work. Use the foreground when you need the result next; use `run_in_background: true` otherwise, then wait for its completion without polling.
- An agent cannot ask the human. If it needs a decision it returns a blocking question (`status: interaction_required`); relay it with `AskUserQuestion`, preserving every option, then send the answer back to the same agent.

## Writers (`cds-worker`)

Every writer prompt needs:

- `## Allowed edit surfaces`: exact repository-relative paths or narrow globs, one per line, never `.` or the repository root; list pre-existing untracked files it may write. The writer never widens it: it reports candidate paths with reasons and waits for your replacement (a replacement lists every still-needed path, not a union).
- The task, acceptance criteria, `Spec: odd/tasks/<feature>.md, T#, S#` (writers read the document until `## Log` and report which `S#` they covered), the test runner and exact verification commands under `## Verification`, and relevant prior context.
- The helpers it must reuse for shared state and the invariants they keep (ordering, uniqueness, validation), because parallel writers cannot see each other.
- The test-first instruction: RED, GREEN, PRESERVE.
- Reminder: the writer never stages, commits or pushes; you own git.

Rules for writers:

- One writer per unit of behavior (code, tests and docs together). Independent units with disjoint surfaces launch together in one message; units that need the same file run one at a time.
- Writers run no repository-wide formatters, generators or installs. Capture `git status` before launching and check each writer's diff against its surface.
- After parallel writers finish, run the full suite once as a seam check.
- Fixes within the writer's limits continue the same writer.

## Exploration

Launch several `cds-explore` agents at once on distinct fronts (callers, implementation, tests, docs), each with a narrow question and a handoff of about 2k tokens with `path:line` evidence. Merge, then one spot check. Explorers are read-only.

## Output budget

Keep your own command output bounded (counts, `--stat`, tail). Delegate long suites and builds of a large task and ask for concise observed results.

## Review

`/cds-4r-review` and `/cds-judgment-day` are advisory and human-requested. They never replace functional checks and never authorize delivery.
