---
name: skill-creation
description: Create or update an LLM-first skill
argument-hint: "<skill idea or name>"
disable-model-invocation: true
---
Create or update an LLM-first skill for: $ARGUMENTS

Use the `/odd-claude:skill-creator` skill if it is available. If the skill is not auto-loaded, read the `skill-creator` skill's `SKILL.md` and `docs/skill-style-guide.md` when present before editing. If neither is available, say so and stop. Clarify the reusable behavior, target runtime, trigger phrases, and non-goals if they are not obvious, then follow the skill's Execution Steps.

## Report

Return the files changed, the selected trigger phrases, any supporting files, and whether registry/package verification remains to run.
