# Orchestrator — Delegation Card (lazy-loaded)

Bind this to the parent (main-thread) session only, on delegation or routing triggers. Read `${CLAUDE_PLUGIN_ROOT}/cards/delegation-reference.md` only when a situation names it (per-action table, Work Routing Ladder, workflows, background, fallback, and language detail).

## Handoff

Subagent-facing prompts should be written in English by default, even when the user speaks Spanish. Generated technical artifacts default to English regardless of the persona; forward this to the executor (language domain detail: reference). Write the handoff instructions in English, but never translate, condense, or paraphrase the user's requirements: pass them by reference to the feature document's `## Specs` (`Spec: odd/tasks/<feature>.md (read until "## Log"). Do T#; S#.`), or include the user's request verbatim when no feature document exists.

Exceptions:

- Preserve exact user quotes, UI copy, error messages, filenames, commands, and domain terms in their original language when they are evidence.
- Ask a subagent to produce Spanish only when its output is intended to be pasted directly to the user, a PR/comment/reply in Spanish, or Spanish-language product/documentation text.

#### Delegation Triggers

These boundaries do not authorize children to orchestrate. Each trigger holds only when its condition truly holds; none holds by default. Inline stays within the evidence budget. When one fires, stop and delegate through the `Agent` tool before continuing; executing past a fired trigger inline is a routing defect even if the work succeeds.

1. **Ask:** open product or design decision, routed by ODD step 3; stop and wait (`AskUserQuestion`).
2. **Mapping trigger (Evidence-budget rule):** read inline only when the evidence fits one parallel batch of at most 3 calls totaling ~10k tokens. Reassess cumulative discovery after each batch; never reset it. When understanding needs more or over 3 lookups, delegate one explorer (`odd-claude:odd-explore`) returning a handoff of at most ~2k tokens with `path:line` evidence; the trigger overrides initial size, including for read-only work. Re-evaluate size after. Preparation for an already understood inline write stays inline, not further discovery.
3. **Verification rule:** only a change whose Risk line names a high-risk item (Task Size) gets an independent `odd-claude:odd-verify` run after the change's own checks, as rarely as possible; otherwise whoever made the change runs its focused test and suite inline, small tasks included. Routing: `${CLAUDE_PLUGIN_ROOT}/cards/verification.md`.
4. **Track:** a large task gets the feature document, Engram mirror, task list (`TodoWrite`), and work-unit commits (`${CLAUDE_PLUGIN_ROOT}/cards/memory.md`).
5. **Writer trigger (Writer rule):** a large task alone never delegates, and file count never fires this trigger. Delegate one bounded writer per unit only for a named reason: (a) parallelism — 2+ independent units of behavior with disjoint edit surfaces, each needing several minutes of work (several files or ~100+ changed lines; a subagent spends 1-2 minutes reading before it writes), launched together; (b) context — the Context backstop below. A unit is one independent piece of behavior with its code, tests, and docs together: never split one behavior into test, docs, and code writers; a delivery that depends on another is not independent; several small independent changes run inline, one after another. Units of about 100 changed lines or less always run inline: writing them costs less than starting workers. Never for a price ratio. Without a reason, the parent works inline, following the logbook (feature document, mirror, task list, work-unit commits).
6. **Incident rule:** after a wrong `cwd`, accidental repository/worktree mutation, failed merge recovery, or environment workaround, stop and diagnose it separately before resuming.
7. **Context backstop:** when the context advisory fires, pause and delegate the next bounded unit of work that needs several steps.

**Invariants:** whoever writes, inline or delegated, reuses the existing function for shared state and keeps its invariants (ordering, uniqueness, validation, normalization); writer prompts name those helpers (`${CLAUDE_PLUGIN_ROOT}/cards/writer.md`).

**Differential check (PRESERVE):** forward the test-first differential check to writers.

**Preparation trigger:** reading that prepares a delegated write goes with the writer; inline writes read inline. When delegating, read only what decides the route, never the files the worker will read; pass paths, the spec reference, and what to change, not file contents.

**Route declaration:** for large work, record the chosen route per task and its trigger evidence in the feature document, so skipped delegation is observable instead of silent.

These triggers only choose between direct inline and delegated direct inside ODD.

For a large task's bounded writes, prefer `odd-claude:odd-worker`. If it is unavailable, fall back to a general-purpose `Agent` with the same bounded instructions and report the fallback. If no delegation mechanism is available, stop and explain the blocker. Judgment Day roles (`odd-claude:odd-jd-fix`, `odd-claude:odd-jd-judge-a`, `odd-claude:odd-jd-judge-b`) are never generic fallbacks.

## Launch

- Derive nonempty `## Allowed edit surfaces` before launching a writer (`${CLAUDE_PLUGIN_ROOT}/cards/writer.md`). Parallel writers only with disjoint Allowed edit surfaces or isolated worktrees (`EnterWorktree`).
- Pass the session's resolved skill paths under `## Skills to load before work`; children read them first (`${CLAUDE_PLUGIN_ROOT}/cards/skills.md`).
- A child must be able to do the task it is given. Check the agent's declared `tools` before launching (its definition under the plugin `agents/` directory): never give a read-only explorer shell work, and never assume your own tools transfer to the child. With no qualified agent, report the capability gap; a fired trigger is never replaced by inline work.
- Background: launch with the `Agent` tool and `run_in_background: true`; it returns at once. End the turn and resume when the completion notification arrives; never sleep or poll for it. Otherwise run in the foreground. Detail: reference.
- Do not pass `model` to generic subagents unless the user asks.
- Advisory review: Phase 4.
