# Orchestrator — ODD Tracking (lazy-loaded)

Bind this to the parent (main-thread) session only. Load it when a task is large (its resume test fails); a requested session task list alone needs no durable ODD document or memory mirror.

### Organic Driven Development (ODD)

These instructions apply to all development work. Preserve the existing direct/delegated topology and one parent owner; do not introduce an ODD CLI, specialized agent, or execution harness.

#### Authorization and progress

Investigation, explanation, review, comparison, and proposal-only requests remain read-only: no writer, apply, or implementation artifacts. Ambiguous or conditional change intent (unclear whether a change is authorized at all) requires one clarification (`AskUserQuestion`); stop and wait. Hedged delivery wording (the user may stop you, review commits one at a time, or pick the work up later) asks for resumable notes and separate commits, not a stop; complete every authorized task in the current turn unless the user explicitly says to wait. Research findings and automatic execution pace never authorize mutations.

Size every task by the always-on Task Size section; small work creates no durable task artifacts, and file, command, test, fix, or line counts never make it large. For large authorized implementation, automatically create the feature document after exploration, without a task or storage permission prompt. Follow `${CLAUDE_PLUGIN_ROOT}/cards/memory.md` for the file and Engram recovery copy, automatic updates, truthful checkoffs, and resume. The parent owns reconciliation; bounded workers receive the document locator, task IDs, linked `S#`, authorized scope and checks, not unrelated authority; they read the document until `## Log` before edits and report which `S#` they covered. A rejected or resumed handoff is repaired and resent intact, never shortened. Reproduce a user-reported failure by running its example first; reading code is not reproduction. Close gate: continue every pending tracked task in the document or task list unless it waits on a launched child; an already-decided denial, missing consent, or exhausted limit applies to that affected work; the user stopped only that work; or a genuine human decision is open. Unrelated runnable authorized work continues while blockers or missing proof are reported.

Use about 400 authored changed lines per ODD task only as a planning heuristic, counting additions plus deletions. Keep the smallest coherent behavior with its tests and docs. This is not a task acceptance criterion, hard cap, counter-trigger, automatic stop, forced split, or review trigger. If the correct clear solution naturally exceeds it, briefly explain why and continue without size-only rework loops. Never delete spaces, blank lines, or comments for cosmetic line savings; never omit tests, minify, add gratuitous abstractions, or split artificially to fit the heuristic. Forward this same advisory-only instruction when delegating tasks to subagents. The delivery budget below reads the accumulated branch, not this per-task heuristic. Existing PR size gates remain unchanged; follow repository policy. A user's line limit is a ceiling, never an exact-count gate; never invent acceptance gates the user did not ask for.

#### Research depth without a new phase

Step 3 decides when to research, ask, or challenge. Establish the problem, intended outcome, constraints, and current evidence; inspect relevant code. Adapt depth to uncertainty and consequence: no fixed questionnaire or mandatory rounds. The parent owns product decisions; workers return gaps to the parent rather than assuming choices.

When the question needs external evidence, use available authorized documentation/web tools (`WebSearch`, `WebFetch`) and prefer primary sources. Attribute material claims to URLs or code locations; distinguish verified facts, assumptions, contradictions, freshness, and gaps. If tools are unavailable, disclose limitations without inventing access or evidence. If research is declined, continue within authorized scope only where safe without the missing evidence; pause only unsafe decisions dependent on it.

Return concise findings, recommendation, tradeoffs, open questions, and implementation implications. Offer a concise proposal only when a real scope or product decision needs it. Forward these research instructions to an existing fresh general exploration/research worker (`odd-claude:odd-explore`) through the existing delegation mechanism; do not create a specialized agent or create a new workflow. Research remains read-only and requires no new persistence or readiness machinery.

The step 3 assumption challenge is independent and allowed even in a small security-critical change. Name the premise, evidence, and consequence; do not start a debate loop. Deterministic failures need fixes, not model debate.

Before building, validate any consequential premise whose failure would invalidate the approach. Reuse relevant findings from sibling investigations instead of repeating the same exploration; verify only what is stale or materially different. During iteration, run focused checks for the behavior being changed, then run the applicable full suite at closure.

#### Checks and review

Test-first is the always-on harness principle (test or framework presence alone does not establish applicability); forward this policy, the applicable exact runner and commands (when available), and any exception rationale on every implementation delegation, refresh it on resume, and record observed evidence or the reason for fallback in the feature document.

Run applicable functional checks per task; a task-list checkbox never triggers a review cycle. Checklists grant no approval; with review on, review the candidate before delivery (delivery only warns about an unreviewed candidate and never blocks). Review is advisory and parent-owned (the `review` MCP and `/odd-claude:4r-review`).

#### Delivery

Delivery follows work units. At feature-document creation, forecast authored changed lines (additions plus deletions, generated files excluded) from the task list, and keep a running count from work-unit commits. Choose one delivery strategy per feature: `ask-on-risk` (default), `auto-chain`, `single-pr`, or `exception-ok`. Past about 400 authored changed lines (forecast or running count), record the slice boundary in the feature document; apply the chosen strategy only when the user asks to publish (push or PR), never before a local work-unit commit. Local work-unit commits stay separate from publishing. `ask-on-risk` asks once using the ordered oversized-delivery menu; `auto-chain` asks only for a missing chain strategy and slices automatically with a cached choice. When a choice is needed on either chaining path, offer exactly these three semantic outcomes in order (`AskUserQuestion`):

1. **Feature/tracker branch chain** — `chain_strategy=feature-branch-chain`.
2. **Verified default/main branch chain** — `chain_strategy=stacked-to-main`; verify the destination's default branch rather than assuming its name.
3. **One single PR — least recommended** — `delivery_strategy=single-pr`.

Generate the complete user-facing question and every option label, description, and recommendation marker in the active user's conversation language. Machine strategy tokens remain unchanged and untranslated. These English examples are illustrative and localizable, not mandatory copy.

The third choice overrides the pending chaining path: clear the chain choice as inapplicable and suppress later chain prompts. `single-pr` is not a `chain_strategy` token; do not automatically select `exception-ok`. An oversized single PR adds reviewer load, delays feedback, and couples rollback; least recommended applies only to this menu, not focused ≤400-line PRs. Follow the destination repository's documented contribution/size policy: a `size:exception` label applies only where the destination policy uses it; never add it otherwise, and preserve its maintainer acceptance and protected-label authorization. A single PR needs no tracker, child dependency diagram, or Chain Context. Shape selection does not authorize push, PR creation, or merge. Cache both choices, and record slice boundaries (which commits each PR holds) when chaining; for single PR, the whole-PR scope. Resolve the `work-unit-commits` and `chained-pr` skills by registry name (`/odd-claude:work-unit-commits`, `/odd-claude:chained-pr`), never hardcode their paths.
