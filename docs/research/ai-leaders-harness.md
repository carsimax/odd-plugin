# Harness guidance from AI leaders → odd-claude

Date: 2026-11-25. Baseline: odd-claude 5.2.0. Purpose: collect what AI leaders and labs actually say about building an efficient agent harness, map each point to what odd-claude does today, and list the improvements (M1-M8). Source labels such as `[A6]` point to the Sources section at the end; URLs appear only there. Marks: VERIFIED means the page was fetched and the quoted text read; UNVERIFIED means a secondary source, an undated page or content not retrieved. Quotes are exact only where shown in quotation marks; everything else is a paraphrase.

## Key conclusion

Actionable harness guidance comes mostly from four places: Anthropic engineering, OpenAI Codex harness engineering, Andrew Ng and Karpathy. Hinton, LeCun, Fei-Fei Li and Suleyman talk about risk and the future of AI, not harness design; they add one principle only: verify outside the model. Amodei, Kaplan, Olah, Leike, Cherny, Brockman, Altman, Pachocki, Chen and Sutskever: no primary harness statement was retrieved, so none is used as evidence.

## Recommendations by theme

### Context

| # | Recommendation | Refs |
|---|---|---|
| C1 | Treat context as a finite resource with diminishing returns: "Context, therefore, must be treated as a finite resource with diminishing marginal returns." | [A4] |
| C2 | Clear old tool results first: "One of the safest lightest touch forms of compaction is tool result clearing." | [A4] |
| C3 | Keep notes outside the window and retrieve just in time. | [A4], [O1] |
| C4 | Give the agent a map, not a manual: "give Codex a map, not a 1,000-page instruction manual"; `docs/` is the system of record; "anything it can't access in-context while running effectively doesn't exist". | [O1] |
| C5 | Progressive disclosure for skills: name and description drive triggering; load detail on demand. | [A5] |
| C6 | Fill the window with "just the right information for the next step" (context engineering). | [K1] |
| C7 | Compact when a threshold is crossed. | [O4] |

### Subagents and cost

| # | Recommendation | Refs |
|---|---|---|
| S1 | Multi-agent uses about 15x the tokens of chat; token usage explains 80% of variance on BrowseComp. | [A2] |
| S2 | Poor fit for tasks that need shared context, most coding tasks among them. | [A2] |
| S3 | Brief each subagent with objective, output format, tool guidance and boundaries. | [A2] |
| S4 | Subagents return a condensed summary (1,000-2,000 tokens). | [A4] |
| S5 | Use subagents for read-heavy work; parallel writes conflict; subagents consume more tokens. Parallel writers need worktrees. | [O5], [O2] |
| S6 | Prefer well-scoped parallel tasks. | [O6] |
| S7 | Start with "the simplest solution possible, and only increasing complexity when needed". | [A1] |

### Verification

| # | Recommendation | Refs |
|---|---|---|
| V1 | A standalone evaluator tuned to be skeptical is "far more tractable" than making a generator critique itself. | [A7] |
| V2 | Calibrate the evaluator with few-shot examples. | [A7] |
| V3 | Verify, do not stop at the change. | [O2] |
| V4 | The proposer never grades itself: "AlphaEvolve verifies, runs and scores the proposed programs using automated evaluation metrics." | [X1] |
| V5 | A non-agentic, memoryless checker that rejects harmful agent actions (principle: verify outside the model). | [X4] |
| V6 | Never weaken tests: "It is unacceptable to remove or edit tests because this could lead to missing or buggy functionality." | [A6] |
| V7 | Iterate tests until they pass. | [O6] |
| V8 | Demos are not products: "Demo is works.any(), product is works.all()" (exact wording of the slide not confirmed beyond this line). | [K3] |

### Hooks and invariants

| # | Recommendation | Refs |
|---|---|---|
| H1 | "If something has to happen every time, make it a hook, a deny rule, or a managed setting." (page date UNVERIFIED) | [A9] |
| H2 | "CLAUDE.md is for guidelines." | [A9] |
| H3 | Enforce invariants, not implementations; lint error messages inject remediation. | [O1] |
| H4 | Doc-gardening agents keep docs consistent. | [O1] |
| H5 | Add AGENTS.md rules only after repeated mistakes. | [O2] |

### Evals and measurement

| # | Recommendation | Refs |
|---|---|---|
| E1 | Start evals with about 20 real queries; grade the end state; LLM judge with a rubric plus human testing. | [A2] |
| E2 | Evals and error analysis: "But evals and error analysis can lead to much faster progress."; analyze per step; steps "too rigid" are a smell. | [N1] |
| E3 | Evaluate tools with realistic tasks. | [A3] |
| E4 | Implication, not a quote: with nondeterministic inference, repeat eval trials and report variance. | [X2] |
| E5 | Re-audit the harness per model release: harness assumptions "can go stale as models improve"; strip "pieces that are no longer load-bearing"; context resets were dropped once the model stopped showing context anxiety. | [A8], [A7] |

