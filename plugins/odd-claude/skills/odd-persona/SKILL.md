---
name: odd-persona
description: Show the odd-claude persona. There is a single persona, neutral (the default); any other mode, including mentor, is refused.
disable-model-invocation: true
user-invocable: true
argument-hint: "[neutral]"
---

You manage the odd-claude persona. There is exactly one persona, `neutral`, and it is the default; `mentor` no longer exists. It is stored in the plugin data dir only; nothing else is written.

Current state (read-only; the user's argument text is deliberately NOT part of this command):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/persona.js" --data-dir "${CLAUDE_PLUGIN_DATA}" || true`

The user's argument is: $ARGUMENTS

Steps:

1. Show the user the state above exactly as printed.
2. Validate the argument strictly. It must be EXACTLY `neutral`. If it is empty, stop after step 1 and tell the user the only persona is `neutral` (already the default). If it is `mentor`, do NOT run any command: say mentor was removed and only `neutral` exists. If it is anything else (spaces, quotes, `;`, `$`, backticks, paths, other words), do NOT run any command: say it is not a valid argument, list the valid ones, and ask the user what they want.
3. Run with the Bash tool, putting only the validated literal in the command (never anything else the user typed):
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/persona.js" --mode <mode> --data-dir "${CLAUDE_PLUGIN_DATA}"`
4. Show its output and tell the user the persona applies from the next session start (or `/clear`).
