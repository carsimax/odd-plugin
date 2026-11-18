---
name: banner
description: Show or switch the odd-claude startup banner (a short user-facing line at session start, never part of the model context). ON by default; ODD_CLAUDE_NO_BANNER=1 also disables it.
disable-model-invocation: true
user-invocable: true
argument-hint: "[on|off|status]"
---

You manage the odd-claude startup banner. It is shown to the user only (SessionStart `systemMessage`), on a fresh session start, and stored in the plugin data dir only.

Current state (read-only; the user's argument text is deliberately NOT part of this command):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/banner.js" --data-dir "${CLAUDE_PLUGIN_DATA}" || true`

The user's argument is: $ARGUMENTS

Steps:

1. Show the user the state above exactly as printed.
2. Validate the argument strictly. It must be EXACTLY one of: `on`, `off`, `status`. If it is empty or `status`, stop after step 1. If it is anything else (spaces, quotes, `;`, `$`, backticks, paths, other words), do NOT run any command: say it is not a valid argument, list the valid ones, and ask the user what they want.
3. For `on` or `off`, run with the Bash tool, putting only the validated literal in the command (never anything else the user typed):
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/banner.js" --action <on|off> --data-dir "${CLAUDE_PLUGIN_DATA}"`
4. Show its output and tell the user the change applies from the next session start.
