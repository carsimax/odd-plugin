---
name: odd-skill-registry
description: "Trigger: update skills, skill registry, actualizar skills, after skill changes. Index available skills by trigger and path."
disable-model-invocation: true
license: MIT
metadata:
  author: odd-claude
  version: "1.0"
---

## Activation Contract

Use this skill after installing, removing, creating, moving, or renaming skills, or when a delegator needs a fresh skill index.

## Hard Rules

- The registry is an index, not a compiler or summary. `SKILL.md` remains the source of truth.
- Do not generate or inject compact rules by default; preserve author intent by passing exact skill paths to subagents.
- Refresh `.atl/skill-registry.md` as a shared disk-only index; do not save session-only runtime rows to the file or Engram.
- Skip `sdd-*`, `_shared`, and `skill-registry`; deduplicate by skill name, preferring project-level skills over user-level skills.
- In Claude Code, the effective view is the skill list the session already shows plus the on-disk rows of `.atl/skill-registry.md`.
- Preserve Git-tracked targets during automatic refresh. Deliberate `/odd-skill-registry` overrides that guard; unchanged rendered bytes remain untouched even on force.

## Decision Gates

| Situation | Action |
| --- | --- |
| Same skill exists globally and in project | Keep the project-level skill |
| Session-resolved skill and loose scan share a path | In the effective view use the session record, or suppress the path when disabled; the shared disk index remains independent |
| Same skill exists in multiple global locations | Keep the first source in scan order |
| No skills found | Write an empty registry so agents stop searching blindly |
| Agent will delegate work | Select matching effective-view rows and pass their exact `SKILL.md` paths |

## Execution Steps

1. Use `/odd-skill-registry` for a deliberate disk-index refresh. It scans known project, user and plugin skill roots, reads frontmatter, and publishes deterministic rows and a non-authoritative cache. The SessionStart hook already refreshes the same file automatically (cheap, mtime/size fingerprint); set `ODD_CLAUDE_NO_SKILL_REGISTRY=1` to opt out. Automatic refresh (hook and the injection below) never overwrites Git-tracked targets; `--force` does.
2. For selection, consult the effective view: the session skill list plus the registry rows.
3. Pass selected exact paths to subagents and require them to read each `SKILL.md` before work.
4. Return the registry path, disk skill count, and whether bytes changed.

## Deliberate refresh

Result of the refresh just run for this project (read-only injection; no user text is part of the command):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/skill-registry.js" || true`

Show that line to the user and report it per the Output Contract. If it says `skipped` for `tracked-target` and the user deliberately asked for the refresh, run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/skill-registry.js" --force` with the Bash tool (it overrides the Git-tracked guard); otherwise relay the reason.

## Output Contract

Return:
- Project name and `.atl/skill-registry.md` path.
- Number of indexed skills.
- Whether the registry changed or was already byte-identical.
- Any skipped or duplicate skills when relevant.

## References

- `/skill-creator` — how skills are authored before indexing; delegators pass exact `SKILL.md` paths to subagents.
