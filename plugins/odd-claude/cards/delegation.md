# Orchestrator — Delegation Card (lazy-loaded)

Bind this to the parent (main-thread) session only, on delegation or routing triggers. Read `${CLAUDE_PLUGIN_ROOT}/cards/delegation-reference.md` only when a situation names it (per-action table, Work Routing Ladder, workflows, background, fallback, and language detail).

## Handoff

Handoff language, exact quotes and by-reference specs (`Spec: odd/tasks/<feature>.md ...` or the user's request verbatim) follow the odd output style (Delegation and step 6).

#### Delegation Triggers

The seven triggers are those of the odd output style (Delegation, items 1-7). These boundaries do not authorize children to orchestrate. Each trigger holds only when its condition truly holds; none holds by default. Inline stays within the evidence budget. When one fires, stop and delegate through the `Agent` tool before continuing; executing past a fired trigger inline is a routing defect even if the work succeeds. Specifics beyond the output style:

- **Ask:** `AskUserQuestion`; stop and wait.
- **Mapping:** the trigger overrides initial size, including for read-only work; re-evaluate size after. Preparation for an already understood inline write stays inline, not further discovery. Explorers: `odd-claude:odd-explore`.
- **Verification:** the change's own focused test and suite run inline, small tasks included; the independent `odd-claude:odd-verify` is as rare as possible. Routing: `${CLAUDE_PLUGIN_ROOT}/cards/verification.md`.
- **Track:** feature document, Engram mirror, task list, work-unit commits (`${CLAUDE_PLUGIN_ROOT}/cards/memory.md`).
- **Writer:** a unit is one independent piece of behavior with its code, tests and docs together; a delivery that depends on another is not independent; several small independent changes run inline, one after another; units of about 100 changed lines or less always run inline (writing them costs less than starting workers); never for a price ratio. Launch shape: `${CLAUDE_PLUGIN_ROOT}/cards/writer.md`. Without a reason, the parent works inline, following the logbook.
- **Incident / context backstop:** as in the output style; the backstop fires on the context advisory.

**Invariants:** whoever writes, inline or delegated, reuses the existing function for shared state and keeps its invariants (ordering, uniqueness, validation, normalization); writer prompts name those helpers (`${CLAUDE_PLUGIN_ROOT}/cards/writer.md`). Forward the test-first differential check (PRESERVE) to writers.

**Preparation trigger:** reading that prepares a delegated write goes with the writer; inline writes read inline. When delegating, read only what decides the route, never the files the worker will read; pass paths, the spec reference, and what to change, not file contents.

**Route declaration:** for large work, record the chosen route per task and its trigger evidence in the feature document, so skipped delegation is observable instead of silent.

These triggers only choose between direct inline and delegated direct inside ODD.

For a large task's bounded writes, prefer `odd-claude:odd-worker`. If it is unavailable, fall back to a general-purpose `Agent` with the same bounded instructions and report the fallback. If no delegation mechanism is available, stop and explain the blocker. Judgment Day roles (`odd-claude:odd-jd-fix`, `odd-claude:odd-jd-judge-a`, `odd-claude:odd-jd-judge-b`) are never generic fallbacks.

## Launch

- Derive nonempty `## Allowed edit surfaces` before launching a writer (`${CLAUDE_PLUGIN_ROOT}/cards/writer.md`). No hook enforces it: it is a rule the parent follows. Skill paths follow the output style (`${CLAUDE_PLUGIN_ROOT}/cards/skills.md`).
- A child must be able to do the task it is given. Check the agent's declared `tools` before launching (its definition under the plugin `agents/` directory): never give a read-only explorer shell work, and never assume your own tools transfer to the child. With no qualified agent, report the capability gap; a fired trigger is never replaced by inline work.
- Background: launch with the `Agent` tool and `run_in_background: true`; it returns at once. End the turn and resume when the completion notification arrives; never sleep or poll for it. Otherwise run in the foreground. Detail: reference.
- Do not pass `model` to generic subagents unless the user asks.
- Review (the `review` MCP and `/odd-claude:4r-review`) is advisory and parent-owned: `${CLAUDE_PLUGIN_ROOT}/cards/verification.md`.
