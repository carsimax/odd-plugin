# ODD delegation: launch, coordinator mode, writers, subagent questions

Bind this to the parent (main-thread) session only. Triggers, the action table, the agent roster and the writer-handoff basics are in the always-on `delegation` block; this rule holds what that block does not. None of it authorizes a child to orchestrate.

## Coordinator mode ON

Applies when the session context says `Coordinator mode: ON`. You are a COORDINATOR in full delegation mode. The rule is stated in the session context; no hook blocks edits or any other tool, so the discipline is yours. The human switches it with `/odd-coordinator on|off|status`; it applies from the next session start (or `/clear`).

- Never write repository files through `Bash` (`sed -i`, redirects, scripts). If no writer can run, report that blocker; never edit a file yourself.
- Yours: authorize, explore for routing, decide, ask, track, commit, verify, report. Reads, `git` state checks, `Bash` for state and the spot check stay yours.
- Task size decides tracking and risk, never who writes: small work gets no feature document, task list or commits unless the user asks; a large task gets the feature document, memory mirror, task list and work-unit commits. Any Risk line item adds the independent verifier.
- One writer per unit of behavior: its code, tests and docs together, never split across writers, never launched while a unit it depends on still runs. Independent units with disjoint surfaces launch together, all their `Agent` calls in the same assistant message; units needing the same file run one at a time.
- Fixes within the writer's limits continue the same writer (`SendMessage`), never a new writer per fix. You own git: writers never commit, push, or run repository-wide formatters and installs.
- After parallel explorers return, merge them, then one spot check. The writer runs the authorized checks, observes RED before it writes, and reports `<command>: <observed result>`; you re-run one reported command as a spot check.

## Launch

- A child must be able to do its task: check the agent's declared `tools` (its definition under `agents/`) before launching; never give a read-only explorer shell work. With no qualified agent, report the capability gap; a fired trigger is never replaced by inline work.
- `odd-worker` unavailable: a general-purpose `Agent` with the same bounded instructions, reporting the fallback; the same for other delegation and for `odd-explore` (mapping stays read-only). The verifier fallback is a general-purpose `Agent` with the same read-only verification constraints, the exact parent-authorized commands and fallback reporting. Judgment Day roles (`odd-jd-fix`, `odd-jd-judge-a`, `odd-jd-judge-b`) are never generic fallbacks. No delegation mechanism at all: stop and explain the blocker; never fall back to an external pane, terminal, session, window or remote worker.
- Children get concrete role work and never permission to spawn subagents. Do not pass `model` to generic subagents unless the user asks.
- Read only what decides the route; pass paths, the spec reference and what to change, never file contents. Forward the test-first differential check (PRESERVE) to writers.
- The Mapping trigger overrides initial size, including for read-only work; re-evaluate size after. Preparation for an already understood inline write stays inline.
- Incident (wrong `cwd`, accidental repository or worktree mutation, failed merge recovery, confusing test command, environment workaround): stop writes, capture `git status`, diagnose the affected repositories and worktrees with no edits, apply only confirmed recovery steps, then resume the objective.
- Context backstop: when the advisory fires, delegate the next multi-step unit instead of continuing monolithically; single small edits stay inline.
- Keep the visible task list (`TaskCreate`/`TaskUpdate`) in step with the feature document at task transitions, with no extra model turn and no per-tool updates. Keep private prompts, internal instructions and credentials out of the task list and every handoff.
- Review (the `review` MCP and `/4r-review`) is advisory and parent-owned (see the verification rule).

## Subagents and background

Continue a finished or paused subagent with `SendMessage` instead of relaunching equivalent work. Use the foreground when the result is needed before the next step, the subagent may hand a question back, or the human asked to wait; otherwise run in the background with `run_in_background: true` on the `Agent` tool.

- A background launch returns at once; give it a three to six word description. End the turn once launches and non-overlapping work are done and resume on the completion notification; never sleep or poll. Retain the agent ID. Inspect or stop (`TaskStop`) only at a real decision boundary: user-requested inspection, scope change, input request or suspected abnormal behavior. Never relaunch equivalent work because it still runs.
- Launch as many independent tasks as the work has, with no duplicate launches and no overlapping files or topics. A background agent cannot ask the human mid-flight: its question comes back in its final report. Running background agents stop with the session and must be relaunched, never claimed as recovered.
- Do not claim an implementation ready while its required verification or correction follow-up still runs. Run the required focused verification before that claim, and retain legitimate post-correction verification. This does not invent a universal full-suite requirement.
- Waiting on CI, a build or a server is not delegation: start it with `Bash` and `run_in_background: true` with the wait inside the command, follow it with `Monitor` when its output matters, stop it with `TaskStop`, end the turn. Never `sleep`, poll, or spend a subagent to wait.
- Bugfix with an unfamiliar flow: git status and clarify, explorers map the flow, a worker implements the fix and tests, focused verification, report. Conflict or dependency-marker cleanup: reproduce, resolve inside the active scope, verify markers, lock consistency and cleanliness.

