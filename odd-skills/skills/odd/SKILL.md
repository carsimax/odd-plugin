---
name: odd
description: "Use for large, risky or multi-step work: feature documents with specs and tasks, test-first implementation, parallel read-only exploration, bounded writer subagents, independent verification of high-risk changes, and work-unit commits. Trigger: the task fails the 'resumable from the request plus git diff' test, spans several independent units, or touches data, security, public contracts, installers/CI/deps or concurrency. Skip for small work."
---

# ODD (Organic Driven Development)

Detail lives in `references/` next to this file (path: `<skills-dir>/odd/references/`). Read a reference only when its situation arises.

## Flow

1. Authorize and explore (read-only requests stay read-only). Interactive: ask the user for any open product decision; batch the questions and wait. Unattended: see "Unattended runs".
2. Track before the first write: create `odd/tasks/<feature>.md` (header, `## Specs` with `S#` quoting user strings verbatim, `## Tasks` each ending `done when: <check>`, `## Log` last with `L1` = the user's request verbatim), then the visible task list (`TaskCreate`/`TaskUpdate`, or `TodoWrite`). One line to the user: document and task count. Format and rules: `references/tracking.md`.
3. Implement task by task. Test-first when a deterministic runner applies: RED (observe the intended failure), GREEN, PRESERVE (one test per touched existing behavior). Check a task off only after its outcome and checks were observed this session.
4. Commit work units (about 400 changed lines, tests and docs together, Conventional Commit) on a feature branch, only for authorized large work; load `work-unit-commits`. Push, PR and merge stay the user's decision.
5. Close: report the verified outcome, every failed, skipped or pending check, and the next step, plus the `Risk:` line.

## Unattended runs

Unattended = no human can answer: a headless or `claude -p` session, `AskUserQuestion` unavailable, or the request says to proceed. Then the ask-first steps (step 1 questions, the pause before the first write, relaying a subagent's `interaction_required`) do not apply: never stop to ask and never end with open questions. Pick the most conservative reasonable assumption (smallest change, existing conventions, reversible, no new dependency), record each one in the feature document `## Log`, proceed, and finish the requested change. Final report: an `Assumptions` list, one line each. Genuinely destructive or out-of-repo actions stay off-limits; skip them and report. Interactive sessions keep asking.

## Denied or failing commands

One denied or failing command is not proof that a tool is unavailable. Retry in a simpler form (one command per call, no `&&`/`;`/pipes/redirects, no subshells) and try the direct tool equivalent before concluding. Never claim tests, builds or other checks cannot run until the exact command was run alone and its output read. If it still fails, report the command, the error and what was tried, then continue with the checks that do run.

## Delegation: when

Default is inline. Each trigger fires only when truly met:
- Evidence budget: understanding needs more than one read batch or over ~3 lookups -> explorers.
- Writer: only 2+ independent units, each several files or ~100+ changed lines, with disjoint edit surfaces, launched together; or the context is running long. Else write inline.
- Verification: only a named high-risk item (below) -> one independent verifier.
High risk = (1) irreversible data effects, (2) security, (3) changing or removing consumed contracts (API, CLI flags, config formats), (4) concurrency, (5) delivery or environment (installers, release, CI, deploy, dependencies), (6) no test would catch a regression. Details: `references/delegation.md`.

## Delegation: how (Agent tool)

Always pass `subagent_type`, `model` and `effort` exactly as below (these are the intended defaults; agent files also pin the model). Subagents cannot spawn agents or ask the user; they return `status: interaction_required` and you relay it with `AskUserQuestion`.

| Role | subagent_type | model | effort | Use |
|---|---|---|---|---|
| Explorer | `odd-explore` | `haiku` | `low` | Read-only mapping. Launch SEVERAL in one message, one distinct front each (callers, implementation, tests, docs/history); each returns <= ~2k tokens with `path:line` evidence. |
| Writer | `odd-worker` | `sonnet` | `medium` | One independent unit. |
| Verifier | `odd-verify` | `opus` | `high` | Only for a named high-risk item, once per unit after the writer's self-verification. |
| JD judge A / B | `odd-jd-judge-a` / `odd-jd-judge-b` | `opus` / `sonnet` | `high` / `medium` | Via the `judgment-day` skill. |
| JD fix | `odd-jd-fix` | `sonnet` | `medium` | Via the `judgment-day` skill. |
| Review lenses | `odd-review-readability`, `-reliability`, `-resilience` / `odd-review-risk` | `sonnet` / `opus` | `medium` / `high` | Via the `4r-review` skill. |

Example explorer launch (several `Agent` calls in one message):
`Agent(subagent_type: "odd-explore", model: "haiku", effort: "low", description: "map callers", prompt: "Map every caller of X. Read-only. Return path:line evidence, <= 2k tokens.")`

Writer prompt (never paraphrase requirements; hand off by reference):
```
Spec: odd/tasks/<feature>.md, T2, S3-S4
## Allowed edit surfaces
- path/one.ts
- tests/one.test.ts
## Verification
- <exact command>
## Known environmental failures
- <exact failing test or command already failing on base, or none>
```
Rules for writers: the `## Allowed edit surfaces` section is NONEMPTY, narrow, repository-relative paths (never `.`, the repo root, or absolute); derive it yourself, never ask the human to author paths. Name the existing helpers the unit must reuse. Forward the test-first policy and the exact runner commands. Without a feature document, pass the user's request verbatim. If the worker needs a wider surface it returns candidate paths; reply with a replacement list (not a union) via `SendMessage`. Parallel writers need disjoint surfaces; launch all independent units in the same message. After they return: read the diff, re-run one reported command yourself, run the full suite once (seam check). A worker's summary is never evidence. More: `references/writer.md`.

Verifier prompt: pass the artifact (diff or baseline commit) and the contract (feature document, `S#`, task), not the writer's conclusions; include the writer's reported commands and the high-risk item. Blockers get one correction batch and one limited re-verify. Details: `references/verification.md`.

If an odd agent is unavailable, use a general-purpose Agent with the same constraints and say so.

## Rules that always apply

- Subagent briefs are English; keep user quotes, error text, commands and filenames verbatim. Mention Spanish only when output is pasted to a Spanish thread.
- Evidence before claims: name the proving command, run it fully, read output and exit code. Red flags: "should", "probably", trusting a subagent summary, a narrower check standing in for the full one.
- Update help text and docs when you add or change a command, option or message.
- Incident (wrong cwd, stray worktree, confusing test command): diagnose it separately before resuming.
- Blocking questions from subagents and the user-facing prompt rules: `references/prompts.md`.
- Persistent memory only when Engram `mem_*` tools exist: `references/memory.md`. Never pretend memory exists.
