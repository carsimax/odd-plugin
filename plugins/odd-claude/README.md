# odd-claude

A global Claude Code harness (installed with a TUI, no longer a plugin) that ports the ODD harness of gentle-shell (MIT) <!-- odd-check: allow --> to Claude Code. **v2.0** adds native receipt-driven review (RDD) on top of **v1.0** (the parity release): the ODD persona, orchestrator rules, agents, skills, native integrations, advisory review and lifecycle hooks. Apart from the RDD Stop settle reminder, which can block only when you turn RDD on (it is off by default), the plugin ships **no deny/ask/block hook and no `permissions.deny` by default** (user decision, v0.5, amended for v2): its hooks only add context. Coordinator mode and the admission rules are prompt text, not enforcement; otherwise the only enforcement is Claude Code's native permission system (see [Permission modes](#permission-modes)). The plugin collects no data and sends nothing anywhere.

## What's new in 9.1.1

Not breaking:

- Installer: user state is kept through plugin migration; `restore` backs up first; a corrupt settings-state file now fails with a readable error; extras you turn off are undone; retired hook events are removed; install and update take a lock so two runs cannot overlap.
- Update and release: `odd-claude update` checks the latest release live instead of a cached answer; a prerelease rolls back in the right order; the release script now requires `--bundle` and a clean `dist/`.
- Hooks: sessions started with `--agent` are no longer treated as subagents; session files older than 7 days are pruned; the token count no longer guesses from file size.
- CLI: failures print an error and exit non-zero; `/odd-setup` and `/odd-status` honour `CLAUDE_CONFIG_DIR`; `/odd-status` now reports the hooks registered in `settings.json`.
- Review: an unreadable lineage stops the review instead of duplicating it; reviewer processes are killed when the server stops.
- Existing installs get the fixes on `odd-claude update`.

## What's new in 9.1.0

Not breaking:

- New `codegraph` CLAUDE.md block: `codegraph_explore` first for structural questions (before Grep/Read, with fallbacks); each call counts in the inline evidence budget; a blast-radius check comes before `Risk: none`; delegates are told to use it; `.codegraph/` is never committed.
- Engram block reinforced: recall before deciding (project-scoped `mem_search`), broad save triggers plus releases, topic keys and update instead of duplicating, and a `## Prior context (Engram)` section in delegation handoffs (workers never run broad recall).
- `odd-delegation` and `odd-verification` carry short references (handoffs pass Prior context and codegraph-first; the verifier checks the diff's blast radius with codegraph).
- Two duplicated sentences were removed from `odd-delegation` to stay within the 24,000-byte always-on budget.
- Every agent that has the codegraph tool (worker, verify, jd-fix, judges, review lenses) now uses it first, with a Read/Grep fallback.
- Existing installs get the new block on `update`.

## What's new in 9.0.1

Not breaking:

- `update` (CLI and TUI) now re-applies hooks, MCP and extras with the NEW version's installer (it spawns the new version's bin with an internal command), so a migration shipped in a new version runs in the same update. An older target without that command falls back to the running version with a warning.
- The re-apply has its own 300 s timeout, and a timeout is reported as a failed step.
- Updating from 8.x to 9.0.x still needs `update` twice (the 8.x installer runs first); from 9.0.1 on one run is enough.

## What's new in 9.0.0

**Breaking.** odd-peers is retired:

