# Orchestrator — Delegation Reference (lazy-loaded)

Bind this to the parent (main-thread) session only. Read it only when a situation in the delegation card (`${CLAUDE_PLUGIN_ROOT}/cards/delegation.md`) names it; the card holds the triggers and launch rules, and this file holds the reference material behind them.

### Language Domain Contract

Artifact language and the persona boundary are in the odd output style (Delegation, Language Boundary). Beyond it: if technical artifacts are explicitly requested in another language, use a neutral/professional register unless the user asks for another tone or regional variant. Public/contextual comments follow the target context language by default; explicit user language or tone wins, otherwise a neutral/professional register. Forward this to the executor so persona voice never becomes the artifact or public-comment default.

## Claude Code Runtime Overlays

These sections bind generic delegation to Claude Code's runtime, adding routing without changing ODD ownership. The runtime provides the `Agent` tool (subagents, foreground or background), `SendMessage` (continue a subagent), the task list tools `TaskCreate`/`TaskUpdate` (`TodoWrite` when they are unavailable; visible progress), `AskUserQuestion`, `Bash` with `run_in_background` plus `Monitor` and `TaskStop`, and `EnterWorktree`/`ExitWorktree`.

### Subagent-facing English

Subagent-facing prompts are written in English by default, even when the user speaks Spanish; the handoff rule and its exceptions live in the card. This keeps orchestrator output small and gives plugin and project subagents a consistent operating language without changing the user-facing persona or losing exact requirements.

### Delegation Rules

These rules select execution topology, not the implementation method. Implementation runs as **direct inline** or **delegated direct**; the always-on Task Size section and its Mechanisms select the topology, and file count never does.

Core principle: **does this inflate the parent context without need?** If yes, use one bounded worker. If no, do it inline.

Progress is shown through the visible task list (`TaskCreate`/`TaskUpdate`): keep it in step with the feature document at task transitions, with no extra model turn and no per-token or per-tool updates. Exclude private prompts, internal instructions and credentials from anything written to the task list or a handoff.

| Action | Direct inline | Delegated direct worker |
|--------|---------------|-------------------------|
| Read to decide/verify within the cumulative evidence budget (one parallel batch: at most 3 calls, ~10k tokens) | ✅ | — |
| Read to explore/understand beyond the evidence budget | — | ✅ several parallel explorers (`odd-claude:odd-explore`), one per distinct front (handoff of at most ~2k tokens each, `path:line` evidence) |
| Read as preparation for writing | ✅ for understood inline work | ✅ together with the delegated write |
| Write a small task (one understood change, any number of files) | ✅ | — |
| Write a large task with no Writer rule reason | ✅ following the logbook | — |
| Write a unit with a Writer rule reason | — | ✅ one bounded writer per unit (`odd-claude:odd-worker`) |
| Bash for state (`git`, `gh`) | ✅ | — |
| Focused test and suite of the change being made | ✅ in one command | — |
| Named high-risk item | — | ✅ independent `odd-claude:odd-verify` |

Check duration alone never triggers a verifier.

Use the plugin's bounded worker agent for delegated-direct work.

Keep each delegated writer bounded, with a short synthesized handoff. Delegation is mandatory only when a mechanism's own trigger fires, and remains an ODD implementation route.

#### Claude Code Trigger Runtime Bindings

Once a trigger fires, the parent MUST delegate through the `Agent` tool. Never fall back to an external pane, terminal, session, window, or remote worker. Do not replace a required delegation with inline execution. Do not give child agents permission to spawn subagents; children receive concrete role work and must not orchestrate.

The canonical Writer rule under Delegation Triggers overrides this general runtime preference.

1. **Evidence-budget rule**: as in the odd output style (Delegation, item 2). Route generic exploration first to `odd-claude:odd-explore`; if missing or unusable, use a general-purpose `Agent` with the same read-only mapping task and report the fallback.
2. **Writer rule**: follow the canonical Writer rule under Delegation Triggers.
3. **Incident rule**: after wrong `cwd`, accidental repository/worktree mutation, failed merge recovery, confusing test command, or environment workaround, stop and diagnose the incident separately before resuming.
4. **Context backstop**: when the context advisory fires, pause and delegate the next unit that needs several steps instead of silently continuing monolithically; single small edits stay inline.
5. **Verification rule**: the normative routing, the risk tier table, and the writer `## Verification` contract live in `${CLAUDE_PLUGIN_ROOT}/cards/verification.md`; load it when this rule fires or a delegated writer returns.

### Work Routing Ladder

Route work through the smallest harness that is safe. "Smallest" means minimal safe coordination, not zero delegation by default.

