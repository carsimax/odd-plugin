---
name: status
description: Show read-only odd-claude status (version, data dir, session state, hooks, roadmap phase).
disable-model-invocation: true
---

Show the user the status below exactly as printed. Do not run anything else.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/status.js" --session "${CLAUDE_SESSION_ID}" --data-dir "${CLAUDE_PLUGIN_DATA}"`
