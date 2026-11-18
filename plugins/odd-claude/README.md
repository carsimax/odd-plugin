# odd-claude

A Claude Code plugin that ports the ODD harness of gentle-shell (MIT) <!-- odd-check: allow --> to Claude Code. **v1.0** is the parity release: the ODD persona, orchestrator cards, agents, skills, native integrations, advisory review, themes and lifecycle hooks. The plugin ships **no deny/ask/block hook** (user decision, v0.5): its hooks only add context. Coordinator mode and the admission rules are prompt text, not enforcement; the only enforcement is Claude Code's native permission system (see [Permission modes](#permission-modes)). The plugin collects no data and sends nothing anywhere.

## What's in v1.0

- **Commands / skills** (`/odd-claude:<name>`): `odd`, `doctor`, `status`, `setup`, `persona`, `coordinator`, `background-subagents`, `scratch`, `agents`, `changes`, `banner`, `skill-registry`, `skill-creation`, `skill-creator`, `skill-improver`, `4r-review`, `judgment-day`, `branch-pr`, `chained-pr`, `work-unit-commits`, `issue-creation`, `comment-writer`, `cognitive-doc-design`, `tui-design`, `ui-design`.
- **Agents** (`odd-claude:<agent>`): `odd-explore`, `odd-verify`, `odd-worker`, `odd-jd-fix`, `odd-jd-judge-a`, `odd-jd-judge-b`, `odd-review-risk`, `odd-review-resilience`, `odd-review-readability`, `odd-review-reliability`.
- **Hooks** (all advisory, none denies): `SessionStart` (context, scratch dir, title, status file, skill registry, optional codegraph warm-up), `UserPromptSubmit` (context, quota advisory), `PostToolUse` (exploration budget, context backstop), `StopFailure` (quota advisory), `Stop` (status file only; empty output), `SubagentStart`/`SubagentStop` (record the subagent in session state; silent), `SessionEnd` (scratch cleanup, resume hint, status file).
- **Themes**: `odd`, `odd cute`, `odd bold`. **Output style**: `odd`. **Cards**, **support docs** and **sounds assets** (see below).
- **Not implemented, by user decision (2026-11-18):** R57 (notification sounds; the `assets/sounds/` files are only shipped assets) and R63 (GitHub star prompt). Native RDD and inter-session peers are v2.
- **No deny:** the plugin ships no hook that denies, asks or blocks (see the statement above and [Permission modes](#permission-modes)).

## Themes

Three custom themes ship in `themes/`: `odd`, `odd cute` and `odd bold`. Pick one with `/theme`. Each declares a base preset and overrides colors; the diff word colors fall back to the `dark` base.

## Lifecycle hooks (v1.0)

All of these are advisory: none returns a block decision, `continue:false` or a deny, and the `Stop` hook output is always empty so it never forces continuation.

- **Quota advisory (R35).** `StopFailure` is fire-and-forget in Claude Code, so the hook only logs and arms one advisory shown on the next prompt (30 min cooldown for exhausted quota, 2 min for transient errors). It includes `--fallback-model` guidance (Anthropic models only; see `cards/quota-recovery.md`).
- **Session scratch (R56).** A per-session directory `<data>/scratch/<session>` (mode 0700) is created at SessionStart and its path is added to the context; `/odd-claude:scratch` shows it. It is removed at SessionEnd only when it is a real directory whose realpath is exactly `<realroot>/<session>`; symlinks are never followed. Removal first renames the dir to a tombstone `<realroot>/.rm-<pid>-<timestamp>-<session>` and then deletes it; if the process crashes in between, the tombstone stays behind and can accumulate. SessionStart sweeps them: it deletes `.rm-*` entries directly inside the real scratch root that are real directories (never symlinks) and older than 1 hour, at most 200 entries per run.
- **Terminal title (R62).** SessionStart sets the title to `odd-claude · <project>` through `terminalSequence` (plain OSC 0).
- **Resume hint (R64).** SessionEnd prints a resume hint and logs it to `hooks.log`.
- **Agent status file (R70).** `<data>/status/<session>.json` (`schema odd-claude.agent-status/v1`: session, cwd, state `idle`/`working`/`ended`, `updatedAt`; mode 0600, atomic writes). SessionEnd writes `ended` instead of deleting; readers treat it as stale after 30 s.

## What v0.2 shipped

- **Persona / output style `odd`** (`output-styles/odd.md`, `force-for-plugin: true`, so no `/setup` is needed). SessionStart and UserPromptSubmit hooks add `additionalContext` with the rest of the prompt and the path of the cards. Replies follow the user's language.
- **Persona modes**: `/odd-claude:persona [mentor|neutral]` stores the mode in the plugin data dir; it applies from the next session start (or `/clear`).
- **Cards** (`cards/*.md`): orchestrator rules loaded on demand (delegation, tracking, verification, memory, skills, prompts, writer, quota recovery), with tool names mapped to Claude Code (`Agent`, `TodoWrite`, `AskUserQuestion`, `Bash` with `run_in_background`, `Monitor`, worktree tools). See `cards/SOURCES.md`.
- **Agents** (listed as `odd-claude:<agent>`): `odd-explore` (read-only), `odd-verify` (runs checks), `odd-worker` (scoped writer), `odd-jd-fix`, `odd-jd-judge-a`, `odd-jd-judge-b` (Judgment Day), and the four advisory review lenses `odd-review-risk`, `odd-review-resilience`, `odd-review-readability`, `odd-review-reliability`.
- **Skills** (`odd-claude:<skill>`): `odd`, `branch-pr`, `chained-pr`, `cognitive-doc-design`, `comment-writer`, `issue-creation`, `judgment-day`, `skill-creator`, `skill-creation`, `skill-improver`, `skill-registry`, `tui-design`, `ui-design`, `work-unit-commits`, `4r-review`, plus the commands `doctor`, `status`, `setup`, `persona`, `background-subagents`, `coordinator`.
- **Support docs** (`support/`): test-first policy and the `odd/tasks/<feature>.md` format. **Sounds**: `assets/sounds/` (original tones, see its LICENSE).

### Background subagents

`/odd-claude:background-subagents [enable|disable|status]` sets a policy (default off; env `ODD_CLAUDE_BACKGROUND_SUBAGENTS=on|off` is the fallback). When on, the session context tells the orchestrator to launch independent `Agent` work with `run_in_background: true`. Note that Claude Code itself runs subagents in the background by default.

### Coordinator mode (full delegation)

`/odd-claude:coordinator [on|off|status]` switches the delegation mode; **ON by default**. When on, the session context says `Coordinator mode: ON` and points to `cards/full-delegation.md`: the main thread does not implement and sends every authorized change to a bounded `odd-worker` (a general-purpose `Agent` is the reported fallback). When off, the orchestrator works inline and delegates only when a trigger fires. The mode is stored in the plugin data dir (`delegation.json`) and applies from the next session start (or `/clear`).

This is a **rule the orchestrator follows, not enforcement**: no hook blocks `Edit`/`Write` in either mode. The same holds for the writer `## Allowed edit surfaces` section, the verifier `Risk:` line and the Judgment Day fix dispatch shape: `cards/writer.md`, `cards/delegation.md`, `cards/verification.md` and the `judgment-day` skill state them as rules.

### Exploration budget and context backstop (advisory)

A `PostToolUse` hook (matcher `Read|Grep|Glob|WebFetch|WebSearch` plus the codegraph MCP tools, both `mcp__codegraph__*` and `mcp__plugin_odd-claude_codegraph__*`) adds `additionalContext` notices. It **never blocks, asks or denies**: errors are logged and ignored, the timeout is 5 s.

- **Exploration budget (R14).** Counts exploration calls and result text bytes per turn, main thread only (calls from subagents carry `agent_id`/`agent_type` and are skipped). The counters live in session state and `UserPromptSubmit` resets them each turn. With coordinator mode ON, the first time a turn passes the upstream thresholds (more than 3 lookups or 40,000 text bytes) it suggests delegating discovery to one `odd-claude:odd-explore`; one notice per turn. Coordinator OFF: no notice.
- **Context backstop (R34).** Claude Code gives hooks no context-usage number, so the hook reads `transcript_path`: the prompt tokens (`input + cache_creation + cache_read`) of the last assistant `usage` line, or, if none is in the last 512 KB, `file bytes / 4` as a rough estimate. Past 150,000 tokens (override: `ODD_CLAUDE_CONTEXT_BACKSTOP_TOKENS`) it emits one notice per session suggesting delegating the next bounded unit. A measured reading below the threshold (after compaction) re-arms it. The window size is unknown, so upstream's fraction-of-window rule is not applied. It only runs on the events matched above.

### Skill registry

On SessionStart the hook reads the existing `.atl/skill-registry.md` (one context line) and starts a detached, locked refresh in the background, so the registry is written or updated without delaying session start (the first start in a project has no line yet; the next start does). The registry is an index of project, user and plugin skills by trigger and path, plus `.atl/.gitignore`. Run it on demand with `/odd-claude:skill-registry`. Another tool may also write `.atl/skill-registry.md`; to stop odd-claude from touching it set `ODD_CLAUDE_NO_SKILL_REGISTRY=1`. Git-tracked registries are preserved on automatic refresh.

### codegraph MCP

The plugin declares a `codegraph` MCP server (`.mcp.json`, needs the `codegraph` binary). Tool names depend on who provides the server:

- plugin server: `mcp__plugin_odd-claude_codegraph__codegraph_explore`
- user-level `codegraph` server: Claude Code suppresses the plugin one ("duplicates manually-configured") and the tool is `mcp__codegraph__codegraph_explore`.

Agent allowlists list both names; a name that is not connected is ignored. The SessionStart warm-up (detached `codegraph sync`) is **off by default**: a `.codegraph/` directory comes from the repository and is not a trust signal. Opt in per project: `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/codegraph-trust.js" --action trust --cwd <project>` (records the path in plugin state; `--action untrust` / `--action list`). There is no environment-variable opt-in: a repository can set env through its own `.claude/settings.json`, so only the trust list the user writes counts.

When trusted and an index exists, SessionStart syncs it. Repeated starts do not overlap: an in-flight lock per project (`<data dir>/locks`, replaced when its process is gone or after 6 minutes) skips the spawn. Other flags: `ODD_CLAUDE_CODEGRAPH_INIT=1` also runs `codegraph init` in a trusted project with no index (opt-in); `ODD_CLAUDE_NO_CODEGRAPH_WARMUP=1` disables the warm-up. It never runs in a home or broad directory.

### Engram tool names

Memory tools are `mem_*`: `mcp__engram__mem_*` when the engram MCP is configured at user level, or `mcp__plugin_engram_engram__mem_*` if an engram plugin ships its own server (`engram@engram` 0.1.22 does not). `odd-worker` lists both `mem_save` names.

### Advisory review (v0.8)

`/odd-claude:4r-review [git range]` (empty = working tree against `HEAD`) runs four independent lens reviewers in parallel via `Agent`: `odd-review-risk` (R1), `odd-review-resilience` (R4), `odd-review-readability` (R2) and `odd-review-reliability` (R3). The skill gathers the diff (it validates a git range argument itself), passes it in each prompt, and merges the findings into one deduplicated, severity-sorted report. It defaults to all four lenses and may skip irrelevant ones, saying so.

- **Advisory only:** the report gates nothing and approves nothing; there is no approval state and no publication gating. It needs no external review binary and no review tools.
- **Read-only reviewers:** the lens agents allow only `Read`, `Grep`, `Glob` (plus codegraph) and list `Edit`, `Write`, `NotebookEdit` and `Bash` under `disallowedTools`; `src/lib/agents-guard.spec.ts` enforces this for them and for the Judgment Day judges.
- **Judgment Day** (`/odd-claude:judgment-day`) stays independent: two blind judges and at most two fix rounds; it neither requires nor replaces `4r-review`.

### Subagents cannot ask questions

Claude Code removes `AskUserQuestion` from every subagent (verified on 2.1.327). A child that needs a human decision returns `status: interaction_required` and the orchestrator relays it; see `cards/prompts.md`.

## Requirements

- Claude Code >= 2.1.323 (the `engines.claude-code` value in `.claude-plugin/plugin.json`)
- Node >= 20
- git
- Optional: the `engram` plugin (declared as a dependency, `engram@engram`) or the `engram` binary; `codegraph`

`/odd-claude:doctor` reports which of these are present.

## Install

```
/plugin marketplace add <repo>
/plugin install odd-claude@odd-claude
```

For development, load the plugin from a checkout without installing:

```
claude --plugin-dir plugins/odd-claude
```

## Commands

- `/odd-claude:doctor`: checks node, git, engram, codegraph, plugin version and data dir; lists what is missing.
- `/odd-claude:agents`: table of this session's subagents (agent_type, started UTC, status, duration), from the `SubagentStart`/`SubagentStop` events recorded in session state (`subagents`, newest 50). Works everywhere. With mods enabled, `/odd-agents` additionally opens a live pane with the same table (`hooks/register.ts`, `modules` in `hooks/hooks.json`); the mod is optional, never touches prompts or tool calls, and does nothing when mods are off.
- `/odd-claude:changes`: summary of the project's working-tree changes (R46): branch, `git status` entries (modified, staged, deleted, renamed, untracked; capped at 50) and `git diff --stat`. Read-only git with a 5 s timeout, no user text on any command line, never throws (outside a repository it says so). It reads Git, not a per-session record: no PostToolUse recording is added, so the hooks stay as fast as before. With mods enabled, `/odd-changes` opens a pane with the same text, refreshed every 5 s (`hooks/register.ts`, `$.process.run`); it degrades silently when panes or git are unavailable.
- `/odd-claude:banner [on|off|status]`: startup banner (R45), two plain text lines shown to the user as the `SessionStart` `systemMessage` on a fresh startup (not on resume/clear/compact), so it never enters the model context. ON by default; `ODD_CLAUDE_NO_BANNER=1` or `/odd-claude:banner off` (plugin state `banner.json`) disables it. Visibility of `systemMessage` was not observable in `claude -p` (the hook runs and succeeds there); there is no mod variant, the same message is shown with mods on.
- `/odd-claude:status`: shows the current session state, registered hooks and the roadmap position.
- `/odd-claude:coordinator [on|off|status]`: shows or switches coordinator mode (see above).
- `/odd-claude:setup [default|acceptEdits|auto|plan|bypassPermissions|statusline on|statusline off|restore [backup]]`: opt-in writer for `permissions.defaultMode` and `statusLine` in `~/.claude/settings.json` (the only keys it handles). Always a diff, explicit confirmation, a 0600 backup, an atomic write and `restore`.
  - Always shows a diff first and writes nothing until you explicitly confirm.
  - Before writing, the original file is copied to a backup under the plugin data dir (`backups/`), and only the listed key changes.
  - `restore` shows the diff back to the latest backup (or the named one) and applies it after confirmation. The current file is backed up first, so a restore is itself reversible.
  - Any other argument is refused.

### Permission modes

odd-claude has no permission system of its own: the upstream modes map onto Claude Code's native `permissions.defaultMode`, which `/odd-claude:setup` writes after a diff and a confirmation.

| Upstream mode | Native `defaultMode` | Notes |
|---|---|---|
| Normal | `default` | Claude Code asks before edits and commands. |
| Auto | `auto` | A separate classifier reviews actions instead of prompting. |
| YOLO | `acceptEdits` | Standing approval for file edits; commands still follow the normal rules. Closest native equivalent. |
| Super Yolo | `bypassPermissions` | No permission prompts at all. |

`plan` (read-only planning) has no upstream counterpart and stays available.

**Risk of `bypassPermissions`:** it removes every permission prompt, including for destructive shell commands and sensitive files, and odd-claude adds no deny hook to catch them (by decision: the user wants that block permissive). Hooks do stay active in this mode (observed in the Q3 spike on Claude Code 2.1.326: a `PreToolUse` hook fired under `--permission-mode bypassPermissions`; see `docs/research/open-questions.md`), but none of the plugin's hooks denies anything, so that gives no protection. The setup dry run prints this warning with the diff. Use it only in a sandbox or disposable checkout; `/odd-claude:setup restore` undoes it.

### Setup limitations

- Re-serialization: the settings file is rewritten as JSON. Integers beyond 2^53 lose precision, `-0` becomes `0`, duplicate keys collapse, number forms are normalized and the file may be reformatted (indent is preserved). All of this is visible in the diff before you confirm.
- Very large settings files (more than about 15k lines) make the diff slow and memory hungry.
- `restore` without a name toggles between the last two states, because it backs up the current file first.

## Data directory

**Status bar (R44, R42).** `/odd-claude:setup statusline on` sets `statusLine` to `node "<data dir>/statusline.mjs"`, a small shim that imports `<plugin root>/dist/cli/statusline.js`. The plugin root changes on each plugin update, so settings point at the stable shim and the SessionStart hook rewrites it when the root moves; no re-run of setup is needed after updates (if the shim is ever stale, re-run `setup statusline on`). One line: model · context % · `coord ON/OFF` · persona · `5h`/`7d` rate limits · git branch · tok/s, honouring `NO_COLOR` and `COLUMNS` (lowest-priority segments, on the right, drop first), never throwing (garbage input prints `odd-claude`), no network and no spawned processes (the branch is read from `.git/HEAD`). Tokens/s is the delta of output tokens over API time between two invocations (state in `${CLAUDE_PLUGIN_DATA}/statusline/`), or the session average on the first one; the segment is omitted when the payload has no token/time data. Verified on Claude Code 2.1.326: `claude -p` never invokes the statusLine, so the payload fields used (`model`, `context_window`, `rate_limits`, `cost.total_api_duration_ms`, `workspace`) come from the public statusLine documentation and fixtures, not a captured payload; absent fields are simply omitted. A statusLine you already have is shown in the diff and replaced only after you confirm (`--replace-statusline`); `statusline off` removes only odd-claude's own value or puts your previous one back. The optional mod variant (`$.ui.status`) is not shipped. No ODD phase segment: no phase is stored anywhere yet.

State lives under `${CLAUDE_PLUGIN_DATA}` (for an installed plugin `~/.claude/plugins/data/odd-claude-<marketplace>`; with `--plugin-dir` it is `odd-claude-inline`): `sessions/`, `backups/`, `logs/hooks.log` and `setup.json`.

## Development

From `plugins/odd-claude`:

```
npm install
npm run build   # tsc -> dist/
npm test        # build + node:test suite
npm run check   # naming / data-collection guard
```

`dist/` is committed so the plugin runs without a local `tsc`: **rebuild it (`npm run build`) and commit it with every source change.**

`claude plugin test plugins/odd-claude` applies once the mods layer (Phase 5) provides a hooks module; until then it reports `no hooks module to load`, and `npm test` is the test suite. Validate the manifests with `claude plugin validate plugins/odd-claude` and `claude plugin validate .`.

## License and attribution

MIT. This is a port of gentle-shell <!-- odd-check: allow --> (MIT); see [NOTICE](NOTICE).
