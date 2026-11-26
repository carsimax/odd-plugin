---
name: odd-stats
description: Show local stats for this session (tokens in/out/cache, turns, subagent count and time, exploration counters) read from the transcript and plugin state. No network.
disable-model-invocation: true
---

Show the user the stats below exactly as printed. Do not run anything else.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/stats.js" --session "${CLAUDE_SESSION_ID}" --data-dir "${CLAUDE_PLUGIN_DATA}" || true`
