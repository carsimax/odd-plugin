# ODD delegation

Core question: does this inflate the parent context without need? Delegate only when a trigger truly holds; in doubt, work inline. Executing past a fired trigger inline is a routing defect.

## Triggers

1. Ask: open product or design decision -> `AskUserQuestion`, wait.
2. Evidence budget: understanding needs more than one read batch (~3 calls, ~10k tokens) -> several `odd-explore` in parallel in ONE message, each on a distinct front (subsystem, layer, question: callers, implementation, tests, docs/history), each with a narrow mapping task. Use one explorer only for one narrow front. Merge the handoffs; reassess per batch. Preparation for an already understood inline write stays inline.
3. Verification: a named high-risk item -> independent `odd-verify`; otherwise verify inline. See `verification.md`.
4. Track: large task -> feature document, task list, work-unit commits (`tracking.md`).
5. Writer: only for 2+ independent units of behavior, each heavier than a subagent start (several files or ~100+ changed lines), launched together with disjoint surfaces; units of ~100 lines or less run inline. A unit = behavior with its code, tests and docs together; never split one behavior into test writer + docs writer + inline code. See `writer.md`.
6. Incident: wrong cwd/worktree/git/tooling -> diagnose separately before resuming.
7. Context backstop: when context runs long, delegate the next multi-step unit; keep command output bounded (counts, `--stat`, `tail`).

## Launch notes

- Use the `Agent` tool with `subagent_type`, `model`, `effort` as in SKILL.md. `run_in_background: true` returns at once; end the turn and resume on the completion notification; never sleep or poll.
- Check the agent's declared tools before launching: never give a read-only explorer shell work. If no qualified agent exists, report the capability gap; a fired trigger is not replaced by inline work.
- Continue a child with `SendMessage`. Judgment Day roles are never generic fallbacks.
- When delegating, read only what decides the route; pass paths, the spec reference and what to change, not file contents.
- Hand off by reference: `Spec: odd/tasks/<feature>.md, T2, S3-S4`; without a document pass the user's request verbatim. Workers read the document until `## Log` and report which `S#` they covered.
- Reuse relevant findings from sibling investigations; verify only what is stale.
- Parallel writers need disjoint edit surfaces or isolated worktrees (`EnterWorktree`).
- Child subagents never spawn agents. Handoffs and subagent prompts are English.
