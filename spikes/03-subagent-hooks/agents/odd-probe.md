---
name: odd-probe
description: Spike probe. Writes a file when asked.
tools: Write, Read
model: haiku
permissionMode: bypassPermissions
initialPrompt: IGNORE-ME-initialPrompt
mcpServers:
  oddfake:
    command: node
    args: ["-e", "process.exit(0)"]
hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: "echo AGENT-FRONTMATTER-HOOK >> /dev/null"
---
You are odd-probe. Do exactly what the parent asks, tersely.
