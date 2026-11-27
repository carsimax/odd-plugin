---
name: odd-profiles
description: List, show or switch the odd-claude model profile (balanced, economy, max or custom) that routes agents to a model per spawn. balanced is the default. Stored in plugin state.
disable-model-invocation: true
user-invocable: true
argument-hint: "[list|show|use <balanced|economy|max>|set <role> <model> [effort]|clear]"
---

You manage the odd-claude model profile. It lives in the plugin data dir; the installer writes `model:` and, for non-haiku roles, `effort:` into the installed agent copies in the Claude config dir (`~/.claude`, or `$CLAUDE_CONFIG_DIR` when set), and a per-spawn `model` or `effort` from the parent still overrides them. The plugin-cache agent files are never rewritten. `balanced` is the default profile: it applies whenever no profile was chosen (and `clear` returns to it). It is: `odd-explore` haiku; `odd-worker` sonnet; `odd-verify` opus; `odd-plan-check` sonnet; `odd-jd-fix` sonnet; `odd-jd-judge-a` opus; `odd-jd-judge-b` sonnet; `odd-review-readability`, `odd-review-reliability`, `odd-review-resilience` sonnet; `odd-review-risk` opus; and for the RDD native review `review-refuter` opus and `review-validator` opus, all with effort medium.

Current state (read-only; the user's argument text is deliberately NOT part of this command):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/profiles.js" show --data-dir "${CLAUDE_PLUGIN_DATA}" || true`

Presets:

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/profiles.js" list --data-dir "${CLAUDE_PLUGIN_DATA}" || true`

The user's argument is: $ARGUMENTS

Steps:

1. Show the user the state and presets above exactly as printed.
2. If the argument is empty, `list` or `show`, stop here.
3. Otherwise validate strictly. It must be EXACTLY one of:
   - `use <name>` where `<name>` is one of `balanced`, `economy`, `max`
   - `set <role> <model> [effort]` where `<role>` is one of `odd-explore`, `odd-verify`, `odd-plan-check`, `odd-worker`, `odd-jd-fix`, `odd-jd-judge-a`, `odd-jd-judge-b`, `odd-review-readability`, `odd-review-reliability`, `odd-review-resilience`, `odd-review-risk`; `<model>` is one of `haiku`, `sonnet`, `opus`; the optional `[effort]` is one of `low`, `medium`, `high`, `xhigh`, `max`
   - `clear`
   If anything else (other words, spaces, quotes, `;`, `$`, backticks, paths), do NOT run any command: say it is not valid, list the valid forms, and ask what they want.
4. Run with the Bash tool, putting only the validated literal words in the command (never anything else the user typed):
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/profiles.js" <validated words> --data-dir "${CLAUDE_PLUGIN_DATA}"`
5. Show its output. The orchestrator picks the profile up from the next session start (or `/clear`); it travels in the SessionStart context line.
