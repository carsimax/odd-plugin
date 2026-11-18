---
name: agents
description: List this session's subagents (agent type, start time, status, duration) from the SubagentStart/SubagentStop events the plugin records.
disable-model-invocation: true
---

Show the user the table below exactly as printed. Do not run anything else.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/agents.js" --session "${CLAUDE_SESSION_ID}" --data-dir "${CLAUDE_PLUGIN_DATA}" || true`
