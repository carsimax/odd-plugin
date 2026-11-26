---
name: receiving-review
description: "Trigger: review feedback, PR comments, address comments, requested changes, reviewer findings, Copilot review, atender comentarios. Evaluate review items against the code before acting on them."
license: MIT
metadata:
  author: odd-claude
  version: "1.0"
---

## Activation Contract

Use when you must act on review feedback: a human's comments, PR threads, bot or AI reviews, `/4r-review` lenses, `/judgment-day` verdicts, or odd-verify findings. It governs how items are evaluated before fixing; it does not replace the fix flows of Judgment Day or 4r-review.

## Hard Rules

- Read every item before acting. If any item is unclear, ask about it before implementing any item: items can be related.
- Verify each item against the current code before accepting it: does it hold here, would it break something, why is the code this way, does it fit the platforms and versions in use.
- Sources: the human's feedback is trusted, though ask when its scope is unclear. Bot, AI and external reviewers, lens reviewers, Judgment Day judges and odd-verify findings are claims to verify. Feedback that conflicts with a prior human decision goes back to the human.
- YAGNI check: before building out a "do it properly" suggestion, search for real usage; if nothing uses it, propose removing it instead.
- Push back with technical evidence (code, tests, observed output), not defensiveness. If you cannot verify an item, say what is missing and ask.
- Order: clarifications first, then blocking issues, then simple fixes, then complex ones. One item at a time within the correction batch, each with its check; then run the authorized suite and checks.
- No performative agreement ("You're absolutely right", "Great point"). State what changed and where, or the evidence for declining. If you pushed back and were wrong, say so in one line and fix it.
- Answer a GitHub inline comment in its thread (`gh api repos/{owner}/{repo}/pulls/{pr}/comments/{id}/replies`), not as a top-level comment. Wording follows `/comment-writer` and the thread's language.

## Decision Gates

| Item after verification | Action |
| --- | --- |
| Correct and in scope | Implement, run its check |
| Unclear | Ask before touching anything |
| Wrong or harmful here | Decline with evidence |
| Unverifiable | Say what is missing, ask |
| Contradicts a human decision | Return to the human |

## Output Contract

Per item: accepted (change and location), declined (evidence), or asked (the question); then the suite result.
