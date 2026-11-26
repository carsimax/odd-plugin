---
name: odd-setup
description: Opt-in writer for the user's ~/.claude/settings.json (permissions.defaultMode, or the optional deny profile). Always shows a diff, asks for confirmation, backs up first, and can restore.
disable-model-invocation: true
user-invocable: true
argument-hint: "[default|acceptEdits|auto|plan|bypassPermissions|deny-profile install|deny-profile remove|restore]"
allowed-tools: AskUserQuestion
---

You manage the user's real `~/.claude/settings.json`, and only two things in it: `permissions.defaultMode`, and, when the user explicitly asks for it with `deny-profile install` or `deny-profile remove`, the odd-claude deny profile (rules in `permissions` only). Nothing else is ever written. The plugin and its installer never add the deny profile on their own; it exists only when the user runs this opt-in. Follow this flow exactly.

Current state (read-only; the user's argument text is deliberately NOT part of this command):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/setup.js" --data-dir "${CLAUDE_PLUGIN_DATA}" || true`

The user's argument is: $ARGUMENTS

Steps:

1. Show the user the state above exactly as printed.
2. Validate the argument strictly. It must be EXACTLY one of: `default`, `acceptEdits`, `auto`, `plan`, `bypassPermissions`, `deny-profile install`, `deny-profile remove`, `restore`, or `restore <name>` where `<name>` is one of the backup names listed above (they look like `settings.20261118T170805783Z.json`, i.e. match `^settings\.[A-Za-z0-9-]+\.json$`). If the argument is empty, stop after step 1 and tell the user to run `/odd-setup <mode>` (default, acceptEdits, auto, plan or bypassPermissions), `/odd-setup deny-profile install|remove` or `/odd-setup restore`. If it is anything else (spaces, quotes, `;`, `$`, backticks, paths, other words), do NOT run any command: say it is not a valid argument, list the valid ones, and ask the user what they want.
3. Dry run with the Bash tool, putting only the validated literal in the command (never anything else the user typed):
   - mode: `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/setup.js" --mode <mode> --data-dir "${CLAUDE_PLUGIN_DATA}"`
   - deny profile: `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/setup.js" --deny-profile <install|remove> --data-dir "${CLAUDE_PLUGIN_DATA}"`. Before asking for confirmation, state what the profile is: it denies Read and Edit of `.env*` files anywhere, `~/.ssh/**`, `~/.aws/credentials`, `**/*.pem` and `**/*.key`, plus `Bash(git push *)` and `Bash(gh pr merge *)`, for the main conversation and for subagents. Limits to repeat (per https://code.claude.com/docs/en/permissions): `Bash(git push *)` does not catch variants such as `git -C . push`; Read deny rules are best-effort for Grep/Glob and Bash file commands (`grep -r` and scripts are not covered); Bash deny rules are not a security boundary. It is a guard rail, not a sandbox. The profile also lists the exact forms `Bash(git push)` and `Bash(gh pr merge)`; install merges only the rules that are missing and records which ones it added; remove deletes only those, so a rule the user already had stays; `/odd-setup restore` also undoes either.
   - restore: `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/setup.js" --restore --data-dir "${CLAUDE_PLUGIN_DATA}"` (append the validated backup name after `--restore` when one was given)
   Show its output in full, including any `WARNING:` line (bypassPermissions skips every permission prompt; repeat the warning in your own words before asking for confirmation). If it printed an `error:` line, `no changes` or `nothing to do`, stop and write nothing.
4. Otherwise a diff was shown. Ask the user for explicit confirmation with the AskUserQuestion tool (options: "Yes, apply" and "No, cancel"). Say that a backup of the current file is made first, that `/odd-setup restore` undoes it (restoring first backs up the current file, so a bare `restore` toggles between the last two states; name a backup to pick another), and that the file is rewritten from parsed JSON, so it may be reformatted (the diff shows it), large integers lose precision, duplicate keys collapse, and very large files are slow.
5. Only after an explicit "Yes, apply" answer, run the same command as in step 3 with ` --apply` added, via the Bash tool, and show its output.
6. If the user declines, does not answer, or AskUserQuestion is unavailable, do NOT run the `--apply` command. Reply that nothing was written. Never edit settings.json by any other means.
