---
name: persona
description: Show or switch the odd-claude persona mode (mentor or neutral). Stored in plugin state; applies from the next session start.
disable-model-invocation: true
user-invocable: true
argument-hint: "[mentor|neutral]"
---

You manage the odd-claude persona mode. It is stored in the plugin data dir only; nothing else is written.

Current state (read-only; the user's argument text is deliberately NOT part of this command):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/persona.js" --data-dir "${CLAUDE_PLUGIN_DATA}" || true`

The user's argument is: $ARGUMENTS

Steps:

1. Show the user the state above exactly as printed.
2. Validate the argument strictly. It must be EXACTLY one of: `mentor`, `neutral`. If it is empty, stop after step 1 and tell the user to run `/odd-claude:persona <mode>` (mentor or neutral). If it is anything else (spaces, quotes, `;`, `$`, backticks, paths, other words), do NOT run any command: say it is not a valid argument, list the valid ones, and ask the user what they want.
3. Run with the Bash tool, putting only the validated literal in the command (never anything else the user typed):
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/persona.js" --mode <mode> --data-dir "${CLAUDE_PLUGIN_DATA}"`
4. Show its output and tell the user the new persona applies from the next session start (or `/clear`).
