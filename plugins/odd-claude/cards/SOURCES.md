# Card sources

Each card is a port of an upstream asset (MIT). Provenance lives here only, so the cards themselves carry no upstream naming.

| Card | Upstream path |
|---|---|
| cards/delegation.md | upstream/gentle-shell/assets/orchestrator-delegation.md | <!-- odd-check: allow -->
| cards/delegation-reference.md | upstream/gentle-shell/assets/orchestrator-delegation-reference.md | <!-- odd-check: allow -->
| cards/memory.md | upstream/gentle-shell/assets/orchestrator-memory.md | <!-- odd-check: allow -->
| cards/prompts.md | upstream/gentle-shell/assets/orchestrator-prompts.md | <!-- odd-check: allow -->
| cards/quota-recovery.md | upstream/gentle-shell/assets/orchestrator-quota-recovery.md | <!-- odd-check: allow -->
| cards/skills.md | upstream/gentle-shell/assets/orchestrator-skills.md | <!-- odd-check: allow -->
| cards/tracking.md | upstream/gentle-shell/assets/orchestrator-tracking.md | <!-- odd-check: allow -->
| cards/verification.md | upstream/gentle-shell/assets/orchestrator-verification.md | <!-- odd-check: allow -->
| cards/writer.md | upstream/gentle-shell/assets/orchestrator-writer.md | <!-- odd-check: allow -->
| cards/full-delegation.md | upstream/gentle-shell/assets/orchestrator-full-delegation.md + orchestrator-full-delegation-card.md | <!-- odd-check: allow -->

## Always-on context sources

Managed CLAUDE.md blocks, the path-scoped rule and the output style are ports (MIT) of upstream assets; revisions: gentle-ai 423d90a, gentle-shell d397fab. Port map: docs/research/always-on-context-port-map.md. <!-- odd-check: allow -->

| Shipped file | Upstream path |
|---|---|
| claude-md/01-identity.md, 02-continuity.md, 04-task-size.md, 05-delegation.md, 06-language.md, 07-safety.md | upstream/gentle-ai/internal/assets/claude/orchestrator.md + the agent-routing contract in upstream/gentle-ai/internal/components/agentguidance (rendered Claude CLAUDE.md) | <!-- odd-check: allow -->
| claude-md/03-protocol.md | upstream/gentle-ai agent-routing ODD protocol, merged with the former output-style protocol | <!-- odd-check: allow -->
| claude-md/08-memory.md | upstream/gentle-ai/testdata/golden/engram-claude-claudemd.golden | <!-- odd-check: allow -->
| rules/odd-tracking.md | upstream/gentle-ai agent-routing "Organic Driven Development" reference + cards/tracking.md and cards/memory.md | <!-- odd-check: allow -->
| output-styles/odd.md | upstream/gentle-ai/internal/assets/claude/output-style-neutral.md + persona-neutral-residual.md + upstream/gentle-shell/extensions/gentle-ai.ts (NEUTRAL_PERSONA_PROMPT) | <!-- odd-check: allow -->

## Technique sources

Ideas adapted in our own words (MIT); short phrases may echo the originals.

| Upstream | License | Used in |
|---|---|---|
| obra/superpowers | MIT, Copyright (c) 2025 Jesse Vincent | skills/odd Completion gate; agents/odd-worker test-first excuse table | <!-- odd-check: allow -->
| addyosmani/agent-skills | MIT, Copyright (c) 2025 Addy Osmani | verification handoff without the writer's claim; never-weaken rule | <!-- odd-check: allow -->
| obra/superpowers | MIT, Copyright (c) 2025 Jesse Vincent | skills/systematic-debugging/ (from systematic-debugging with root-cause-tracing, defense-in-depth, condition-based-waiting) | <!-- odd-check: allow -->
| obra/superpowers | MIT, Copyright (c) 2025 Jesse Vincent | skills/receiving-review/ (from receiving-code-review) | <!-- odd-check: allow -->
| addyosmani/agent-skills | MIT, Copyright (c) 2025 Addy Osmani | skills/systematic-debugging/ (from debugging-and-error-recovery) | <!-- odd-check: allow -->
| obra/superpowers | MIT, Copyright (c) 2025 Jesse Vincent | skills/odd-retro/ and src/lib/retro.ts (from diagnosing-superpowers) | <!-- odd-check: allow -->
| obra/superpowers | MIT, Copyright (c) 2025 Jesse Vincent | skills/skill-creator/references/pressure-testing.md and assets/pressure-scenario.md (from writing-skills with references/testing-skills-with-subagents.md and references/bulletproofing.md) | <!-- odd-check: allow -->