### Long-running work and task tracking

| # | Recommendation | Refs |
|---|---|---|
| L1 | Initializer first, then one feature per session; progress log; feature list that starts failing. | [A6] |
| L2 | End each session in a mergeable state. | [A6] |
| L3 | Spec with goals, non-goals and done-when; milestones with acceptance criteria; stop and fix; status file. (date UNVERIFIED) | [O3] |
| L4 | Prompt shape: goal, context, constraints, done-when; one chat per coherent unit. | [O2] |
| L5 | Separate session log, harness and sandbox. | [A8] |

### Tools

| # | Recommendation | Refs |
|---|---|---|
| T1 | "Tool definitions and specifications should be given just as much prompt engineering attention as your overall prompts." | [A1] |
| T2 | Few, thoughtful tools; pagination, filtering and truncation. | [A3] |
| T3 | Let the agent choose: "allowing your agent to control whether tools return 'concise' or 'detailed' responses". | [A3] |
| T4 | MCP tools are not sandboxed by Codex; approvals and sandbox are separate controls. | [O4] |

### Human control

| # | Recommendation | Refs |
|---|---|---|
| U1 | Treat the model like an employee or intern with no continual learning: "They don't have continual learning. You can't just tell them something and they'll remember it." | [K2] |
| U2 | Partial autonomy, an autonomy slider, AI on a leash, verification as the bottleneck (paraphrases; exact quotes UNVERIFIED). | [K3] |
| U3 | Approvals and sandbox are separate. | [O4] |
| U4 | Agent-to-agent review is acceptable in the loop, with the human owning disposition. | [O1] |
| U5 | Risk talk from Hinton, LeCun (error compounding), Suleyman and Fei-Fei Li supports only "verify outside the model"; all four sources are UNVERIFIED or secondary. | [R1], [R2], [R3], [R4] |

## Mapping: recommendation → odd-claude today

| Recommendation | odd-claude today | Evidence path |
|---|---|---|
| C3, C4, C5, L1 notes and index | Covered: output style is an index with on-demand cards | `plugins/odd-claude/output-styles/odd.md`, `plugins/odd-claude/cards/` |
| C3 notes outside the window | Covered: feature docs plus SessionStart reinjection | `odd/tasks/*.md`, `plugins/odd-claude/src/hooks/session-start.ts`, `plugins/odd-claude/src/lib/feature-doc.ts` |
| S3, S4 handoffs | Covered: subagent handoffs about 2k tokens | `plugins/odd-claude/cards/writer.md` |
| S5, S6 parallel writes | Covered: parallel writers only with disjoint surfaces or worktrees | `plugins/odd-claude/cards/writer.md` |
| V1, V3, V4 independent check | Covered: independent verifier | `plugins/odd-claude/agents/odd-verify.md` |
| V6, V7 | Covered: completion gate, never-weaken-tests rule, test-first RED/GREEN/PRESERVE | `plugins/odd-claude/agents/odd-worker.md`, `plugins/odd-claude/cards/` |
| C5 skill triggers | Covered: skill descriptions act as triggers | `plugins/odd-claude/skills/*/SKILL.md` |
| Retro of past sessions | Covered: local transcript digest | `plugins/odd-claude/src/lib/retro.ts` |
| Friction measurement | Covered in part: bytes and hook timing only | `bench/`, `scripts/measure.mjs` |
| V2 calibrated evaluator | Gap, M5 (this package) | `plugins/odd-claude/agents/odd-verify.md` |
| L3 done-when per task | Gap, M6 (this package) | `plugins/odd-claude/output-styles/odd.md`, `plugins/odd-claude/cards/tracking.md` |
| H4 doc-gardening | Gap, M7 (this package) | `plugins/odd-claude/src/lib/feature-doc.ts` |
| T3 concise responses | Gap, M8 (this package) | `plugins/odd-claude/src/` (review and peers MCP servers) |
| E1, E4 outcome eval of the harness | Gap, M1 (backlog) | none |
| E5 load-bearing audit | Gap, M2 (backlog) | none |
| H1 completion gate as a hook | Gap, M3 (backlog) | none |
| H5 incident-backed rules, cross-session retro | Gap, M4 (backlog) | none |

## Improvements M1-M8

| ID | Improvement | Status |
|---|---|---|
| M1 | Outcome eval of the harness: about 20 real tasks, end-state grading, N trials, tokens/time/pass rate/variance per profile and delegation mode | backlog |
| M2 | Load-bearing audit per model release: ablate rules and cards using M1 | backlog; depends on M1 |
| M3 | Opt-in Stop completion gate hook. Deny hooks were removed by user decision in v0.5, so opt-in only | backlog |
| M4 | Incident-backed rule ledger and cross-session retro aggregation | backlog |
| M5 | Calibrate odd-verify (skeptical default plus worked verdict examples) | this package (feat/harness-research) |
| M6 | Done-when per task | this package (feat/harness-research) |
| M7 | Lint of `odd/tasks` consistency | this package (feat/harness-research) |
| M8 | Concise MCP responses | this package (feat/harness-research) |

