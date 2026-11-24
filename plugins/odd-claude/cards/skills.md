# Orchestrator — Skills Detail (lazy-loaded)

Bind this to the parent (main-thread) session only, on skill resolution/discovery. Not always-on; loaded on demand from the always-on core's `## Skill Registry Protocol` and `## Intent-Driven Skill Discovery` pointers.

## Skill Registry Protocol

The effective view is the skill list Claude Code shows the session (plugin skills appear namespaced, `/odd-claude:<name>`, alongside project `.claude/skills` and user skills), plus the on-disk rows of the shared registry `.atl/skill-registry.md` that `/odd-claude:skill-registry` writes (a hook refreshes it at session start). A project copy outranks a user or plugin copy of the same name. Use this view to select skills and delegate:

1. Match task context and target files against the view's trigger / description column.
2. Pass only matching exact `SKILL.md` paths to subagents under `## Skills to load before work`. Match the delegated task's own files and actions, never a fixed set: a child that will not commit gets no commit skill, and one that writes no docs gets no docs skill.
3. Tell subagents to read those exact `SKILL.md` files before reading, writing, reviewing, testing, or creating artifacts.
4. If no skill matches, continue without project skill injection and report `skill_resolution: none`.

`.atl/skill-registry.md` indexes disk only and is never the full effective view. The view is unavailable only when neither the session skill list nor the registry is present: then say so; a disk-only fallback may omit runtime-only skills. Disk changes appear in the view at the next session start, not mid-run.

Subagents receive exact indexed paths and never rediscover the registry or other project/user `SKILL.md` files during normal runtime.

Among the plugin's agents only `odd-claude:odd-worker` reports `skill_resolution`, as `paths-injected`, `paths-invalid` (blocked; the unreadable path is in `risks`), or `none`; the fallback values below come from other agents.

If a subagent reports `skill_resolution`, interpret it as project/user skill resolution:

- `paths-injected`: parent supplied `## Skills to load before work` with exact `SKILL.md` paths.
- `fallback-registry`: subagent self-loaded skill paths from the registry because parent paths were missing; degraded but auditable.
- `fallback-path`: subagent loaded explicit skill paths because parent paths were missing; degraded but auditable.
- `none`: no project/user skills were loaded.

If any subagent reports a fallback instead of `paths-injected`, treat it as an orchestration gap and correct future delegations by passing exact indexed paths directly.

## Intent-Driven Skill Discovery

For skill-shaped requests, do not treat the injected skill list as complete. Use the registry and filesystem only as a discovery aid; do not let a trigger table override the user's concrete request or turn a small request into a larger workflow.

Discovery order:

1. Consult the session skill list and the registry, when present, before acting or delegating.
2. Read the matching exact `SKILL.md` path when acting; pass it to the subagent when delegating.
3. If the view is unavailable, disclose the limitation; `.atl/skill-registry.md` is a disk-only fallback, not a complete view.
4. If an expected workflow is absent, search configured skill roots only as a fallback. Prefer the most specific project skill over a global skill with the same intent.
5. If no matching skill exists, continue with the smallest safe fallback and say which expected skill was unavailable.

Common intent hints, not hard routing:

| User intent                                                | Skill to check                          |
| ---------------------------------------------------------- | --------------------------------------- |
| PR review / GitHub PR URL                                  | a matching project review skill, if any |
| Post-ready review comments                                 | `/odd-claude:comment-writer`            |
| Create/open/prepare PR                                     | `/odd-claude:branch-pr`                 |
| Bug / failing test / unexpected behavior                   | `/odd-claude:systematic-debugging`      |
| Review feedback to act on (PR comments, reviewer findings) | `/odd-claude:receiving-review`          |
| Session went wrong / retrospective / transcript analysis | `/odd-claude:retro`                     |
| Split/stack/large PR                                       | `/odd-claude:chained-pr`                |

Keep this lightweight: loading a skill should improve the immediate task, not force extra ceremony.