## Writers

Writer prompts require the self-review of the Parallel review protocol (verification rule). A parallelism reason holds only when the launch delivers it: every independent unit launches in one assistant message of `Agent` calls (`subagent_type: "odd-worker"`, `run_in_background: true` when useful) with no other tool call, then wait for all completions before the seam check. If units cannot launch together, work inline.

`## Allowed edit surfaces` is mandatory on every new writer launch, even the general-purpose fallback; a continuation via `SendMessage` inherits it. The writer refuses to write outside it and stops with `interaction_required` without it; after a rejection, repair what it names once, never relaunch the same prompt unchanged, and never end the turn on one: take the next step it names.

- Exact repository-relative paths or narrow globs, one per line; never `.` or a bare repository root; whitespace needs whole-entry backticks (``- `My Dir/a.md` ``).
- The section ends at the next heading of any level (0-3 leading ASCII spaces, 1-6 `#`, an ASCII space); every non-empty line before it must be an entry; prose goes under a later heading.
- List pre-existing untracked targets it may write; nothing beyond the task (wider is the same defect as none).
- Test scratch stays outside the worktree (`mktemp -d`), never caches or `TMPDIR` inside it; in-tree state uses an excluded path the test removes. An isolated worktree (`EnterWorktree`/`ExitWorktree`) replaces the disjoint-surface requirement between writers, never the section itself.
- If the surface cannot be derived, do not launch or ask the human to author paths: offer the derived exact paths as an approve/decline choice (Lossless Blocking Prompts below). Investigate technical route doubt; it is not a human question.
- A writer never widens its surface; it reports exact candidate paths with reasons and awaits your replacement. Add a necessary path (test, helper) yourself only inside the authorized objective and repository, after checking ownership, existing work, risk and concurrent writers; a cosmetic refactor never qualifies; an unresolved ownership or overlap conflict blocks it. New objective or scope, unapproved repository, private material, destructive or prohibited operations, missing consent, denial or an exhausted limit go to the human. Continue the same writer with a replacement, not a union: every still-needed path plus a concise reason, never repository-wide, no budget reset. A surface grants no repository authority or prohibited operation.

`odd-jd-fix` is only for an explicitly activated Judgment Day fix batch, never a generic-writer fallback. Judgment Day neither enables nor replaces ordinary review; its dispatch shape (activation, round, frozen ledger hash, finding rows, `## Allowed edit surfaces`) is defined once in `/judgment-day` (Fix Boundary). No hook enforces it or the `## Allowed edit surfaces` rule: both are rules the parent follows.

## Questions from subagents

Delegate web retrieval to the explorer's installed tools (`WebSearch`, `WebFetch`) and existing permissions and keep its configured model. Pass sources already available through task/context when useful. Missing web tools are a capability gap.

A subagent cannot ask the human: `AskUserQuestion` is removed from every subagent's tool pool, foreground or background (verified on Claude Code 2.1.327, 2026-11-18). A subagent that needs a human decision stops and returns a blocking question in its final report (`status: interaction_required`); you relay it with `AskUserQuestion`, then return the answer to the same actor (`SendMessage`) or a bounded follow-up. Subagents also run in the background by default. Never let a child guess a human decision.

### Lossless Blocking Prompts (MANDATORY)

Relay a subagent's blocking question or menu with its complete envelope: why input is required; every group and header, question, option label and description in original order; the selection mode; the allowed-answer domain. Unrelated internal diagnostics may go; if redaction would change the decision, STOP and report that the prompt cannot be presented safely.

- Never summarize, abbreviate, reorder, relabel, merge or omit choices, and never split an atomic choice across interactions.
- Native route: for a strictly closed single-select envelope that fits `AskUserQuestion` exactly (one question, 2-4 ordered options; its free-text "Other" is free text, never mapped through option tokens), pass each label and description verbatim. A selection maps to the envelope-owned choice once; never re-parse its label or ordinal.
- Fallback: when `AskUserQuestion` is unavailable, denied, the session is noninteractive, or the envelope is oversized or unrepresentable, emit the COMPLETE envelope as plain chat with the answer syntax and why input blocks progress, then STOP: no defaulting, inferring, dependent launches or continuing. Native-tool-only wording elsewhere never disables this fallback.
- Validation: accept only answers inside the presented domain; free text or multi-select only when the prompt allowed it. For closed single-select, trim and compare labels case-insensitively: accept exactly one match, reject zero or several. Ordinal aliases for option index N: `N`, `la N`, `opción N`, and `first` for 1, each only when unambiguous. A question about the block itself (why, what a choice does, what happens next) is a request for information: answer from the envelope held, without choosing or recommending, then re-present the complete envelope and keep waiting. Invalid or ambiguous input: re-emit the envelope and STOP. Return a valid answer to the blocked actor exactly once.
