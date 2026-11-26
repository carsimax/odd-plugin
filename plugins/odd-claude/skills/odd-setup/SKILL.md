---
name: odd-setup
description: Opt-in writer for the user's ~/.claude/settings.json (only permissions.defaultMode). Always shows a diff, asks for confirmation, backs up first, and can restore.
disable-model-invocation: true
user-invocable: true
argument-hint: "[default|acceptEdits|auto|plan|bypassPermissions|restore]"
allowed-tools: AskUserQuestion
---

You manage ONE key of the user's real `~/.claude/settings.json`: `permissions.defaultMode`. Nothing else is ever written. Follow this flow exactly.

Current state (read-only; the user's argument text is deliberately NOT part of this command):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/setup.js" --data-dir "${CLAUDE_PLUGIN_DATA}" || true`

The user's argument is: $ARGUMENTS

Steps:

1. Show the user the state above exactly as printed.
2. Validate the argument strictly. It must be EXACTLY one of: `default`, `acceptEdits`, `auto`, `plan`, `bypassPermissions`, `restore`, or `restore <name>` where `<name>` is one of the backup names listed above (they look like `settings.20261118T170805783Z.json`, i.e. match `^settings\.[A-Za-z0-9-]+\.json$`). If the argument is empty, stop after step 1 and tell the user to run `/odd-setup <mode>` (default, acceptEdits, auto, plan or bypassPermissions) or `/odd-setup restore`. If it is anything else (spaces, quotes, `;`, `$`, backticks, paths, other words), do NOT run any command: say it is not a valid argument, list the valid ones, and ask the user what they want.
3. Dry run with the Bash tool, putting only the validated literal in the command (never anything else the user typed):
   - mode: `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/setup.js" --mode <mode> --data-dir "${CLAUDE_PLUGIN_DATA}"`
   - restore: `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/setup.js" --restore --data-dir "${CLAUDE_PLUGIN_DATA}"` (append the validated backup name after `--restore` when one was given)
   Show its output in full, including any `WARNING:` line (bypassPermissions skips every permission prompt; repeat the warning in your own words before asking for confirmation). If it printed an `error:` line, `no changes` or `nothing to do`, stop and write nothing.
4. Otherwise a diff was shown. Ask the user for explicit confirmation with the AskUserQuestion tool (options: "Yes, apply" and "No, cancel"). Say that a backup of the current file is made first, that `/odd-setup restore` undoes it (restoring first backs up the current file, so a bare `restore` toggles between the last two states; name a backup to pick another), and that the file is rewritten from parsed JSON, so it may be reformatted (the diff shows it), large integers lose precision, duplicate keys collapse, and very large files are slow.
5. Only after an explicit "Yes, apply" answer, run the same command as in step 3 with ` --apply` added, via the Bash tool, and show its output.
6. If the user declines, does not answer, or AskUserQuestion is unavailable, do NOT run the `--apply` command. Reply that nothing was written. Never edit settings.json by any other means.
