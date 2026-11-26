---
name: odd-peers
description: Show which other sessions this session accepts peer messages from (consent for inter-session messaging).
disable-model-invocation: true
---

Show the user the peer-consent status below exactly as printed, then this usage. Do not run anything else and do not try to grant or revoke anything.

Usage (the human types these as their own prompt, exactly, one per message):

- `/odd-peers allow <session-id>`: this session accepts messages from `<session-id>`.
- `/odd-peers revoke <session-id>`: stop accepting from that session.
- `/odd-peers revoke --all`: stop accepting from everyone.
- `/odd-peers`: show the current grants.

Closed by default. Grants are recorded by a hook from the human's own prompt (the model and this skill cannot grant) and cleared when this session ends.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/peers.js" list --session "${CLAUDE_SESSION_ID}" --data-dir "${CLAUDE_PLUGIN_DATA}"`
