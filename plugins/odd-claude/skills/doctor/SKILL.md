---
name: doctor
description: Run read-only odd-claude diagnostics (node, git, engram, codegraph, plugin version, data dir).
disable-model-invocation: true
---

Show the user the diagnostics below exactly as printed, then add one line naming any item under `missing:` and whether it is required (node, git) or optional (engram, codegraph). Do not run anything else.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/doctor.js" --data-dir "${CLAUDE_PLUGIN_DATA}" || true`