## Caveat: coordinator mode cost

odd-claude defaults to Coordinator mode ON with full delegation: every edit goes through a worker. Anthropic reports about 15x the tokens for multi-agent systems and a poor fit for coding tasks that need shared context [A2]. No data today says whether full delegation pays off in odd-claude. M1 is the way to measure it, per profile and delegation mode. Until then, treat the default as a bet, not a result.

## Not adopted

| Idea | Why not |
|---|---|
| A new autonomy slider [K3] | Permission modes, profiles and delegation mode already cover it. |
| A blocking LLM guard on actions [X4] | The user removed deny hooks in v0.5; any gate stays opt-in (M3). |
| Biographical claims about people's roles | Not evidence of harness design; not used. |
| Hinton, LeCun, Fei-Fei Li, Suleyman positions as design input | Risk and future-of-AI commentary, UNVERIFIED sources; only "verify outside the model" is kept. |

## Sources

Anthropic

- [A1] Building effective agents, 2024-12-19 (Schluntz, Zhang), VERIFIED: https://www.anthropic.com/engineering/building-effective-agents
- [A2] Multi-agent research system, 2025-06-13, VERIFIED: https://www.anthropic.com/engineering/multi-agent-research-system
- [A3] Writing tools for agents, 2025-09-11, VERIFIED: https://www.anthropic.com/engineering/writing-tools-for-agents
- [A4] Effective context engineering, 2025-09-29, VERIFIED: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- [A5] Agent Skills, 2025-10-16, VERIFIED: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- [A6] Effective harnesses for long-running agents, 2025-11-26, VERIFIED: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- [A7] Harness design for long-running apps, 2026-03-24 (Rajasekaran), VERIFIED: https://www.anthropic.com/engineering/harness-design-long-running-apps
- [A8] Managed agents, 2026-04-08, VERIFIED: https://www.anthropic.com/engineering/managed-agents
- [A9] Claude Code best practices, date UNVERIFIED: https://code.claude.com/docs/en/best-practices

Karpathy

- [K1] Context engineering, June 2025, via Simon Willison (original X post UNVERIFIED): https://simonwillison.net/2025/jun/27/context-engineering/
- [K2] Dwarkesh interview, 2025-10-17, via Simon Willison: https://simonwillison.net/2025/Oct/18/agi-is-still-a-decade-away/
- [K3] Software 3.0 talk, 2025-06-17, via Latent Space (paraphrases; exact quotes UNVERIFIED, except "Demo is works.any(), product is works.all()"): https://www.latent.space/p/s3
- [K4] Joined Anthropic pre-training team, 2026-05-19, VERIFIED: https://techcrunch.com/2026/05/19/openai-co-founder-andrej-karpathy-joins-anthropics-pre-training-team/

OpenAI

- [O1] Harness engineering, 2026-02-11 (Lopopolo), VERIFIED: https://openai.com/index/harness-engineering/
- [O2] Codex best practices, undated: https://learn.chatgpt.com/guides/best-practices
- [O3] Long-horizon tasks with Codex, undated (likely 2026), date UNVERIFIED: https://developers.openai.com/blog/run-long-horizon-tasks-with-codex
- [O4] Unrolling the Codex agent loop, 2026-01-23 (Bolin), VERIFIED: https://openai.com/index/unrolling-the-codex-agent-loop
- [O5] Subagents docs, undated: https://learn.chatgpt.com/docs/agent-configuration/subagents
- [O6] Introducing Codex, 2025-05-16, VERIFIED: https://openai.com/index/introducing-codex/
- [O7] A practical guide to building agents (PDF), content UNVERIFIED: https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf

Others

- [X1] AlphaEvolve, 2025-05-14, VERIFIED: https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/
- [N1] Andrew Ng, evals and error analysis part 1, 2025-10-15, VERIFIED: https://www.deeplearning.ai/the-batch/improve-agentic-performance-with-evals-and-error-analysis-part-1
- [X2] Thinking Machines, defeating nondeterminism, 2025-09-10, VERIFIED (the eval-variance implication is ours): https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/
- [X4] Bengio / LawZero, 2025-06-03, VERIFIED: https://yoshuabengio.org/en/blog/introducing-lawzero
- [R1] Hinton, secondary, UNVERIFIED: https://www.cbsnews.com/news/godfather-of-ai-geoffrey-hinton-ai-warning
- [R2] Suleyman, UNVERIFIED: https://microsoft.ai/blog/towards-humanist-superintelligence
- [R3] LeCun, error compounding, UNVERIFIED: https://arxiv.org/html/2606.09311
- [R4] Fei-Fei Li, UNVERIFIED: https://www.pymnts.com/artificial-intelligence-2/2025/ai-needs-spatial-intelligence-for-next-leap-experts-say/
