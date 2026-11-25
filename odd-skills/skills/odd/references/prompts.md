# Prompts and blocking questions

## Subagents cannot ask the user

`AskUserQuestion` is removed from every subagent's tool pool. A subagent needing a human decision stops with `status: interaction_required` (question, reason, closed options, unblock_response). You relay it with `AskUserQuestion`, then return the answer to the same child (`SendMessage`) or launch a bounded follow-up. Never let a child guess a human decision.

## Relaying faithfully

Preserve the whole choice envelope: why input is required, every group and option label and description in order, the selection mode and the allowed-answer domain. Never summarize, reorder, merge or omit choices. If the choices fit `AskUserQuestion` (one question, 2-4 options), use it and pass labels and descriptions exactly; the tool adds free-text "Other". Otherwise (tool unavailable, non-interactive, oversized) print the complete envelope as plain chat and stop: do not choose, default or continue.

Validate answers against the presented domain: accept only inputs matching exactly one option (trimmed, case-insensitive label, or its ordinal `N`); reject zero or multiple matches and re-present. A question about the block is a request for information: answer it from the envelope without choosing for the user, then re-present. Return a valid answer to the blocked actor once.

## Online sources

Delegate web retrieval to `odd-explore` (`WebSearch`, `WebFetch`); missing web tools are a capability gap to report, not to invent around.
