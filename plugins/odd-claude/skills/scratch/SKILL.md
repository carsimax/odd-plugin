---
name: scratch
description: Show this session's scratch directory (created at session start, removed at session end) and what is in it.
disable-model-invocation: true
---

Show the user the scratch status below exactly as printed. Do not run anything else.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/scratch.js" --session "${CLAUDE_SESSION_ID}" --data-dir "${CLAUDE_PLUGIN_DATA}"`