- The `odd-peers` MCP server, the `/odd-peers` skill, its hooks, CLI and libs are removed. Use Claude Code's native cross-session messaging (`ListAgents`/`SendMessage`); inbound messages follow your `crossSessionInbound` setting (accept|hold|refuse), and a peer message is never consent. See [Cross-session messaging (native)](#cross-session-messaging-native).
- `update` removes the `odd-peers` server the installer had added (a foreign one is never touched; one you already removed by hand is just dropped from the state), the copied `odd-peers` skill and the `peers/` data dir.
- Updating from 8.x needs `odd-claude update` run twice: the first run executes the 8.x installer, which does not retire odd-peers, and the second completes the migration. From 9.0.1 on, `update` re-runs its integration step with the new version's installer, so one run is enough.
- GitHub workflows are removed: releases are manual, see [Releasing (manual)](#releasing-manual). The rules now point cross-session messaging to the native tools.

## What's new in 8.3.0

Not breaking. The installer does not change any setting; you get the new rules after `update`:

- Same-file writers no longer use `EnterWorktree` (it moves the main session, not a subagent): units that need the same file now run one at a time in the same tree.
- An isolated writer (Agent `isolation: "worktree"`) is used only when your settings set `worktree.baseRef` to `"head"`; otherwise the worktree starts from the remote default branch and misses the feature branch. The parent integrates kept worktree changes (no automatic merge).
- The Coordinator mode ON rule notes that `/rewind` does not undo subagent or Bash-only edits, so the parent captures `git status` before launching writers.

## What's new in 8.2.1

Not breaking. The shipped payload is unchanged, so there is no behavior change for users:

- New conformance spec (`src/conformance/payload-manifest.spec.ts`) that validates the release payload manifests, the installer's equivalent of `claude plugin validate`: agent, skill and output-style frontmatter, and the `hooks.json` schema.
- It runs under `npm test`.

## What's new in 8.2.0

Not breaking. Enforcement stays opt-in (`odd/tasks/enforcement-opt-in.md`):

- Advisory PreToolUse notices, never blocking: a coordinator write (`Edit`, `Write`, `NotebookEdit`) from the main thread while Coordinator mode is ON, and a subagent `git commit`, `git push`, `gh pr create` or `gh pr merge`. The subagent match is lexical.
- Opt-in `/odd-setup deny-profile install|remove`: 14 `permissions.deny` rules (secrets and `git push`/`gh pr merge`). You run it, it is reversible (`remove` deletes only the rules it added, `restore` still works), and the installer never writes it. Limits: `Read` deny is best-effort for Grep/Glob and Bash file commands, and `Bash(...)` rules are not a security boundary.
- Agent frontmatter is unchanged: Claude Code has no documented way to restrict Bash partially in subagent frontmatter, and `odd-verify` needs Bash for its probes. The documented route is the deny profile.
- Specs for the `StopFailure` and `SessionEnd` handlers; the README now matches the code on the statusline (the installer still installs it by default).

## What's new in 8.1.1

Not breaking. Two odd-4r-review fixes found in the first live run of the workflow:

- A lens reply with an empty `lens_results` array used to pass validation and be reported as a clean lens; it now counts as a failed lens.
- The optional intent is now fenced in `<intent>` after the untrusted-data warning and capped at 2000 characters.

## What's new in 8.1.0

Not breaking. On-demand capabilities (`odd/tasks/on-demand-capabilities.md`):

- 4r-review now runs as the `odd-4r-review` workflow, with an inline fallback when workflows are unavailable.
- The installer writes `effort:` per role into the agents (skipped for haiku) and installs `workflows/*.js`.
- The `odd` skill is slimmer, and skill descriptions are capped at 200 characters.
- The odd-review tool description note is stated once, and the registry prose is slimmer.
- Known limitation: a custom per-role effort is reset to balanced on reinstall.

## What's new in 8.0.0

**Breaking: the lazy cards payload is removed; the orchestrator cards are now fused, de-duplicated always-on rules (`rules/odd-delegation.md`, `rules/odd-verification.md`, `rules/odd-skills.md`) installed under `~/.claude/rules/`.** Their content is fused and de-duplicated into `rules/odd-delegation.md`, `rules/odd-verification.md` and `rules/odd-skills.md`, installed under `~/.claude/rules/` without `paths:` so they load at session start like `CLAUDE.md`. The "read card X" indirection is removed; the provenance table moved to `support/SOURCES.md`, which is not loaded into context.

## What's new in 7.0.0

**Breaking: the persona slash command is removed (there is one neutral persona, carried by the output style), and so are the duplicated tracking and memory orchestrator cards** (their rules now live in the managed CLAUDE.md blocks and `rules/odd-tracking.md`). The always-on context moved out of the output style and the hooks into files Claude Code loads natively.

- **Managed CLAUDE.md blocks.** The installer writes nine blocks into `~/.claude/CLAUDE.md` (`identity`, `protocol` and seven more, sources in `claude-md/01-identity.md` ... `09-codegraph.md`; `memory` carries the Engram recall-before-deciding, save-trigger and `## Prior context (Engram)` handoff rules, `codegraph` the use-`codegraph_explore`-first rules), each wrapped as `<!-- odd-claude:ID -->` ... `<!-- /odd-claude:ID -->`. Text you wrote outside the markers is never touched, and the file is created if absent. Install and update are idempotent; a block you edited by hand is a conflict: it is reported and kept, not overwritten. Uninstall removes only the blocks it owns and that are unedited, and deletes `CLAUDE.md` only if nothing else is left in it. <!-- odd-check: allow -->
- **Budget.** The managed blocks total about 32 KB, and a test fails if they exceed 80,000 bytes (about 20k tokens at 4 bytes per token).
- **Rules.** `~/.claude/rules/odd-tracking.md` carries the feature-document tracking rules and is path-scoped (`paths: odd/tasks/**`, `odd/**/*.md`), so it loads only when Claude reads matching files. It is installed as a whole file through the manifest like any other file; an edited copy is kept on uninstall.
- **Output style `odd`.** Same name (`outputStyle: "odd"` stays valid) but now only a neutral persona and tone (about 4.6 KB, neutral Spanish, no voseo); the ODD protocol lives in the CLAUDE.md blocks.
- **Read-only agents.** `odd-explore`, `odd-review-*` and `odd-jd-judge-*` set `omitClaudeMd: true` so they do not load CLAUDE.md (needs Claude Code 2.1.271 or later). `odd-worker`, `odd-verify` and `odd-jd-fix` keep it. The user-only skills `odd-skill-registry`, `skill-creator` and `skill-improver` set `disable-model-invocation: true`.
- **Session context.** `SessionStart` now injects only per-session lines (coordinator mode, background policy, scratch dir, profile, integrations, reinjection after compact/resume, peers); `SessionStart` context went from 3,122 to 1,476 bytes. `UserPromptSubmit` is unchanged.

## What's new in 6.0.0

**Breaking: odd-claude is no longer a Claude Code plugin.** It installs globally with a TUI or scripts (see [Install](#install)). The plugin manifest, the marketplace and `.mcp.json` are gone; the installer registers hooks, the output style, skills, agents and MCP servers in `~/.claude`. Names lost the plugin namespace: see [Migrating from the plugin](#migrating-from-the-plugin).

## What's new in 5.3.0

Harness refinements from `odd/tasks/harness-research.md`. No breaking changes.

- **Done-when per task and a feature-document lint:** every task line carries `done when: <observable check>`. `node dist/cli/tasks.js [--json] [--cwd <dir>]` lints `odd/tasks/*.md` (open tasks on a closed branch, done without a Log entry, open without done-when, missing sections), read-only and shown by `/odd-status`.
- **`odd-verify` calibration:** a skeptical default (an item is unmet until your own observed evidence shows it met) plus five worked verdict examples that restate existing rules; no new rule.
- **`review_status` `detail: "concise"`:** optional argument, default `"full"` (output unchanged). Concise drops only the projection detail and per-slot artifact subjects; every id, binding, `next_transition`, forecast and repair field stays.
- **Research:** `docs/research/ai-leaders-harness.md` maps harness guidance from AI leaders to odd-claude, with sources.

## What's new in 5.2.0

Session retrospective and pressure-tested skills. No breaking changes.

- **`/odd-retro` (`odd/tasks/retro-pressure.md`):** on-demand retrospective of a session. A local, read-only digest (`node dist/cli/retro.js [--json]`) lists, with transcript line numbers, human prompts, tool errors, repeated reads, edits and commands, subagent launches and compactions; the skill then judges it against the ODD rules and proposes harness changes (proposals only). Prompt and tool-result content is never printed and nothing leaves the machine.
- **Pressure testing in `skill-creator` and `skill-improver`:** a discipline skill runs a RED baseline (stacked pressures such as time, sunk cost, authority, economic, exhaustion, social, pragmatic, run by a fresh subagent without the skill), then GREEN (same scenario with the skill) and REFACTOR (a counter for each new rationalization, retest). See `skills/skill-creator/references/pressure-testing.md`.
- **Context cost:** `output-styles/odd.md` is unchanged; everything loads on demand. Techniques adapted from obra/superpowers (MIT), see `support/SOURCES.md`. <!-- odd-check: allow -->

## What's new in 5.1.0

Rule hardening and two debugging skills. No breaking changes.

- **Rule hardening (`odd/tasks/harden-rules.md`):** the `odd` skill has a completion gate: no completion, fix or pass claim without evidence observed this turn (claim / requires / not-enough table and red flags). The worker has a test-first excuse table and a never-weaken rule (no deleting, skipping or loosening tests to reach green unless the spec authorizes it). The verifier no longer receives the writer's success claims, only the artifact, the contract and the writer's reported commands and output, and treats an unauthorized weakening as a blocker.
- **New skills (`odd/tasks/debug-feedback.md`):** `/systematic-debugging` (no fix before an observed root cause; reproduce, localize, one hypothesis at a time, regression test seen failing first) and `/receiving-review` (read all items, clarify, verify each against the code, then accept, push back with evidence or ask). The worker's bug-fix rule: root cause first; after three failed attempts, counting the first fix, return `partial`.
- **Context cost:** `output-styles/odd.md` is unchanged; all new rules load on demand (skills, agents, cards). Techniques adapted from obra/superpowers and addyosmani/agent-skills (MIT), see `support/SOURCES.md`. <!-- odd-check: allow -->

## What's new in 5.0.0

Refinement round (`odd/tasks/refine-v5.md`): the harness leans on native Claude Code capabilities, repeats fewer rules and costs less per event. One change set is breaking, see [Upgrade notes for 5.0.0](#upgrade-notes-for-500).

- **Native leverage:** every agent has a `color` in its frontmatter. After `compact` and `resume`, SessionStart re-injects a short summary of the active feature document (`odd/tasks/*.md` whose header names the current branch: path, header, `S#` IDs, open tasks, last Log entry, at most 2000 characters). `StopFailure`, `SubagentStart` and `SubagentStop` run with `async: true`, so recording no longer blocks the turn. The `status` and `doctor` skills compute their report through `!` dynamic context.
- **One source per rule:** task size, evidence budget, writer and verifier rules, test-first, allowed edit surfaces, language, coordinator mode and skill paths each live in one place (`output-styles/odd.md` is the index; the session context owns coordinator and language text) and the cards point to it. Stale references were removed. Prompts name the native task tools `TaskCreate`/`TaskUpdate` (`TodoWrite` when they are unavailable).
- **Lighter hooks:** `UserPromptSubmit` no longer loads the peers, stats or subagents modules (`isValidSessionId` and the transcript path helper moved to small modules), and the context backstop reads a 32 KB transcript tail once its notice has fired.
- **Review engine:** engine lens reviewers now apply each lens's `## Review rules` charter from `agents/odd-review-<lens>.md` (the same source `4r-review` uses); if the charter cannot be read the run fails closed with `lens_charter_unavailable` (shown as the `reviewer_prompt_unavailable` block). One shared pid liveness probe (`src/lib/pid.ts`) replaces four copies. Agent escalation is removed.
- **Measured (`npm run measure -- --runs 15`, Node v26.12.1, before = 4.0.0 baseline, after = 5.0.0):**

| Measure | Before | After |
|---|---|---|
| Output style (bytes) | 10352 | 10700 |
| SessionStart context (bytes) | 3360 | 3257 |
| UserPromptSubmit context (bytes) | 151 | 151 |
| Frontmatter descriptions (bytes) | 5334 | 5282 |
| Agent bodies: worker / verify (bytes) | 15825 / 14652 | 15477 / 14209 |
| SessionStart median/p95 ms (modules) | 80.1/89.9 (21) | 78.0/80.5 (26) |
| UserPromptSubmit | 86.4/89.1 (15) | 76.5/79.5 (15) |
| PreToolUse | 79.3/86.0 (7) | 72.4/75.0 (8) |
| PostToolUse | 75.9/92.5 (10) | 73.5/79.7 (11) |
| StopFailure | 73.4/77.9 (6) | 73.3/79.5 (7) |
| Stop | 73.1/75.9 (8) | 73.6/75.9 (9) |
| SessionEnd | 76.1/107.0 (11) | 75.1/79.1 (13) |
| SubagentStart | 73.5/76.3 (6) | 76.1/81.5 (7) |
| SubagentStop | 74.2/77.3 (6) | 79.8/92.3 (7) |

  Latency is process start plus module load and varies a few ms between runs; the output style grew because handoff and synthesis rules now live there once instead of in cards. Per-event cost of the recording hooks no longer blocks the turn (async).

## Upgrade notes for 5.0.0

- **Breaking, no `escalate`:** `review_assess`, `review_start` and `review_run` no longer accept `escalate`; passing it is `invalid_input`. The `escalation` and `escalation_detail` response fields are removed.
- **`review_assess` is read-only:** it writes nothing. The risk tier is decided by assess alone.
- **Old store ignored:** a 4.x `<git-common-dir>/odd-plugin/review-escalations.json` is ignored and safe to delete.
- **`/skill-creation` is removed:** use `/skill-creator`.
- **More engine findings:** engine lens reviews may report more findings because they now apply the lens charter.

## What's new in 4.0.0

Alignment with upstream v5 (`odd/tasks/upstream-v5.md`). Two changes are breaking.

- **Breaking, delivery check is warn-only:** a `git push` or `gh pr create|merge` with RDD on and an unreviewed candidate now runs and shows ONE advisory notice ("RDD: this repository has an unreviewed candidate; review it before delivery."). The `PreToolUse` hook never denies, asks or blocks, and any failure (unresolved repository, git error, not a repository) shows nothing. The blocking gate, its committed-range assessment, its fail-closed rules and `ODD_CLAUDE_GATE_BUDGET_MS` are removed. The Stop settle reminder stays and is now the only thing that can block, and only with RDD on.
- **Breaking, `escalate` is an object:** `review_assess` (and `review_start` / `review_run` on a fresh START) take `escalate: {"item": 1-6, "reason": "<one line, non-empty, at most 500 UTF-8 bytes>"}`; it was a boolean on `review_assess`.
- **Escalation reaches Stop and delivery:** an agent escalation is recorded for that exact candidate and feeds the review-due decision that the Stop reminder and the delivery notice share. A changed candidate drops it, it can only raise the tier, and on a fresh START it freezes the tier as high.
- **`escalation` response field:** every tool that takes `escalate` reports `recorded`, `ignored_existing_lineage` (the candidate already has a lineage, or `review_run` resumes one) or `not_recorded` (no candidate, a refused START, or an unusable or busy store), plus a short `escalation_detail`. A valid escalation is never dropped silently. A refused START records nothing, and an unusable store degrades instead of failing: the assessment still returns and the START still runs, with `not_recorded`. The store write is locked with a bounded wait (about 1.5 s) and a corrupt store is preserved once as `review-escalations.json.corrupt-<timestamp>-<pid>` instead of being overwritten.
- **`odd-verify` skips sensitive files:** the verifier's scratch copy skips `.env*`, `.netrc`, `.ssh/`, `.credentials/`, `Keychains/`, `.aws/credentials`, `.config/gh/hosts.yml`, `secrets/`, `auth.json`, `*.pem`, `*.key`, `*.p12` and `*.pfx` (case-insensitive, any depth) and reports them under `skipped sensitive` instead of refusing.
- **Judgment Day dispatch:** finding IDs follow `JD-[A-Z][A-Z0-9]*-\d+` (for example `JD-A-001`), and the frozen ledger hash is the lowercase SHA-256 of the canonical compact, sorted-key JSON of the array of the dispatched rows (not of their text).
- **Fixed:** relative references inside a `SKILL.md` now resolve from the skill's own directory.

Upgrade notes for 4.0.0:

- If you relied on RDD to stop a delivery without a receipt, it no longer does: review the candidate before you push (`review_status`), or watch for the notice. Nothing needs to change in your settings; `ODD_CLAUDE_GATE_BUDGET_MS` is ignored if you set it.
- If you call `review_assess` with `escalate: true`, send `escalate: {"item": N, "reason": "..."}` instead.

## What's new in 3.0.0

Simplification: removes the hooks module and the visual extras.

- **Removed:** the startup banner, the themes (`odd`, `odd cute`, `odd bold`), the visual mods (the hooks module and per-spawn agent routing), the old statusline (the setup subcommand and its `node '<data dir>/statusline.mjs'` shim; the installer later reintroduced a status line, see below) and the `agents`, `changes` and `quiet` commands (`odd/tasks/simplify.md`).
- **Stays:** the `odd` output style, model profiles (they apply through the SessionStart context line, no mod needed) and `/odd-stats` (subagent recording is kept).

Upgrade notes for 3.0.0:

- If you picked one of the `odd`, `odd cute` or `odd bold` themes with `/theme`, pick another one: they no longer ship.
- If you enabled the statusline, your `~/.claude/settings.json` may still have a `statusLine` entry pointing at the old shim (`node '<data dir>/statusline.mjs'`). Remove that `statusLine` key by hand (or run `/odd-setup restore` to go back to a backup taken before it); the plugin no longer used that shim, and nothing else in your settings is touched. The shim file in the plugin data dir is inert and can be deleted. Today's installer writes a different `statusLine` (`bash "<odd root>/statusline/statusline.sh"`, installed by default; pass `--no-statusline` to skip it), so a stale `node '<data dir>/statusline.mjs'` entry is replaced on the next install and restored or removed on uninstall.
- The banner command and the statusline subcommand of `/odd-setup` are gone (the installer's status line is a separate path); setup still handles `permissions.defaultMode` and `restore`.

## What's new in 2.3.0

**Balanced by default.** A minor bump with two behavior changes to read in the upgrade notes.

- **Balanced profile is the default.** The `balanced` preset carries the new per-role models, and it applies when no profile was chosen. Economy, max and custom remain; `clear` returns to balanced.
- **Native RDD reviewers follow the active profile per role** (risk, resilience, readability, reliability, refuter, validator). An explicit model passed by the caller still overrides it.
- **`odd-explore` runs on haiku in every preset**, and the orchestrator launches several explorers in parallel on distinct fronts for deeper context.
- **One persona only: neutral**, with neutral Spanish (no voseo). The mentor persona and the persona command are removed; the neutral persona is the output style.

Upgrade notes:

- If you relied on "no profile = session model", agents now get the balanced models unless you pick another profile (`/odd-profiles`).
- If you relied on the mentor persona, it no longer exists; neutral is used instead.

## What's new in 2.2.0

**Production readiness.** A minor bump, but the Node minimum rose, so read the first item.

- **Node 22 is now required.** Node 20 is end of life. Upgrade Node before updating the plugin (`engines.node` is `>=22`).
- CI runs on Linux and macOS with Node 22 and 26.
- Store lock: a dead lock owned by this machine is recognized after a hostname change (machine id plus boot / pid-namespace identity). A container sharing the state directory never takes a live lock.
- Install: the engram marketplace must be added first (`engram@engram` is a required dependency).
- Bench baseline: 2.1.0.

## What's new in 2.1.0

**Peer orchestrators (R07).** One Claude Code session on this machine can send a short message to another live session, with the recipient's human consent. Historical: retired in 9.0.0 in favor of native messaging, see [Cross-session messaging](#cross-session-messaging-native).

- Historical (2.1.0 only): consent files, three `odd_orchestrator_*` MCP tools in a `peers` server and delivery through hooks. All of it was removed in 9.0.0.
- Everything a hook injects together stays under a 9000-character context budget; a message that does not fit stays queued, an oversized one is truncated.
- Limits: message 1-8192 bytes, reason 8-512 bytes, 50 queued messages per mailbox, 10 per minute per sender, 24 h TTL. A model with shell access can bypass the consent files; Bash approval is the boundary.
- Review store: the abandoned lineage sweep removes inert lineage directories left by a crash in the middle of START (at most 16 per call, older than one hour, under the store lock; see "Abandoned lineage directory" under RDD).
- Version 2.1.0 is a minor bump: new feature, no breaking change.

## What's new in 2.0.0

**Native receipt-driven review (RDD).** A TypeScript review engine ships in the plugin: review tools over MCP, isolated `claude -p` reviewers, a Stop settle reminder and a `git push` / `gh pr` delivery notice (v2.0 shipped it as a blocking gate; it only warns now, see [What's new in 4.0.0](#whats-new-in-400)). It is **off by default** and has an off switch that always wins. See [Receipt-driven review (RDD)](#receipt-driven-review-rdd).

- New: the `review` MCP server (`review_*` tools), the `review-mode.js` switch CLI, a `PreToolUse` hook on `Bash` in `hooks/hooks.json`.
- Changed: the "no deny" rule now has a scoped exception: the RDD delivery gate and Stop settle reminder could block, and only with RDD on (user decision S3, 2026-11-19; the delivery gate only warns since 4.0.0). Everything else stays advisory.
- Not in 2.0.0: recover, reclaim, quarantine and legacy maintenance of the review store, and a few other items (see the [roadmap](../../docs/roadmap.md)). Inter-session peer orchestrators (R07) shipped in 2.1.0: retired in 9.0.0, see [Cross-session messaging](#cross-session-messaging-native).
- Version 2.0.0 is a major bump because a hook can now deny a command (with RDD on).

## Receipt-driven review (RDD)

RDD asks a high-risk change to earn a review receipt before it is delivered. It is a native TypeScript engine (state machine, authority store, isolated reviewers, MCP tools, Stop reminder and delivery notice), written for odd-claude from the behaviour of the upstream engine. **It is off by default.** With it off, nothing in this section can block anything, and the review tools still work if you call them.

### Quick path

1. Turn it on: `node dist/cli/review-mode.js enable` (see [Switch](#switch)).
2. Work as usual. When you stop with an unreviewed high-risk candidate, the `Stop` hook blocks once with a reminder to review it.
3. Review through the MCP tools: `review_status`, then the `review_start` it offers. Medium and high risk **relay a consent question to you**; nothing starts until you answer.
4. `git push` and `gh pr create|merge` always run. While the candidate is unreviewed, the delivery hook shows one notice; after the review is approved and acknowledged (or declined) it shows nothing.

### Switch

```sh
node dist/cli/review-mode.js status [--cwd <repo>]                        # read-only
node dist/cli/review-mode.js enable|disable                               # user-wide (plugin state, review-mode.json)
node dist/cli/review-mode.js enable|disable --scope clone --cwd <repo>    # <git-common-dir>/odd-plugin/review-mode.json
```

| Rule | Behaviour |
|---|---|
| Default | Off. |
| Scopes | The user-wide value decides; a clone-local override can only **disable**. `enable --scope clone` clears that override. |
| The off switch wins | Any off is off. An unreadable, malformed, oversized or symlinked source fails closed **to off**. |
| Exit codes | 0 ok, 1 failure, 2 usage. |

Turning it off silences the reminder and the notice below. Nothing is sent anywhere.

### What blocks, and what only warns

The only block the plugin can emit is the Stop settle reminder (user decision S3, amending the v0.5 "no deny" rule; narrowed by upstream v5 S2), and only with RDD on. No other hook denies, asks or forces continuation.

| Hook | Event | Does | Fires when | Silent when |
|---|---|---|---|---|
| Settle reminder (blocks) | `Stop` | One `block` with a reminder to review. | An unreviewed candidate is **due** (high risk): the workspace, or the committed range ahead of the upstream/`origin/HEAD` default branch when the workspace is clean. Once per session and candidate, claimed before it prints. | RDD off, `stop_hook_active`, declined, consumed, already under review, low or medium risk, no candidate. |
| Delivery notice (never blocks) | `PreToolUse` on `Bash` (30 s) | One `additionalContext` notice; the command always runs. | The command names a delivery (`git push`, `gh pr create|merge`) and the same unreviewed, due candidate the Stop reminder would use exists. | RDD off, no candidate, declined, consumed, already under review, low or medium risk, a command that also changes the candidate (`git commit ... && git push`), and any failure (not a repository, git error, unreadable state). |
| Coordinator write notice (never blocks) | `PreToolUse` on `Edit`, `Write`, `NotebookEdit` (30 s) | One `additionalContext` reminder to delegate writes to `odd-worker`; the call always runs. | The main thread (no `agent_id`/`agent_type`) edits while Coordinator mode is ON. | Coordinator mode OFF, any subagent call, any failure. Works with RDD on or off. |
| Writers-never-commit notice (never blocks) | `PreToolUse` on `Bash` (30 s) | One `additionalContext` reminder that the parent owns git; the command always runs. | A subagent (`agent_id` present) runs `git commit`, `git push`, `gh pr create` or `gh pr merge` (word match). | The main thread, other commands, any failure. Works with RDD on or off. |

**Which commands get the notice.** A word match on the command text, as upstream does: `git ... push` and `gh ... pr create|merge`. It only decides whether to read the review status once, so a spurious match costs at most one harmless notice, and a miss (an alias, a script, `$(echo git) push`) shows nothing. It never decides whether the command runs.

**Read-only.** Neither hook starts a review, answers consent or writes authority. The Stop reason routes you to the review tools and names the real off switch (`review-mode.js disable`).

### Review MCP tools

A stdio server, `dist/mcp/review-server.js`, registered by the installer as the user-scope MCP server `odd-review`. It has no dependencies, speaks the minimal MCP stdio protocol (`initialize`, `tools/list`, `tools/call`, `ping`, cancellation) and writes only protocol messages to stdout. Claude Code lists the tools as `mcp__odd-review__<name>`. The names are bare (`review_*`) because the plugin guard forbids an `odd`-prefixed review tool name in shipped files.

| Tool | What it does |
|---|---|
| `review_assess` | Read-only: freeze the candidate and classify risk, reasons and changed paths; starts nothing, creates no lineage and writes nothing. The tier is decided by this assessment alone. |
| `review_inspect` | Read-only: lineages of this repository (state, risk, revision), unreadable ones, and the RDD mode. |
| `review_status` | Read-only status envelope. Follow only its `next_transition`. Optional `detail`: `full` (default) or `concise`. |
| `review_start` | Start a review. **Always relays consent** for medium/high risk and creates nothing; low risk is approved at once. |
| `review_answer_consent` | Records your explicit `granted` / `declined` for the envelope's exact `target_identity`. |
| `review_capture`, `review_capture_group` | Admit one reviewer slot, or the whole ordered group status issued, then stop. |
| `review_complete` | Settle a fully reviewed lineage that status offers as `review.validate`. |
| `review_acknowledge_approved` | Acknowledge an approval once (receipt, then burn). |
| `review_run` | Drive start, reviewers, capture and acknowledge by following status; typed outcomes. |

Conventions:

- **Literal transitions.** A `next_transition` can be taken literally: its argument names are exactly the snake_case properties of the tool it names, with string values coerced to the declared type. `command` names the tool to call.
- **Consent is never answered for you.** `review_start` and `review_run` only relay the question; only `review_answer_consent` records an answer, and it is bound to the target identity, lens set and reason (a moved candidate is `binding_drift` and nothing is recorded).
- **Acknowledgement token.** An approval is acknowledged once, with a one-shot token delivered by the capture that approved it. A lost token stops the run as `acknowledgement_token_unavailable`; a second acknowledgement is refused.
- **Reviewers cost money.** `review_run`, `review_capture` and `review_capture_group` first return a **forecast** and run reviewers only when called again with `reviewer_run_acknowledged: true` and that forecast's `reviewer_run_binding`.
- **Typed errors.** Inputs are validated against their JSON schema (`invalid_input`; unknown properties, including `__proto__`, are rejected). Failures are tool results with `isError: true` and `{"error":{"code","message",...}}`; results are capped at 256 KiB. A pending correction lineage is never duplicated (`correction_lineage_pending`).
- **Mode.** The tools work with RDD on or off; the mode only silences the Stop reminder and the delivery notice.

### Where state lives

`<git-common-dir>/odd-plugin/review-transactions/v2/<lineage>/…`, plus `odd-plugin/` lock files, declines (`odd-plugin/declines/`) and the clone override. It never reads or writes the upstream engine's authority or any other tool's tree. Writes are atomic with a revision check; the store lock is a directory with an owner token and a bounded wait (Node has no `flock`). Hashes use the domain `odd-claude.<domain>/v<N>` over one canonical JSON.

### Reviewer isolation

Reviewers run as isolated `claude -p` children: `--print --output-format text --tools "" --permission-mode dontAsk --no-session-persistence --setting-sources "" --system-prompt <isolated reviewer>`, plus `--model`/`--effort`. **Reviewer model.** Without an explicit `model` from the caller, each reviewer child uses the active model profile route of its role (read once per review run; unreadable state is the default `balanced`): lens `risk` -> `odd-review-risk`, `resilience` -> `odd-review-resilience`, `readability` -> `odd-review-readability`, `reliability` -> `odd-review-reliability`, refuter -> `review-refuter`, targeted validator -> `review-validator`. Under `balanced` (effort `medium`) that is opus for risk, refuter and validator and sonnet for the other three lenses; `economy` gives haiku (no `--effort`) to the lenses and sonnet to refuter/validator. An explicit `model`/`effort` passed to `review_run`/`review_capture*` overrides every role (and the forecast binding covers it). `/odd-profiles` changes the routes. The rest of the argument vector is unchanged. **Never `--bare`** (it breaks subscription auth). The prompt goes on stdin; the child gets an environment **allowlist** (identity, locale, `ANTHROPIC_*`/`AWS_*`, `CLAUDE_CONFIG_DIR`, OAuth/Bedrock/Vertex switches, proxy and CA variables), so `NODE_OPTIONS`, `LD_*`/`DYLD_*`, `BASH_ENV`, `GIT_*` and plugin variables never reach it. Its process group is killed on every close, with a time and output budget.

### Documented limits

- **Lexical notice.** The delivery notice reads the command text. Known misses: a delivery through a shell alias or a script, `$(echo git) push`, here-strings, and `gh api`; they show no notice and nothing else changes, because the notice never blocks.
- **Accepted advisories.** An untracked `.git` file that redirects the repository can only be created by someone who can already write the clone's own override, so it is not defended against.
- **Locks.** Takeover of a dead lock needs proof of death: the owner must be local and its pid dead. The owner records `host`, a stable random `machine` id (persisted at `${XDG_STATE_HOME:-~/.local/state}/odd-plugin/machine-id`) and a `boot` identity (Linux: boot_id plus pid namespace; macOS: `kern.bootsessionuuid`). It is local by id only when machine id AND boot identity exist on both sides and are equal, so a changed hostname (macOS network changes) no longer blocks it and a container or another host sharing the state directory never counts as local. In every other case (older record, missing id or boot, different ids) the hostname is compared as before, and a changed hostname there is never taken over (fail closed: remove `LOCK` by hand after checking the owner). Two machines with the same hostname sharing a store over a network filesystem remain a limit of the hostname rule. Likewise, a container that mounts the state directory AND has the same hostname as the host falls under the hostname rule (it is treated as local), as two NFS machines sharing a hostname do. A pid reused by another live process is never taken over. A complete claim-exclusivity guarantee needs a no-replace rename (`RENAME_EXCL`/`RENAME_NOREPLACE`), which Node does not expose; the claim protocol narrows the window but cannot close it. Dead `LOCK` directories are reclaimed on the next mutation, not by a read.
- **Abandoned lineage directory.** A crash in the middle of START can leave an empty lineage directory (or one holding only an `.atomic-*` temp). It is inert (never read as state, reported by `review_inspect` as unreadable, a restart opens a new lineage). The next START sweeps, under the store lock, at most 16 per call of those older than one hour, examining at most 512 old lineage directories per call (a directory that holds a `review-state.json` is live and skipped without using that budget, so live lineages no longer count against that cap; abandoned directories past the first 10000 lineage entries, or behind 512 or more old non-removable directories, are not reached); it never removes a directory with a state, a receipt, a `LOCK` or any other file, never follows a symlink, and read-only tools never sweep.
- **Deferred.** Recover, reclaim, quarantine and legacy maintenance are not part of v2 (see the [roadmap](../../docs/roadmap.md)).

## What's in v1.1

Statistics and profiles (Phase 5), unchanged in 2.0. The visual mods, the banner, the old statusline shim and the `agents`, `changes` and `quiet` commands were removed in the simplification pass (`odd/tasks/simplify.md`).

- `/odd-stats` (R36): local session stats from the transcript.
- `/odd-profiles` (R39/R40): model profiles and per-spawn routing.

| Feature | How it works |
|---|---|
| stats | `/odd-stats` text |
| profiles / routing | session context lists the profile and the orchestrator passes `model`; applies from the next session start or `/clear` |


**Interactive checks (2026-11-21, Claude Code 2.1.330, `--plugin-dir`, driven through a pseudo-terminal).** Observed on a clean install (isolated `CLAUDE_CONFIG_DIR`): without the engram marketplace the install warns as above; with the three `claude plugin …` commands in the order above, both plugins were enabled and a session loaded odd-claude with its `SessionStart` context and the `codegraph`, `review` and `peers` MCP servers connected.

## What's in v1.0

- **Commands / skills** (`/<name>`): `odd`, `odd-doctor`, `odd-status`, `odd-setup`, `odd-coordinator`, `odd-background-subagents`, `odd-scratch`, `odd-stats`, `odd-profiles`, `odd-skill-registry`, `skill-creator`, `skill-improver`, `4r-review`, `judgment-day`, `branch-pr`, `chained-pr`, `work-unit-commits`, `issue-creation`, `comment-writer`, `systematic-debugging`, `receiving-review`, `odd-retro`, `cognitive-doc-design`, `tui-design`, `ui-design`.
- **Agents** (`<agent>`): `odd-explore`, `odd-verify`, `odd-worker`, `odd-jd-fix`, `odd-jd-judge-a`, `odd-jd-judge-b`, `odd-review-risk`, `odd-review-resilience`, `odd-review-readability`, `odd-review-reliability`.
- **Hooks** (advisory; only the RDD-gated Stop reminder can block): `SessionStart` (context, scratch dir, title, status file, skill registry, optional codegraph warm-up; on `compact` and `resume` also a compact summary of the active feature document: the `odd/tasks/*.md` file whose header names the current branch, with its path, header line, `S#` ids, open tasks and last log entry, capped at 2000 characters, nothing when there is no match), `UserPromptSubmit` (context, quota advisory), `PostToolUse` (exploration budget, context backstop), `StopFailure` (quota advisory), `Stop` (status file; empty output unless RDD is on, see [RDD](#receipt-driven-review-rdd)), `PreToolUse` on `Bash|Edit|Write|NotebookEdit` (RDD delivery notice, silent unless RDD is on; coordinator write notice and subagent git notice, both advisory; never blocks), `SubagentStart`/`SubagentStop` (record the subagent in session state; silent). `SubagentStart`, `SubagentStop` and `StopFailure` run with `async: true` (their output is never used); no hook that injects context is async. There is no `TaskCompleted` hook: Claude Code only lets it block, not add context, `SessionEnd` (scratch cleanup, resume hint, status file).
- **Output style**: `odd`. **Orchestrator rules**, **support docs** and **sounds assets** (see below).
- **Not implemented, by user decision (2026-11-18):** R57 (notification sounds; the `assets/sounds/` files are only shipped assets) and R63 (GitHub star prompt). Native RDD shipped in 2.0.0; inter-session peers (R07) shipped in 2.1.0, retired in 9.0.0, see [Cross-session messaging](#cross-session-messaging-native).
- **No deny by default, with one scoped exception** (the optional user-run `/odd-setup deny-profile` adds `permissions.deny` rules to your settings only when you ask): the only block the plugin can emit is the Stop settle reminder of [RDD](#receipt-driven-review-rdd), off by default; the delivery check (PreToolUse on `git push` / `gh pr`) and the coordinator and subagent-git reminders only show a notice (see [Permission modes](#permission-modes)).

## Lifecycle hooks (v1.0)

All of these are advisory: none returns a block decision, `continue:false` or a deny, and the `Stop` hook output is empty so it never forces continuation, except for the RDD-gated settle reminder described in [Receipt-driven review (RDD)](#receipt-driven-review-rdd) (off by default).

- **Quota advisory (R35).** `StopFailure` is fire-and-forget in Claude Code, so the hook only logs and arms one advisory shown on the next prompt (30 min cooldown for exhausted quota, 2 min for transient errors). It includes `--fallback-model` guidance (Anthropic models only; see `rules/odd-verification.md`).
- **Session scratch (R56).** A per-session directory `<data>/scratch/<session>` (mode 0700) is created at SessionStart and its path is added to the context; `/odd-scratch` shows it. It is removed at SessionEnd only when it is a real directory whose realpath is exactly `<realroot>/<session>`; symlinks are never followed. Removal first renames the dir to a tombstone `<realroot>/.rm-<pid>-<timestamp>-<session>` and then deletes it; if the process crashes in between, the tombstone stays behind and can accumulate. SessionStart sweeps them: it deletes `.rm-*` entries directly inside the real scratch root that are real directories (never symlinks) and older than 1 hour, at most 200 entries per run.
- **Terminal title (R62).** SessionStart sets the title to `odd-claude · <project>` through `terminalSequence` (plain OSC 0).
- **Resume hint (R64).** SessionEnd prints a resume hint and logs it to `hooks.log`.
- **Agent status file (R70).** `<data>/status/<session>.json` (`schema odd-claude.agent-status/v1`: session, cwd, state `idle`/`working`/`ended`, `updatedAt`; mode 0600, atomic writes). SessionEnd writes `ended` instead of deleting; readers treat it as stale after 30 s.

## What v0.2 shipped

- **Persona / output style `odd`** (`output-styles/odd.md`, set as `outputStyle` in `settings.json` by the installer, so no `/odd-setup` is needed): neutral persona and tone only. The ODD protocol is in the managed `~/.claude/CLAUDE.md` blocks and `~/.claude/rules/odd-tracking.md`; SessionStart and UserPromptSubmit hooks add only per-session `additionalContext` lines. Replies follow the user's language.
- **Persona**: there is one persona, neutral (direct, technical, neutral Spanish), carried by the output style; the persona command and its state are retired. Spanish replies are always neutral: no voseo or regional forms (tú or usted).
- **Orchestrator rules** (`rules/odd-delegation.md`, `rules/odd-verification.md`, `rules/odd-skills.md`): the former lazy cards, fused and de-duplicated against the CLAUDE.md blocks, installed without `paths:` so they load every session (budget: at most 24,000 bytes, enforced by a test); tracking and memory live in the path-scoped rule `rules/odd-tracking.md`. Tool names are mapped to Claude Code (`Agent`, `TodoWrite`, `AskUserQuestion`, `Bash` with `run_in_background`, `Monitor`, worktree tools). Provenance: `support/SOURCES.md`.
- **Agents** (`<agent>`): `odd-explore` (read-only), `odd-verify` (runs checks), `odd-worker` (scoped writer), `odd-jd-fix`, `odd-jd-judge-a`, `odd-jd-judge-b` (Judgment Day), and the four advisory review lenses `odd-review-risk`, `odd-review-resilience`, `odd-review-readability`, `odd-review-reliability`.
- **Skills** (`<skill>`): `odd`, `branch-pr`, `chained-pr`, `cognitive-doc-design`, `comment-writer`, `issue-creation`, `judgment-day`, `skill-creator`, `skill-improver`, `odd-skill-registry`, `systematic-debugging`, `receiving-review`, `odd-retro`, `tui-design`, `ui-design`, `work-unit-commits`, `4r-review`, plus the commands `odd-doctor`, `odd-status`, `odd-setup`, `odd-background-subagents`, `odd-coordinator`.
- **Support docs** (`support/`): test-first policy and the `odd/tasks/<feature>.md` format. **Sounds**: `assets/sounds/` (original tones, see its LICENSE).

### Background subagents

`/odd-background-subagents [enable|disable|status]` sets a policy (default off; env `ODD_CLAUDE_BACKGROUND_SUBAGENTS=on|off` is the fallback). When on, the session context tells the orchestrator to launch independent `Agent` work with `run_in_background: true`. Note that Claude Code itself runs subagents in the background by default.

### Coordinator mode (full delegation)

`/odd-coordinator [on|off|status]` switches the delegation mode; **ON by default**. When on, the session context says `Coordinator mode: ON` and `rules/odd-delegation.md` holds its rules: the main thread does not implement and sends every authorized change to a bounded `odd-worker` (a general-purpose `Agent` is the reported fallback). When off, the orchestrator works inline and delegates only when a trigger fires. The mode is stored in the plugin data dir (`delegation.json`) and applies from the next session start (or `/clear`).

This is a **rule the orchestrator follows, not enforcement**: no hook blocks `Edit`/`Write` in either mode. The same holds for the writer `## Allowed edit surfaces` section, the verifier `Risk:` line and the Judgment Day fix dispatch shape: `rules/odd-delegation.md`, `rules/odd-verification.md` and the `judgment-day` skill state them as rules.

### Exploration budget and context backstop (advisory)

A `PostToolUse` hook (matcher `Read|Grep|Glob|WebFetch|WebSearch` plus the codegraph MCP tools `mcp__codegraph__*`) adds `additionalContext` notices. It **never blocks, asks or denies**: errors are logged and ignored, the timeout is 5 s.

- **Exploration budget (R14).** Counts exploration calls and result text bytes per turn, main thread only (calls from subagents carry `agent_id`/`agent_type` and are skipped). The counters live in session state and `UserPromptSubmit` resets them each turn. With coordinator mode ON, the first time a turn passes the upstream thresholds (more than 3 lookups or 40,000 text bytes) it suggests launching several parallel `odd-explore` agents, one per distinct front; one notice per turn. Coordinator OFF: no notice.
- **Context backstop (R34).** Claude Code gives hooks no context-usage number, so the hook reads `transcript_path`: the prompt tokens (`input + cache_creation + cache_read`) of the last assistant `usage` line, or, if none is in the last 512 KB, `file bytes / 4` as a rough estimate. Past 150,000 tokens (override: `ODD_CLAUDE_CONTEXT_BACKSTOP_TOKENS`) it emits one notice per session suggesting delegating the next bounded unit. A measured reading below the threshold (after compaction) re-arms it. The window size is unknown, so upstream's fraction-of-window rule is not applied. It only runs on the events matched above.
- **Limitation (state lock).** If a hook process dies while holding the per-session state lock and its pid is later reused by another live process, the lock is not reclaimed (reclaiming needs proof of death only). Each `PostToolUse` then waits about 1 s and fails open (the timeout is logged) until you remove the stale `<data>/sessions/<id>.json.lock` by hand.

### Skill registry

On SessionStart the hook reads the existing `.atl/skill-registry.md` (one context line) and starts a detached, locked refresh in the background, so the registry is written or updated without delaying session start (the first start in a project has no line yet; the next start does). The registry is an index of project, user and plugin skills by trigger and path, plus `.atl/.gitignore`. Run it on demand with `/odd-skill-registry`. Another tool may also write `.atl/skill-registry.md`; to stop odd-claude from touching it set `ODD_CLAUDE_NO_SKILL_REGISTRY=1`. Git-tracked registries are preserved on automatic refresh.

### codegraph MCP

The installer registers a `codegraph` MCP server (user scope, needs the `codegraph` binary). The tool is `mcp__codegraph__codegraph_explore`; agent allowlists list it and a tool that is not connected is ignored. The SessionStart warm-up (detached `codegraph sync`) is **off by default**: a `.codegraph/` directory comes from the repository and is not a trust signal. Opt in per project: `node ~/.odd-claude/current/dist/cli/codegraph-trust.js --action trust --cwd <project>` (records the path in plugin state; `--action untrust` / `--action list`). There is no environment-variable opt-in: a repository can set env through its own `.claude/settings.json`, so only the trust list the user writes counts.

When trusted and an index exists, SessionStart syncs it. Repeated starts do not overlap: an in-flight lock per project (`<data dir>/locks`, replaced when its process is gone or after 6 minutes) skips the spawn. Other flags: `ODD_CLAUDE_CODEGRAPH_INIT=1` also runs `codegraph init` in a trusted project with no index (opt-in); `ODD_CLAUDE_NO_CODEGRAPH_WARMUP=1` disables the warm-up. It never runs in a home or broad directory.

### Engram tool names

Memory tools are `mem_*`: `mcp__engram__mem_*` when the engram MCP is configured at user level, or `mcp__plugin_engram_engram__mem_*` if an engram plugin ships its own server (`engram@engram` 0.1.22 does not). `odd-worker` lists both `mem_save` names.

### Advisory review (v0.8)

`/4r-review [git range]` (empty = working tree against `HEAD`) runs as the `odd-4r-review` dynamic workflow (installed to `~/.claude/workflows/`), with an inline fallback of parallel `Agent` calls when workflows are unavailable or disabled (`disableWorkflows`). It runs four independent lens reviewers in parallel: `odd-review-risk` (R1), `odd-review-resilience` (R4), `odd-review-readability` (R2) and `odd-review-reliability` (R3). The skill gathers the diff (it validates a git range argument itself) and passes it to the workflow, which merges the findings into one deduplicated, severity-sorted report; a lens that fails is reported, not dropped. It defaults to all four lenses and may skip irrelevant ones, saying so.

- **Advisory only:** the report gates nothing and approves nothing; it has no approval state and no publication gating (the separate [RDD](#receipt-driven-review-rdd) engine has both, off by default). It needs no external review binary and no review tools.
- **Read-only reviewers:** the lens agents allow only `Read`, `Grep`, `Glob` (plus codegraph) and list `Edit`, `Write`, `NotebookEdit` and `Bash` under `disallowedTools`; `src/lib/agents-guard.spec.ts` enforces this for them and for the Judgment Day judges.
- **Judgment Day** (`/judgment-day`) stays independent: two blind judges and at most two fix rounds; it neither requires nor replaces `4r-review`.

### Subagents cannot ask questions

Claude Code removes `AskUserQuestion` from every subagent (verified on 2.1.327). A child that needs a human decision returns `status: interaction_required` and the orchestrator relays it; see `rules/odd-delegation.md`.

## Requirements

| Need | For |
|---|---|
| Node >= 22 | the installer and the hooks |
| `gh`, authenticated (`gh auth login`) | downloading releases of the private repository `carsimax/odd-plugin` |
| `jq` | the status line |
| git | the harness (`/odd-doctor` checks it) |
| Claude Code >= 2.1.323 | the host |
| Engram, codegraph | optional; the installer offers to install them (`--no-deps` skips). The Engram plugin is also a valid way to get Engram |

`/odd-doctor` reports which of these are present.

## Install

One line (needs `gh`):

```
gh api repos/carsimax/odd-plugin/contents/scripts/install.sh -H "Accept: application/vnd.github.raw" | sh
```

Pin a release with `| sh -s -- --version <v>`.

From a checkout:

```
npm --prefix plugins/odd-claude/tui ci && npm --prefix plugins/odd-claude/tui run bundle && node plugins/odd-claude/tui/dist/odd-claude.mjs install --source plugins/odd-claude
```

Afterwards (details in [Installer](#installer)):

| Goal | Command |
|---|---|
| Update | `odd-claude.mjs update` |
| Roll back | `odd-claude.mjs rollback [--to <version>]` |
| Uninstall | `odd-claude.mjs uninstall [--purge]` |

`odd-claude.mjs` is the bundled TUI the installer downloads; run it with `node` (a local checkout builds it at `plugins/odd-claude/tui/dist/odd-claude.mjs`).

### Migrating from the plugin

The installer detects an installed `odd-claude@*` plugin, uninstalls it (so hooks are not duplicated) and copies its state from `~/.claude/plugins/data/odd-claude-*` into `~/.odd-claude/data`. Renames to know:

| Before (plugin) | Now |
|---|---|
| `/odd-claude:profiles`, `/odd-claude:status`, ... | `/odd-profiles`, `/odd-status`, ... | <!-- odd-check: allow -->
| agents `odd-claude:odd-worker`, ... | `odd-worker`, ... | <!-- odd-check: allow -->
| MCP `mcp__plugin_odd-claude_review__*` | `mcp__odd-review__*` | <!-- odd-check: allow -->
| MCP `mcp__plugin_odd-claude_peers__*` | `mcp__odd-peers__*` (server retired in 9.0.0, see [Cross-session messaging](#cross-session-messaging-native)) | <!-- odd-check: allow -->

State lives in `~/.odd-claude/data` (override with `ODD_CLAUDE_HOME`). `CLAUDE_PLUGIN_DATA` and `CLAUDE_PLUGIN_ROOT` are still read as legacy fallbacks.

## Installer

odd-claude installs globally (no plugin) with one file, `odd-claude.mjs`, that needs only Node >= 22. Run it with no arguments in a terminal for the interactive installer, or with a subcommand for scripts:

```
node odd-claude.mjs                      # TUI: Welcome > Detection > Profile > Models > Extras > Dependencies > Review > Installing > Complete
node odd-claude.mjs install --source plugins/odd-claude --dry-run --json
node odd-claude.mjs install --yes --profile economy --model worker=opus
node odd-claude.mjs update | rollback [--to <version>] | models --profile max | backups [--restore <id>] | status | uninstall [--purge]
```

The TUI keys are: up/down to move, enter to continue, esc to go back, space to toggle, left/right to change a model, `q` to quit. Without a terminal and without a subcommand it prints the usage and exits 2; a failed step exits 1.

### Subcommands

| Command | What it does |
|---|---|
| `install` | migrates from the plugin (uninstalls it, copies its state), stages the payload, installs files (including the `CLAUDE.md` blocks and `rules/`), hooks, output style, MCP servers, extras and dependencies, in that order |
| `update` | downloads the latest GitHub release (checksums verified), swaps `current`, re-applies hooks, MCP and extras with the options saved at install; models are kept |
| `uninstall` | reverse order: extras, MCP, output style, hooks, files (owned unedited `CLAUDE.md` blocks and rules); never uninstalls Engram or codegraph |
| `rollback` | points `current` back at the previous (or `--to`) installed version |
| `models` | applies `--profile` / `--model` to the installed version |
| `backups` | lists the backups, or restores one with `--restore <id>` |
| `status` | node, `claude`, `gh`, Engram and codegraph, installed version, plugin install |

### Flags

Every TUI choice has a flag. `odd-claude --help` is the reference.

| Flag | Meaning |
|---|---|
| `--source <dir>` | install from a local checkout instead of the latest release |
| `--profile balanced\|economy\|max\|custom` | model preset; `balanced` (the previous models) is the default on a fresh install, and a reinstall keeps the stored selection |
| `--model <role>=<model>` | per-agent override, repeatable, e.g. `--model worker=opus --model explore=haiku`; models are `haiku`, `sonnet`, `opus`; an override turns the preset into `custom` |
| `--dry-run` | plan only: nothing is written and nothing external is changed |
| `--yes` | non-interactive; confirms the Engram and codegraph installs |
| `--no-deps` | skip Engram and codegraph |
| `--no-statusline` | skip the status line (installed by default: `statusLine` runs `bash "<odd root>/statusline/statusline.sh"`, which needs `jq`) |
| `--keep-claude-ai-connectors`, `--keep-claude-ai-skills`, `--keep-claude-ai-plugins` | leave that claude.ai sync setting alone (by default each is disabled) |
| `--keep-builtin-plugins`, `--disable-builtin <id>` | leave the `@builtin` plugins alone, or disable only the given ones (repeatable); by default every discovered builtin is disabled except managed ones and `cc-plugin-sec-default@builtin` |
| `--purge` | uninstall: also delete the data dir and the backups |
| `--force` | update: skip the 6 hour release-check cache and reinstall the same version |
| `--to <version>` | rollback target |
| `--json` | one machine-readable JSON document |

### What gets written where

```
~/.odd-claude/
  versions/<x.y.z>/     the release payload (dist, agents, skills, output-styles, statusline, ...)
  current -> versions/x.y.z
  data/                 state that used to live in CLAUDE_PLUGIN_DATA (profiles.json, delegation, ...)
  manifest.json         every file installed into ~/.claude with its sha256
  settings-state.json   values replaced in settings.json, MCP servers added, update-check cache, chosen extras
  backups/<timestamp>/  copy of each ~/.claude file before it changed (and settings.json backups)
  bin/odd-claude.mjs    the installer bundle of the installed release
~/.claude/
  skills/, agents/, output-styles/odd.md    copied, with absolute paths resolved
  CLAUDE.md             + 9 managed marker blocks (<= 80,000 B); your own text outside them is never touched
  rules/odd-tracking.md path-scoped rule (odd/tasks/**, odd/**/*.md)
  settings.json         + 9 hooks, outputStyle "odd", statusLine, the claude.ai keys, enabledPlugins for builtins
  MCP (user scope)      odd-review, codegraph
```

`CLAUDE_CONFIG_DIR` and `ODD_CLAUDE_HOME` relocate the two roots.

### Uninstall guarantees

- A file in `~/.claude` is removed only when its hash still matches the manifest; edited or foreign files are reported and kept.
- `CLAUDE.md`: only blocks whose markers and hash still match are removed; an edited block is reported and kept, text outside the markers is never touched, and the file is deleted only when it ends up empty. Rules files follow the file rule above.
- Only our hook entries are removed; other hooks keep their place and order.
- `outputStyle`, `statusLine`, the three claude.ai keys and the `enabledPlugins` entries return to their previous values (absent keys are removed again); a value you changed after the install is kept.
- Only the MCP servers odd-claude added are removed; servers that already existed are never touched.
- Engram and codegraph are never uninstalled. `--purge` additionally deletes `data/` and `backups/`; without it they stay.

## Cross-session messaging (native)

Since 9.0.0 odd-claude ships no peer subsystem. Claude Code's own cross-session messaging replaces the retired `odd-peers` server, `/odd-peers` skill and their hooks ([docs](https://code.claude.com/docs/en/cross-session-messaging.md)).

| Topic | Behavior |
|---|---|
| Tools | `ListAgents` lists other live sessions; `SendMessage` sends one a message. |
| Availability | On by default since Claude Code v2.1.224 (macOS, Linux, WSL 2; native Windows since v2.1.234). |
| Inbound policy | Each inbound message is delivered, held or refused. The `crossSessionInbound` setting takes `accept`, `hold` or `refuse`; the default depends on the permission mode. |
| Bypass mode | A session in bypass-permissions mode holds inbound messages for approval. |
| Consent | A peer message is never consent: it cannot answer a permission prompt, and slash commands inside it do not run. |
| Senders | There is no per-sender allowlist. |

### Migration from 8.x

Running `update` (or `install`) on a machine with an older install:

- removes the `odd-peers` MCP server, but only when the installer state recorded it as added by odd-claude; a server named `odd-peers` you added yourself is never touched;
- deletes the `peers/` directory under the odd-claude data dir (it held only mailbox and grant state);
- keeps `uninstall` working on old and new state files.

From 8.x the migration needs `odd-claude update` twice (the 8.x installer that runs the first update does not know the retirement); from 9.0.1 on one run is enough.

## Commands

- `/odd-doctor` (and `/odd-status`) compute their report through skill dynamic context (`!` command), so the output is already in the prompt; `/odd-doctor`: checks node, git, engram, codegraph, plugin version and data dir; lists what is missing.
- `/odd-stats`: local stats for the current session: turns, tokens in/out/cache and per-model split (from the transcript tail, at most the last 8 MiB, garbage lines skipped), subagent count and finished time (from the R09 state) and the exploration counters. The transcript path (`transcript_path` of the hook input) is saved in session state at `SessionStart`/`UserPromptSubmit`; the skill only passes `${CLAUDE_SESSION_ID}`. No cost lookup, no quota endpoint, no network, nothing leaves the machine.
- `/odd-profiles [list|show|use <balanced|economy|max>|set <role> <model> [effort]|clear]` (R39/R40): a model profile maps each odd-claude agent (`odd-explore`, `odd-verify`, `odd-worker`, `odd-jd-*`, `odd-review-*`) plus the RDD native roles `review-refuter` and `review-validator` to `{model, effort}` in plugin state (`profiles.json`). The agent files in the plugin cache are never rewritten, but the installer (`node odd-claude.mjs`, see [Installer](#installer)) writes the selected `model:` and, for non-haiku roles, the profile `effort:` into the installed agent copies in the Claude config dir (`~/.claude`, or `$CLAUDE_CONFIG_DIR` when set). **`balanced` is the default profile**: it applies whenever no profile was chosen (no state, unreadable or unknown state), `clear` returns to it, and an explicitly chosen `economy`, `max` or `custom` still wins. `balanced` (all effort `medium`): `odd-explore` haiku; `odd-worker` sonnet; `odd-verify` opus; `odd-jd-fix` sonnet; `odd-jd-judge-a` opus; `odd-jd-judge-b` sonnet; `odd-review-readability`/`reliability`/`resilience` sonnet; `odd-review-risk` opus; `review-refuter` opus; `review-validator` opus. `odd-explore` is `haiku` in every preset (balanced and max medium effort, economy low); a `set odd-explore <model>` override is still possible. Explorers are cheap, so whenever exploration is warranted the orchestrator launches several `odd-explore` agents in parallel in one message, each on a distinct front (subsystem, layer, or question: callers, implementation, tests, docs/history), each returning a handoff of at most ~2k tokens with `path:line` evidence that the parent merges (one explorer only for a single narrow front). `economy` and `max` give `review-refuter`/`review-validator` the same model as their judges (sonnet/medium and opus/xhigh). Arguments are validated against whitelists (models `haiku`/`sonnet`/`opus`, efforts `low`..`max`). Routing: the session context lists the active profile so the orchestrator passes `model` in the `Agent` tool call (applies from the next session start or `/clear`). The installed agent frontmatter carries the model and effort (haiku never carries an effort); a per-spawn `model` or `effort` from the parent still overrides them.
- `/odd-status`: shows the current session state, registered hooks and the roadmap position.
- `/odd-coordinator [on|off|status]`: shows or switches coordinator mode (see above).
- `/odd-setup [default|acceptEdits|auto|plan|bypassPermissions|deny-profile install|deny-profile remove|restore [backup]]`: opt-in writer for `permissions.defaultMode` in `~/.claude/settings.json`, and for the optional deny profile (below). Always a diff, explicit confirmation, a 0600 backup, an atomic write and `restore`.
- **Optional deny profile** (`/odd-setup deny-profile install`, user-run; the plugin and its installer never write it): merges `permissions.deny` rules that block Read and Edit of `.env*` files, `~/.ssh/**`, `~/.aws/credentials`, `**/*.pem` and `**/*.key`, plus `Bash(git push *)` and `Bash(gh pr merge *)`. Claude Code applies deny rules to the main conversation and to subagents. It adds only missing rules, keeps your own rules and records which ones it added; `deny-profile remove` deletes only those (a rule you already had stays) and `restore` also undoes it. It is a guard rail, not a sandbox (limits from the [permissions docs](https://code.claude.com/docs/en/permissions)): `Bash(git push *)` does not catch `git -C . push`; Read deny rules are best-effort for Grep/Glob and Bash file commands, so `grep -r` and scripts are not covered; Bash deny rules are not a security boundary. The profile has 14 rules (it also lists the exact forms `Bash(git push)` and `Bash(gh pr merge)`).
  - Always shows a diff first and writes nothing until you explicitly confirm.
  - Before writing, the original file is copied to a backup under the plugin data dir (`backups/`), and only the listed key changes.
  - `restore` shows the diff back to the latest backup (or the named one) and applies it after confirmation. The current file is backed up first, so a restore is itself reversible.
  - Any other argument is refused.

### Permission modes

odd-claude has no permission system of its own: the upstream modes map onto Claude Code's native `permissions.defaultMode`, which `/odd-setup` writes after a diff and a confirmation.

| Upstream mode | Native `defaultMode` | Notes |
|---|---|---|
| Normal | `default` | Claude Code asks before edits and commands. |
| Auto | `auto` | A separate classifier reviews actions instead of prompting. |
| YOLO | `acceptEdits` | Standing approval for file edits; commands still follow the normal rules. Closest native equivalent. |
| Super Yolo | `bypassPermissions` | No permission prompts at all. |

`plan` (read-only planning) has no upstream counterpart and stays available.

**Risk of `bypassPermissions`:** it removes every permission prompt, including for destructive shell commands and sensitive files, and odd-claude adds no deny hook to catch them (by decision: the user wants that block permissive). Hooks do stay active in this mode (observed in the Q3 spike on Claude Code 2.1.326: a `PreToolUse` hook fired under `--permission-mode bypassPermissions`; see `docs/research/open-questions.md`), but the only hook that can deny is the RDD delivery gate (off by default, and only for `git push` / `gh pr`), so that gives no protection against destructive commands. The setup dry run prints this warning with the diff. Use it only in a sandbox or disposable checkout; `/odd-setup restore` undoes it.

### Setup limitations

- Re-serialization: the settings file is rewritten as JSON. Integers beyond 2^53 lose precision, `-0` becomes `0`, duplicate keys collapse, number forms are normalized and the file may be reformatted (indent is preserved). All of this is visible in the diff before you confirm.
- Very large settings files (more than about 15k lines) make the diff slow and memory hungry.
- `restore` without a name toggles between the last two states, because it backs up the current file first.

## Data directory

State lives under `~/.odd-claude/data` (`ODD_CLAUDE_HOME` moves it; the legacy `CLAUDE_PLUGIN_DATA` is still honored): `sessions/`, `backups/`, `logs/hooks.log` and `setup.json`.

## Development

From `plugins/odd-claude`:

```
npm install
npm run build   # tsc -> dist/
npm test        # build + node:test suite
npm run check   # naming / data-collection guard
```

`dist/` is committed so the plugin runs without a local `tsc`: **rebuild it (`npm run build`) and commit it with every source change.**

`npm test` is the main node:test suite. The installer end to end (install, then uninstall restoring `settings.json` exactly) runs with `npm run test:e2e` at the repo root after `npm --prefix plugins/odd-claude/tui run bundle`; it needs `jq` and the `claude` CLI.

### Releasing (manual)

There is no CI: releases are cut by hand. Run the local checks first (each line says where it runs):

```
(plugins/odd-claude)  npm test                 # build + node:test suite
(plugins/odd-claude)  npm run check            # naming / data-collection guard
(repo root)           npm run test:bench       # bench unit tests
(plugins/odd-claude)  npm --prefix tui test    # TUI tests
(repo root)           sh scripts/tests/installer-e2e.sh   # installer e2e (npm run test:e2e; needs jq and the claude CLI)
```

Then, in order:

1. Bump the version: `node scripts/bump-version.mjs <v>` (in `plugins/odd-claude`). It updates `package.json` (and `plugin.json` / the root `marketplace.json` when they exist) but not `package-lock.json`: edit its two root `version` fields by hand.
2. Build (in `plugins/odd-claude`) and confirm the tracked `dist/` has no diff.
3. Bundle the TUI: `npm --prefix tui ci && npm --prefix tui run bundle` (in `plugins/odd-claude`).
4. Build the payload: `node scripts/release-payload.mjs --version <v> --out <dir> --bundle tui/dist/odd-claude.mjs` (in `plugins/odd-claude`).
5. Commit `chore(release): <v> [skip ci]` (repo root).
6. Create an annotated tag `v<v>`.
7. Push the commit and the tag.
8. `gh release create v<v> --verify-tag --generate-notes` with the three assets: the payload tarball, `odd-claude.mjs` and `checksums.txt`.

## License and attribution

MIT. This is a port of gentle-shell <!-- odd-check: allow --> (MIT); see [NOTICE](NOTICE).
