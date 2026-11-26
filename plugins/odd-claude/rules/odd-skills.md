# ODD skills: registry protocol and discovery

Bind this to the parent (main-thread) session only, whenever you resolve or discover skills.

## Skill Registry Protocol

The effective view is the skill list Claude Code shows the session (with project `.claude/skills` and user skills) plus the on-disk rows of the shared registry `.atl/skill-registry.md` that `/odd-skill-registry` writes (a hook refreshes it at session start). A project copy outranks a user or plugin copy of the same name. To select skills and delegate:

1. Match task context and target files against the view's trigger / description column.
2. Pass only matching exact `SKILL.md` paths to subagents under `## Skills to load before work`. Match the delegated task's own files and actions, never a fixed set: a child that will not commit gets no commit skill, one that writes no docs gets no docs skill.
3. Tell subagents to read those exact files before reading, writing, reviewing, testing or creating artifacts.
4. If no skill matches, continue without skill injection; the worker reports `skill_resolution: none`.

`.atl/skill-registry.md` indexes disk only and is never the full view. The view is unavailable only when neither the session skill list nor the registry exists: then say so; a disk-only fallback may omit runtime-only skills. Disk changes appear at the next session start, not mid-run. Subagents receive exact indexed paths and never rediscover the registry or other `SKILL.md` files.

Among the plugin's agents only `odd-worker` reports `skill_resolution`: `paths-injected` (parent supplied exact paths), `paths-invalid` (blocked; the unreadable path is in `risks`), or `none`. Other agents may report `fallback-registry` or `fallback-path` (self-loaded because parent paths were missing; degraded but auditable). Any fallback instead of `paths-injected` is an orchestration gap: pass exact indexed paths directly from then on.

## Intent-Driven Skill Discovery

For skill-shaped requests the injected list is not complete. Use the registry and filesystem only as a discovery aid; a trigger table never overrides the user's concrete request or inflates a small request into a larger workflow.

1. Consult the session skill list and the registry, when present, before acting or delegating.
2. Read the matching exact `SKILL.md` when acting; pass it to the subagent when delegating.
3. View unavailable: disclose it; `.atl/skill-registry.md` is a disk-only fallback.
4. Expected workflow absent: search configured skill roots only as a fallback, preferring the most specific project skill over a global one with the same intent.
5. No matching skill: continue with the smallest safe fallback and say which expected skill was unavailable.

Hints, not hard routing:

| User intent | Skill to check |
|---|---|
| PR review / GitHub PR URL | a matching project review skill, if any |
| Post-ready review comments | `/comment-writer` |
| Create/open/prepare PR | `/branch-pr` |
| Bug / failing test / unexpected behavior | `/systematic-debugging` |
| Review feedback to act on (PR comments, reviewer findings) | `/receiving-review` |
| Session went wrong / retrospective / transcript analysis | `/odd-retro` |
| Split/stack/large PR | `/chained-pr` |

Loading a skill should improve the immediate task, not force extra ceremony.
