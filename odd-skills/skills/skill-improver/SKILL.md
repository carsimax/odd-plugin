---
name: skill-improver
description: "Trigger: improve skills, audit skills, refactor skills, skill quality. Audit and upgrade existing LLM-first skills."
license: Apache-2.0
metadata:
  author: odd-skills
  version: "1.0"
---

## Activation Contract

Use this skill when auditing, refactoring, normalizing, or improving existing `SKILL.md` files. Use the `skill-creator` skill when creating a brand-new skill from a reusable pattern.

## Hard Rules

- Read the project's `docs/skill-style-guide.md` when present, otherwise the `skill-creator` skill, and treat it as the normative style contract.
- Treat `SKILL.md` as the source of truth; preserve author intent, critical rules, activation semantics, and output requirements.
- Use the skills listed in the current session for names, triggers, scopes, and exact paths; fall back to scanning `~/.claude/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md`.
- Default to audit-only. Modify files only when the user explicitly asks to apply improvements.
- Never delete meaningful content silently; move long explanation, examples, templates, or schemas into local `references/` or `assets/`.
- Do not invent triggers, policies, or domain rules. Mark ambiguous cases for human review.

## Decision Gates

| Situation | Action |
| --- | --- |
| Missing or invalid frontmatter | Fix `name`, quoted one-line `description`, `license`, and `metadata` |
| Skill reads like tutorial docs | Convert to runtime instructions and move background to `references/` |
| Body exceeds budget | Preserve rules, move examples/background to supporting files |
| Branching logic hidden in prose | Convert to a compact decision table |
| Rules conflict or intent is unclear | Report the issue; do not rewrite that rule automatically |

## Execution Steps

1. Read `docs/skill-style-guide.md` when present, otherwise the `skill-creator` skill.
2. Select skills from the session skill list; if it is unavailable, report that limitation and scan `~/.claude/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md`.
3. For each selected skill, audit metadata, trigger clarity, section order, body budget, actionability, decision gates, output contract, and local references.
4. Flag a discipline skill with no pressure-test evidence; the method is the pressure-testing reference of the `skill-creator` skill.
5. Return an audit report grouped by skill with severity and exact proposed changes.
6. In apply mode, edit only safe issues, preserve content, create supporting files when needed. In apply mode also rerun its scenarios before and after a change to a discipline rule and report both results.

## Output Contract

Return:
- Skills audited and paths used.
- Issues found, grouped by severity.
- Files changed, if apply mode was requested.
- Ambiguities that need human review.

## References

- the `skill-creator` skill — normative LLM-first skill style guide.