#### 1. Inline Direct

Use inline execution when the task is small by the always-on Task Size section: read, edit (one understood change may span files), run its focused test and suite in one command, or bash for state. Keep the ODD path proportionate. When a mechanism's own trigger fires, turn on only that mechanism, then re-evaluate.

#### 2. Simple Delegation

Delegate when a mechanism's own trigger fires, within the ODD workflow: understanding an unfamiliar module beyond the evidence budget (explore), implementing a unit with a Writer rule reason (writer), or checking a high-risk change (independent verifier).

Use the `Agent` tool with the plugin's agents (`odd-claude:odd-explore`, `odd-claude:odd-worker`, `odd-claude:odd-verify`). Continue a finished or paused subagent with `SendMessage` instead of relaunching equivalent work. For bounded writes, follow the canonical Writer rule under Delegation Triggers.

#### Background Subagents

Run a delegation in the background by passing `run_in_background: true` to the `Agent` tool. Use the foreground when the result is needed before the next step, when the subagent may need to hand a question back, or when the human asked to wait.

- A background launch returns at once; the terminal stays free and the human keeps typing. Give it a short description of three to six words naming the work.
- When a background agent finishes, Claude Code delivers a completion notification into this session and starts a new turn if idle. Wait for it: end the turn once launches and any non-overlapping work are done. Never sleep or poll for completion. Retain the agent ID so a follow-up can continue it with `SendMessage`. Inspect or stop it (`TaskStop`) only at a real orchestration decision boundary: user-requested inspection, relevant scope change, input request, or suspected abnormal behavior. Never relaunch equivalent work merely because it is still running.
- Do not claim an implementation ready while its required verification or correction follow-up remains running. Run the required focused verification before that claim, and retain legitimate post-correction verification. This does not invent a universal full-suite requirement.
- A background subagent cannot ask the human anything mid-flight; a question comes back in its final report (see `${CLAUDE_PLUGIN_ROOT}/cards/prompts.md`).
- Launch as many independent tasks as the work has; do not duplicate launches or work, and do not overlap files or topics.
- Running background agents stop when the session ends and must be relaunched, never claimed as recovered.

Waiting on CI, a build, or a server is not delegation: start it with `Bash` and `run_in_background: true` with the wait inside the command, follow it with `Monitor` when its output matters, stop it with `TaskStop`, and end the turn. Never `sleep`, poll, or spend a subagent to wait.

For generic mapping, follow the Evidence-budget rule in the delegation card.

Delegate generic verification that executes or delegates commands per the Verification rule (trigger 3 under Delegation Triggers) -- the normative routing lives in `${CLAUDE_PLUGIN_ROOT}/cards/verification.md`, not here: the bounded writer always self-verifies via `## Verification`; a named high-risk item also requires `odd-claude:odd-verify` (or a general-purpose `Agent` fallback, with the same read-only verification constraints, exact parent-authorized commands, and fallback reporting). `## Known environmental failures`: `odd-claude:odd-worker`'s Verification contract. The change's own focused test and suite run inline. Separate exploration stays reserved for when the parent needs the map to decide or route; reading that prepares a write belongs with the writer making the change, consistent with the Delegation Rules table above.

For delegation other than a large task's bounded writes, use the generic fallback: a general-purpose `Agent` in the current runtime; never fall back to an external pane, terminal, session, window, or remote worker. The delegation trigger remains mandatory. If no delegation mechanism is available, stop the complex work and tell the user instead of silently continuing inline.

#### Subagent Model Routing

For generic subagents, do not pass the `model` parameter by default. Let the agent definition and session defaults resolve the model. Only pass `model` for generic subagents when the user explicitly requests a model override for that launch.

Small task pattern:

```text
parent clarifies and checks git → parent edits inline → focused test and suite inline → parent reports
```

Large task pattern (no Writer rule reason; with one, one bounded worker per unit writes instead):

```text
parent clarifies and checks git → parent edits inline following the logbook → focused test and suite inline → parent reports
```

Add agents only where a mechanism's own trigger fires.

### Canonical Lightweight Workflows

Bugfix with unfamiliar flow (understanding exceeds the evidence budget):

```text
parent git/status + clarify → explorer maps flow/files → worker implements authorized fixes + tests → focused verification → parent reports
```

Conflict or dependency-marker cleanup:

```text
parent reproduces/checks conflict → parent or worker resolves inside the active scope → verify markers, package/lock consistency, and repository cleanliness → parent reports
```

After tooling/worktree incident:

```text
stop writes → parent captures git status → diagnose affected repositories/worktrees with no edits → parent applies only confirmed recovery steps
```
