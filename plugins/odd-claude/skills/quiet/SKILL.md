---
name: quiet
description: Show or switch quiet tool rendering (optional mod feature: long Bash/Read/Grep/Glob results drawn as one summary line; display only, the model still sees everything). OFF by default.
disable-model-invocation: true
user-invocable: true
argument-hint: "[on|off|status]"
---

You manage odd-claude quiet tool rendering. It only changes how long results of built-in tools are DRAWN in the transcript (never what the model sees; errors are never collapsed; ctrl+o shows everything). It is drawn by the optional `ui.render` mod; when mods are off (or in -p / safe mode) the flag is stored and has no visible effect. The command output cannot tell whether mods are active, so do not claim either way. State lives in the plugin data dir only.

Current state (read-only; the user's argument text is deliberately NOT part of this command):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/quiet.js" --data-dir "${CLAUDE_PLUGIN_DATA}" || true`

The user's argument is: $ARGUMENTS

Steps:

1. Show the user the state above exactly as printed.
2. Validate the argument strictly. It must be EXACTLY one of: `on`, `off`, `status`. If it is empty or `status`, stop after step 1. If it is anything else (spaces, quotes, `;`, `$`, backticks, paths, other words), do NOT run any command: say it is not a valid argument, list the valid ones, and ask the user what they want.
3. For `on` or `off`, run with the Bash tool, putting only the validated literal in the command (never anything else the user typed):
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/quiet.js" --action <on|off> --data-dir "${CLAUDE_PLUGIN_DATA}"`
4. Show its output. The change applies to rows drawn from then on (a mod reads the flag on each render).
