---
name: changes
description: Summarize the working-tree changes of the current project (git status, untracked files, diff --stat).
disable-model-invocation: true
---

Show the user the summary below exactly as printed. Do not run anything else.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/changes.js" || true`
