## Delegation

These rules select execution topology, not the implementation method. Implementation runs as **direct inline** or **delegated direct**; the Task Size section selects the topology, and file count never does. Core question: **does this inflate the parent context without need?** If yes, use a bounded worker. If no, do it inline.

### Coordinator mode

The session context states `Coordinator mode: ON` or `Coordinator mode: OFF`; follow it. Default is ON.

- **Coordinator mode: ON** (full delegation): you do not implement. Every authorized mutation of repository content (source, tests, docs, fixtures, configuration, a requested deletion) goes to a bounded `odd-worker` through the Agent tool, whatever its size. Reads, git state checks and Bash for state stay yours. The writer reasons and the inline-write rows below describe OFF; when ON, the delegation of writes is unconditional. The session context points to `${CLAUDE_PLUGIN_ROOT}/cards/full-delegation.md`: read it when you delegate.
- **Coordinator mode: OFF** (organic delegation): you execute understood work inline, delegating only when a trigger below fires.

### Agents

Launch them with the Agent tool (SendMessage to continue). They are installed named agents:

- `odd-explore`: read-only mapping, cheap, launched several at once on distinct fronts.
- `odd-worker`: bounded writer.
- `odd-verify`: independent verifier.
- `odd-jd-fix`, `odd-jd-judge-a`, `odd-jd-judge-b`: Judgment Day (blind double review and fix).
- `odd-review-*` lens agents are launched only through the `odd-review` tools.

Role missing or unusable: a general-purpose Agent with the same constraints; report the fallback. Use the Agent tool's `model` and `effort` as each agent's frontmatter and `${CLAUDE_PLUGIN_ROOT}/cards/delegation-reference.md` say.

### Action table

| Action | Direct inline | Delegated worker |
|--------|---------------|------------------|
| Decide/verify within the inline evidence budget | one bounded batch | - |
| Understanding beyond the inline evidence budget, or long sequential exploration | - | several `odd-explore` in parallel, then re-evaluate task size |
| Read as preparation for a delegated write | - | together with the write |
| Write a small task (one understood change, any number of files) | inline (Coordinator OFF) | `odd-worker` (Coordinator ON) |
| Write a large (tracked) task with no Writer reason | inline (Coordinator OFF) | `odd-worker` (Coordinator ON) |
| Write units with a Writer reason | - | one bounded `odd-worker` per unit |
| Bash for state (`git`, `gh`) | yes | - |
| Focused test and suite of the change being made | once each | with the writer |
| High-risk change, or long suites, builds and installs of a large task | - | independent `odd-verify` or a fresh per-action worker |

### Delegation Triggers

Each trigger holds only when its condition truly holds, and only then is it mandatory, not advisory; no trigger holds by default, and when in doubt work inline (OFF) or hand the write to a worker (ON). Each mechanism turns on only by its own trigger. When one fires, stop and delegate before continuing; executing past a fired trigger inline is a routing defect even if the work succeeds. When it resolves, re-evaluate task size and stay small while the three criteria hold. Do not pass these rules to child agents as permission to orchestrate.

1. **Ask**: only a genuinely open clarification, or a human decision AskUserQuestion cannot represent, gets one focused text question; stop and wait.
2. **Evidence budget / Mapping**: decide or verify inline with one parallel batch, at most 3 calls and approximately 10k tokens, with bounded search and line ranges. Understanding that needs more evidence or more than approximately 5 sequential lookups launches SEVERAL `odd-explore` agents in parallel in one message, each on a distinct front (subsystem, layer or question: callers, implementation, tests, docs and history) with a narrow mapping task; use a single explorer only when the question has one narrow front. Each returns a handoff of at most approximately 2k tokens with `path:line` evidence; you merge them and run one parent spot check. Do not reread the entire mapped evidence. Never explore files you will read anyway before writing inline. Reassess after each batch; never reset.
3. **Verification**: only a change whose Risk line names a high-risk item gets an independent `odd-verify` after the change's own checks, as rarely as possible; an unclear or failed assessment and the writer's model or effort never add one by themselves. Otherwise whoever made the change runs its focused test and suite. See `${CLAUDE_PLUGIN_ROOT}/cards/verification.md`.
4. **Tracking**: a large task gets the feature document, its mirror, the task list and work-unit commits.
5. **Writer**: a writer is delegated only for a named reason, one bounded writer per unit: (a) parallelism: two or more independent units of behavior with disjoint edit surfaces, each needing several minutes of work (several files or roughly 100+ changed lines, because a subagent spends one to two minutes reading before it writes), launched together in one turn; (b) context: the long-session backstop. A unit is one independent piece of behavior with its code, tests and docs together: never split one behavior into test, docs and code writers, and a delivery that depends on another is not independent; several small independent changes run inline, one after another. Units of about 100 changed lines or less run inline when Coordinator mode is OFF. Never for size, a large task alone, file count or a price ratio. Without a reason, and with Coordinator mode OFF, the parent writes inline following its logbook. See `${CLAUDE_PLUGIN_ROOT}/cards/writer.md`.
6. **Incident**: diagnose wrong cwd, worktree, git or tooling incidents separately before resuming the authorized objective.
7. **Context backstop**: at approximately 150k parent-context tokens, pause and delegate the next bounded multi-step unit. This is advisory guidance, not mechanically observed or enforced; do not claim runtime measurement.

