---
name: coordinator
description: Show or switch coordinator mode (full delegation: the main thread delegates every change to an odd-worker). ON by default. A prompt rule stored in plugin state; applies from the next session start.
disable-model-invocation: true
user-invocable: true
argument-hint: "[on|off|status]"
---

You manage the odd-claude coordinator mode (full delegation). When `on` (the default) the session context tells the orchestrator to send every authorized change to a bounded `odd-claude:odd-worker`; when `off` it works inline and delegates only when a trigger fires. It is a prompt rule the orchestrator follows: no hook blocks edits in either mode. It is stored in the plugin data dir only; nothing else is written.

Current state (read-only; the user's argument text is deliberately NOT part of this command):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/coordinator.js" --data-dir "${CLAUDE_PLUGIN_DATA}" || true`

The user's argument is: $ARGUMENTS

Steps:

1. Show the user the state above exactly as printed.
2. Validate the argument strictly. It must be EXACTLY one of: `on`, `off`, `status`. If it is empty or `status`, stop after step 1. If it is anything else (spaces, quotes, `;`, `$`, backticks, paths, other words), do NOT run any command: say it is not a valid argument, list the valid ones, and ask the user what they want.
3. For `on` or `off`, run with the Bash tool, putting only the validated literal in the command (never anything else the user typed):
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/coordinator.js" --action <on|off> --data-dir "${CLAUDE_PLUGIN_DATA}"`
4. Show its output and tell the user the new mode applies from the next session start (or `/clear`).
