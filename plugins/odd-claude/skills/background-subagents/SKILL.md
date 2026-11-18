---
name: background-subagents
description: Show or switch the background subagents policy (enable, disable, status). Stored in plugin state; applies from the next session start.
disable-model-invocation: true
user-invocable: true
argument-hint: "[enable|disable|status]"
---

You manage the odd-claude background subagents policy. When it is `on`, the session context tells the orchestrator to launch independent Agent work with `run_in_background: true`; when `off` (the default) Agent calls run in the foreground. It is stored in the plugin data dir only; nothing else is written.

Current state (read-only; the user's argument text is deliberately NOT part of this command):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/background-subagents.js" --data-dir "${CLAUDE_PLUGIN_DATA}" || true`

The user's argument is: $ARGUMENTS

Steps:

1. Show the user the state above exactly as printed.
2. Validate the argument strictly. It must be EXACTLY one of: `enable`, `disable`, `status`. If it is empty or `status`, stop after step 1. If it is anything else (spaces, quotes, `;`, `$`, backticks, paths, other words), do NOT run any command: say it is not a valid argument, list the valid ones, and ask the user what they want.
3. For `enable` or `disable`, run with the Bash tool, putting only the validated literal in the command (never anything else the user typed):
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/background-subagents.js" --action <enable|disable> --data-dir "${CLAUDE_PLUGIN_DATA}"`
4. Show its output and tell the user the new policy applies from the next session start (or `/clear`).