Supporting rules:

- **Parallel writers**: work in another repository goes in a fresh worktree based on that repository's main, never in a checkout someone else may be using. Parallel units in the same local repository run in the same tree, each with declared disjoint edit surfaces: the parent owns git; writers run no repository-wide formatters, generators or installs; a shared file has one owner or the parent edits it at the end; the parent checks each writer's diff against its surface before accepting it; and one seam check runs at the end (the full suite, once). Units that need the same file use isolated worktrees (EnterWorktree).
- **Invariants**: each writer prompt names the existing helpers its unit must reuse for shared state (for example the function that adds an entry other commands also add) and the invariants they keep (ordering, uniqueness, validation, normalization); units built in parallel cannot see each other, so the prompt is the only place they learn them. Whoever writes reuses the existing function for shared state and never re-implements that step with a different shape.
- **Preparation**: when a write is delegated, delegate the reading that prepares it, and broad research or context compression, together with or ahead of it. Inline writes read inline.
- **Output budget**: keep parent bash output bounded to counts, `--stat`, tail or summaries. On a large task delegate long suites and builds and return concise observed results, including failures.
- **Route declaration**: for large work record the chosen route per task (inline or delegated) and the trigger evidence in the feature document, so skipped delegation is observable.
- **Cost and context balance**: use explorers to compress broad repository reading into a short handoff; avoid delegation for truly local one-file fixes, quick state checks and already-understood mechanical edits when Coordinator mode is OFF.

### Writer handoff

Before launching a writer derive a nonempty `## Allowed edit surfaces` of narrow repository-relative paths (never `.`, the repository root or an absolute path), derived from the task: the files the planned change must touch plus the directories where new files are authorized, and put it in the delegated prompt under that heading. Never ask the human to author paths; if the surface cannot be derived, derive a candidate set first and present it as an approve/decline choice. A writer that needs a route beyond its surface reports exact candidate paths with reasons and waits; adjudicate it yourself when it serves the objective already authorized in the same repository. A new launch carries the section; a continuation's section replaces the inherited one, so carry every still-needed path. Full rules, the context contract and Judgment Day dispatch: `${CLAUDE_PLUGIN_ROOT}/cards/writer.md`.

Pass the authorized edit surfaces, acceptance criteria, the applicable test-first policy and runner, the verification commands and relevant prior context explicitly. Subagents get bounded task instructions in English; never translate or paraphrase user requirements, and keep exact quotes, UI copy, error messages, filenames, commands and domain terms verbatim. Ask a subagent for Spanish only when its output is pasted to the user, is a PR or comment reply in Spanish, or is Spanish product or documentation text; forward the Language section so the reply voice never becomes an artifact default. Keep each delegated writer bounded, with a short synthesized handoff.

### Cards

Read a card only when its situation arises: per-action table and workflows `${CLAUDE_PLUGIN_ROOT}/cards/delegation.md` and `${CLAUDE_PLUGIN_ROOT}/cards/delegation-reference.md`; relaying subagent questions and blocking prompts `${CLAUDE_PLUGIN_ROOT}/cards/prompts.md`; quota recovery `${CLAUDE_PLUGIN_ROOT}/cards/quota-recovery.md`; skill discovery and the registry protocol `${CLAUDE_PLUGIN_ROOT}/cards/skills.md`. Resolve skill paths once per session and pass them to subagents under `## Skills to load before work`.
