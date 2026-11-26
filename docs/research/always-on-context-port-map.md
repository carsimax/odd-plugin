# Always-on context port map (gentle-ai Claude CLAUDE.md -> odd-claude)

Task T1 of `odd/tasks/always-on-context.md` (S3, S4, S7c). Upstream: `upstream/gentle-ai` @ 423d90a. All sizes are bytes of source text before adaptation; "Dest" classes: CLAUDE (managed block), RULE-P (path-scoped rule), RULE-U (unscoped rule), CARD (stays a lazy card), STYLE (output style, T4), HOOK (dynamic hook line), DROP, MERGED (duplicate counted under its canonical row).

## 1. What gentle-ai installs

No golden holds the full file (`combined-claude-claudemd.golden` is 4,814 B: persona + slim Engram only). The 81,488 B baseline (`orchestrator-module-baseline.json`, id `claude-code`, sha256 `81ca3293...`) was rendered with the real carrier `agentguidance.InjectRoutingWithOptions` against a temp HOME, in a copy of upstream under the session scratchpad (upstream itself untouched). The rendered file matches 81,488 B exactly.

- Rendered file: `/private/tmp/claude-501/-Users-carsimax-Developer-03-PERSONAL-odd-claude/ea6887a5-42cc-4b8b-9bcd-62372980b4ae/scratchpad/rendered-claude-CLAUDE.md` (81,488 B, 493 lines).
- Composition: `<!-- gentle-ai:orchestrator -->` (`claude/orchestrator.md` raw 12,086 B + the 18,426 B native review contract + shared sections = 49,679 B rendered) and `<!-- gentle-ai:agent-routing -->` (routing.go: ODD protocol, Task Size, Triggers, ODD reference, worker table, nested `remote-authorization`). The remaining ~31 KB between 49,679 and 81,488 is the routing block.
- NOT in the 81,488 B: the `persona` block (2,008 B) and the slim `engram-protocol` block (2,636 B), written by other components into the same file (`combined-claude-claudemd.golden`). Tone also lives in the Claude output style (neutral 5,446 B), not in CLAUDE.md.
- The full-text version at runtime is a superset of what `odd.md`+cards carry today only for sections that are gentle-ai CLI-specific (review lifecycle); for the rest odd-claude already ports gentle-shell's leaner equivalents.

## 2. Per-section inventory and mapping (gentle-ai, 81,488 B file; reconciled to the byte)

| Source | Section | Bytes | Dest | Target | Purpose | Claude-relevant | Residue / notes |
|---|---|---:|---|---|---|---|---|
| G-orch | opening marker `gentle-ai:orchestrator` | 32 | DROP | - | block delimiters | n/a | replaced by `odd-claude:ID` markers |
| G-orch | title + 'bind to Claude orchestrator only, not workers' | 142 | CLAUDE | identity | scope line: parent only, not delegated workers | yes | title says Agent Teams Lite (rename) |
| G-orch | ## Agent Teams Orchestrator | 29 | DROP | - | heading | n/a | gentle-ai naming |
| G-orch | ### Identity Contract | 200 | CLAUDE | identity | persona/voice live in the output style | yes | none |
| G-orch | ### Core Role | 636 | CLAUDE | identity | inline by default, delegate only on a named trigger, short synthesis | yes | none |
| G-orch | ### Authorized work continuity | 2,342 | CLAUDE | continuity | do not ask per step; short replies accept the last proposal; background/pending-child rules | yes | none |
| G-orch | ### Mental Model | 379 | DROP | - | 'gentle-ai is an ecosystem configurator' framing | no | gentle-ai marketing; the two bullets duplicate the protocol |
| G-orch | ### ODD Is The Default Workflow | 370 | CLAUDE | protocol | ODD runs first on every request | yes | none |
| G-orch | ### Lossless Blocking Prompts | 2,870 | CARD | prompts.md (exists, 2,975 B) | relay subagent choice envelopes unchanged | yes (situational: only when a child blocks) | none |
| G-orch | #### Provider Defect Handoff | 963 | DROP | - | file a defect against gentle-ai | no | gentle-ai CLI/issue filing |
| G-orch | ### Language Domain Contract | 943 | CLAUDE | language | persona = conversation only; artifacts English | yes | none |
| G-orch | ### Delegation Rules (action table) | 2,065 | CLAUDE | delegation | inline vs delegated per action; worker classes | yes | says odd-explorer/worker/verify are NOT named agents (false for us) |
| G-orch | #### Delegation Triggers (orchestrator copy) | 2,845 | MERGED | delegation (routing copy is canonical) | trigger list | yes | duplicate of the routing copy; our cards/delegation.md is its port |
| G-orch | #### Delegated Verification Gate | 3,960 | CARD | verification.md (exists) | risk tiers, verifier occasion, correction bounds | yes (situational) | `gentle-ai review assess` CLI, RDD status line |
| G-orch | #### Native Checking Contract | 2,006 | CARD | verification.md (exists) | normalization-before-review ordering, passive readback | yes (situational) | 'Native RAR', receipts |
| G-orch | #### Review Execution Contract (17 subsections: entry rule ... delivery policy) | 17,441 | DROP | - | gentle-ai review lifecycle: STATUS/START tokens, lenses, consent, capture, ack, stop-code table | no | entire `gentle-ai review ...` CLI; our `odd-review` MCP ships its own server instructions |
| G-orch | ### Concurrent Reviewer Group | 1,019 | DROP | - | launch 4R captures in parallel | no | gentle-ai review tokens |
| G-orch | #### Cost and Context Balance | 477 | MERGED | delegation | 4 bullets already in Delegation Rules | yes | duplicate |
| G-orch | ### Work Routing Ladder (+ inline, simple delegation) | 3,048 | CARD | delegation-reference.md (exists) | pick the smallest harness | yes (situational) | none |
| G-orch | ### Canonical Lightweight Workflows | 738 | CARD | delegation-reference.md (exists) | 3 worked flows | yes (situational) | none |
| G-orch | ### Allowed edit surfaces (MANDATORY) | 3,213 | CARD | writer.md (exists) | how to derive/pass `## Allowed edit surfaces` | yes (only at writer launch) | none; one sentence stays in `delegation` |
| G-orch | ### Delivery strategy | 167 | CLAUDE | safety | push/PR/merge stay human | yes | none |
| G-orch | ### Intent-Driven Skill Discovery | 1,492 | CARD | skills.md (exists) | registry-first skill discovery | yes (situational) | none |
| G-orch | ### Safety | 685 | CLAUDE | safety | no commit unless asked, destructive ops, parallel writers | yes | none |
| G-orch | ### Skill Registry Protocol | 1,649 | CARD | skills.md (exists) | pass exact SKILL.md paths, interpret skill_resolution | yes (situational) | none |
| G-orch | closing marker `/gentle-ai:orchestrator` | 34 | DROP | - | delimiter | n/a | - |
| G-route | opening marker `gentle-ai:agent-routing` | 33 | DROP | - | delimiter | n/a | - |
| G-route | ## Implementation Routing (intro) | 282 | CLAUDE | protocol | ODD is the predefined workflow | yes | none |
| G-route | ### ODD protocol (7 steps) | 6,111 | CLAUDE | protocol | authorize, explore, resolve, classify, track, implement, close | yes | `gentle-ai review assess` in step 7 (adapt to `odd-review`) |
| G-route | ### Task Size (+ Risk line) | 3,812 | CLAUDE | task-size | small/large test, 6 high-risk items, route | yes | none |
| G-route | ### Delegation Triggers (routing copy, canonical) | 4,760 | CLAUDE | delegation | ask/mapping/verification/tracking/writer triggers, parallel writers, invariants, backstop | yes | says ONE explorer, parent writes inline (see contradictions) |
| G-route | ### Organic Driven Development (reference detail) | 13,695 | RULE-P | odd-tracking.md | feature-document layout, mirror, resume, test-first, delivery strategy, review gating | yes | `gentle-ai review assess/RDD` lines (adapt to `odd-review`) |
| G-route | ### Receipt-driven development is user-owned | 1,232 | DROP | - | `gentle-ai review mode enable|disable|status` | no | gentle-ai CLI switch; `odd-review` consent is the human's via MCP |
| G-route | ### Claude ODD worker assignments | 431 | DROP | - | model/effort per worker class | partly | covered by agent frontmatter (`model:`) and the per-session hook line; names differ (odd-explorer vs odd-explore) |
| G-route | marker `gentle-ai:remote-authorization` | 81 | DROP | - | delimiters | n/a | - |
| G-route | ## Remote operation authorization | 1,272 | CLAUDE | safety | no SSH/remote work or ambient credentials without explicit authorization | yes | none; odd-claude lacks it today |
| G-route | closing marker `/gentle-ai:agent-routing` | 34 | DROP | - | delimiter | n/a | - |

## 3. Outside the 81,488 B file (gentle-ai persona/engram blocks)

| Source | Section | Bytes | Dest | Target | Purpose | Claude-relevant | Residue / notes |
|---|---|---:|---|---|---|---|---|
| G-persona | `gentle-ai:persona` block (Rules, Expertise, Contextual Skill Loading, Persona Voice; golden persona-claude-neutral) | 2,008 | STYLE | output style (T4) | response length, one question, verify claims, no AI attribution | partly | Expertise = Gentleman stack list; 'self-check every response against available_skills' duplicates Claude's own skill tool; 'never add Co-Authored-By' contradicts harness attribution rules (drop that bullet, see open questions) |
| G-engram | `gentle-ai:engram-protocol` slim block (golden engram-claude-claudemd) | 2,636 | CLAUDE | memory | mem_current_project resolution, proactive save, delivery guarantee, ambiguous_project recovery | yes | full protocol is already delivered by Engram MCP instructions + SessionStart hook; keep only the always-on rules |

## 4. odd-claude current protocol (output style, cards, hook text)

| Source | Section | Bytes | Dest | Target | Purpose | Claude-relevant | Residue / notes |
|---|---|---:|---|---|---|---|---|
| O-style | odd.md frontmatter + header | 162 | STYLE | output style (T4) | name `odd`, description, keep-coding-instructions | yes | - |
| O-style | ## odd-claude Identity and Harness | 1,389 | CLAUDE | identity | who odd-claude is, coordinator ON/OFF, batching, no status-only turns | yes | none |
| O-style | ## Authorized work continuity | 388 | MERGED | continuity | condensed port of the G section | yes | G is the fuller text |
| O-style | ## ODD protocol (7 steps) | 2,716 | MERGED | protocol | condensed port; adds AskUserQuestion, TaskCreate/TodoWrite, Engram mirror, subagent handoff syntax | yes | keep its tool-name adaptations when merging into the G text |
| O-style | ## Task Size | 1,730 | MERGED | task-size | condensed port | yes | G is the fuller text |
| O-style | ## Delegation (7 triggers, agent roster) | 2,944 | CLAUDE | delegation | adds `odd-explore` x N in parallel, `odd-jd-*`, incident trigger, context backstop, card pointers | yes | none |
| O-style | ## Memory Contract | 364 | CLAUDE | memory | mem_* tool names (user-level and plugin server), workers save only with a project | yes | none |
| O-style | ## Language Boundary | 472 | MERGED | language | artifact language + persona variant from session context | yes | G wording merged; persona variant moves to output style |
| O-style | ## Safety | 507 | CLAUDE | safety | adds project-root boundary and EnterWorktree for parallel writers | yes | none |
| O-card | cards/tracking.md | 9,285 | MERGED | odd-tracking.md | port of the G ODD reference | yes | G section is the canonical size; diff for deltas in T3 |
| O-card | cards/memory.md | 8,074 | RULE-P | odd-tracking.md | feature-document order, Engram mirror topic, resume, mirror refresh | yes | none (Engram-specific detail G delegates to MCP) |
| O-card | cards/verification.md | 7,285 | CARD | verification.md | tiers, escalation, verifier preparation failure, parallel review | yes | none |
| O-card | cards/delegation.md | 4,400 | CARD | delegation.md | handoff, triggers, launch | yes | none |
| O-card | cards/delegation-reference.md | 10,827 | CARD | delegation-reference.md | overlays, background subagents (3,220 B), model routing, ladder | yes | none |
| O-card | cards/full-delegation.md | 3,400 | CARD | full-delegation.md | coordinator mode rules | yes | none |
| O-card | cards/prompts.md | 4,336 | CARD | prompts.md | sources, subagent questions, Lossless Blocking Prompts | yes | none |
| O-card | cards/quota-recovery.md | 1,714 | CARD | quota-recovery.md | verifier quota recovery + StopFailure notes | yes | none |
| O-card | cards/skills.md | 4,557 | CARD | skills.md | registry protocol, discovery | yes | none |
| O-card | cards/writer.md | 4,513 | CARD | writer.md | writer handoff, edit surfaces, Judgment Day dispatch | yes | none |
| O-card | cards/SOURCES.md | 2,722 | DROP | - | provenance table | n/a | not model context; stays in the repo only |
| O-hook | context.ts LANGUAGE_RULE (static text) | 664 | CLAUDE | language | reply in the user's latest-message language, never by compaction summary | yes | none; the per-turn anchor stays dynamic |
| O-hook | context.ts cards-directory line | 250 | CLAUDE | identity | `~/.odd-claude/current/cards` path + 'read a card only when its situation arises' | yes | path becomes static (installer-managed) |
| O-hook | context.ts personaText (neutral) | 700 | STYLE | output style (T4) | tone, no voseo | yes | - |
| O-hook | context.ts fullDelegationText | 567 | HOOK | hook (dynamic: mode switch) | coordinator ON rule text | yes | mode can be OFF per user, so it cannot be unconditional in CLAUDE.md; shorten to one line |

## 5. Comparison

gentle-ai has, odd-claude lacks:
- `Remote operation authorization` (1,272 B): no SSH/ambient-credential use without explicit authorization. Ported (safety).
- Full `Authorized work continuity` text (2,342 B vs our 388 B). Ported (continuity).
- `Mental Model`, `Provider Defect Handoff`, `Receipt-driven development` and the whole `gentle-ai review` lifecycle: gentle-ai CLI only; not ported.
- Normalization-before-review ordering and passive-document readback rule (inside Native Checking): partially present in our verification/full-delegation cards; merge the rest into `verification.md`.

odd-claude has, gentle-ai lacks:
- Coordinator mode (full delegation, default ON) and its card; `odd-explore` fan-out (several in parallel); Judgment Day agents `odd-jd-*`; `odd-review-*` lens agents and the `odd-review` MCP; background subagents policy and model routing (3,220 + 714 B); quota recovery card; `odd-peers`; project-root/EnterWorktree safety; subagent `AskUserQuestion` limitation note; per-turn reply-language anchor; scratch dir, reinjection after compact/resume.

Contradictions to resolve when authoring blocks (T3):
1. Writing: gentle-ai says the parent writes small/large-without-reason tasks inline and delegates a writer only for a named reason. odd-claude default Coordinator ON says the parent never implements. The CLAUDE.md `delegation` block must be conditional on the hook line (`Coordinator mode: ON|OFF`).
2. Explorer: gentle-ai: ONE read-only explorer, worker classes "not installed named agents", `odd-explorer` on sonnet. Ours: several `odd-explore` in parallel, installed agents, haiku.
3. Review: gentle-ai `gentle-ai review assess|status|start`, RDD on by default, switch via CLI. Ours: `odd-review` MCP (review_status / next_transition), consent from the human. Every `gentle-ai review` mention must become the MCP flow or be dropped.
4. Attribution: gentle-ai persona says never add Co-Authored-By; harness/user rules may require the trailer. Not ported.
5. Persona 'Contextual Skill Loading: self-check against <available_skills> before every response' conflicts with our 'read a card only when its situation arises' and duplicates Claude's skill tool. Not ported.
6. Verification gate: gentle-ai runs `review assess --escalate-item`; ours names the high-risk item in the Risk line only. Keep ours.

## 6. Totals

| Destination | Bytes | Loads |
|---|---:|---|
| CLAUDE.md managed blocks (8 blocks) | 32,541 | every session |
| Path-scoped rules (`odd-tracking.md`) | 21,769 | when a file under `odd/tasks/**` is read |
| Unscoped rules | 0 | none proposed (see decision 3) |
| Lazy cards (kept in `~/.odd-claude/current/cards`) | 60,008 | on demand, by Read |
| Output style (T4: persona/tone only) | 2,870 | every session (system prompt) |
| Hook, dynamic (per session) | 567 | every session (hook) |
| Dropped (non-Claude, residue, delimiters, provenance) | 24,430 | never |
| Merged duplicates (counted once under their canonical row) | 17,913 | n/a |
| **All rows** | **160,098** | |

CLAUDE.md block total with a 15% adaptation margin: **37,422 B** (budget 80,000). The gentle-ai installed file is 81,488 B; of it, 23,787 B survive in CLAUDE.md here.

### CLAUDE.md blocks (marker ids)

| Block id | Content | Source bytes |
|---|---|---:|
| `odd-claude:identity` | scope line, identity, core role, cards path | 2,617 |
| `odd-claude:continuity` | authorized work continuity | 2,342 |
| `odd-claude:protocol` | ODD default + 7-step protocol | 6,763 |
| `odd-claude:language` | language domain + reply-language rule | 1,607 |
| `odd-claude:delegation` | action table, triggers, agent roster, incident, backstop | 9,769 |
| `odd-claude:safety` | safety, delivery, remote authorization, project-root | 2,631 |
| `odd-claude:task-size` | Task Size + Risk line | 3,812 |
| `odd-claude:memory` | Engram always-on rules + mem_* tool names | 3,000 |
| **Total** | | **32,541** |

Path-scoped rules:

| Rule file | Proposed `paths:` | Bytes |
|---|---|---:|
| `rules/odd-tracking.md` | `odd/tasks/**`, `odd/**/*.md` | 21,769 (G ODD reference 13,695 + memory card 8,074; the tracking card 9,285 is merged into it) |

## 7. Top mapping decisions

1. Everything Claude-relevant that every turn needs goes to 8 CLAUDE.md blocks: 32,541 B, far under 80,000, so no overflow is forced and "portar contenido completo" holds for every non-CLI section.
2. The gentle-ai review lifecycle (17,441 + 1,019 B) is dropped: it is `gentle-ai review ...` CLI text; the `odd-review` MCP already ships its own server instructions.
3. No unscoped rule: it would load at start like CLAUDE.md and save nothing; there is no separation need since blocks are already separately managed.
4. Only `odd/tasks/**` has a real path trigger, so only the ODD reference + feature-document/Engram-mirror detail (21,769 B) becomes a path-scoped rule. Caveat: a path rule loads when Claude reads a matching file, so creating a NEW feature document (step 5) fires nothing; step 5 keeps a minimal layout in the `protocol` block and the rule covers resume/edit.
5. Cards without a path trigger (verification, delegation, writer, prompts, skills, quota, full-delegation, delegation-reference: 60,008 B) stay lazy cards. Moving them to rules would either be unscoped (always-on cost) or need an artificial `paths:`.
6. gentle-ai text wins as canonical for continuity, ODD protocol, Task Size, triggers, safety, language; our deltas (AskUserQuestion, TaskCreate, `odd-explore` fan-out, EnterWorktree) are merged in.
7. Remote operation authorization is new content for odd-claude (safety block).
8. Hook `fullDelegationText` stays dynamic (mode can be OFF); static `LANGUAGE_RULE` and the cards path move to CLAUDE.md, the hook keeps only the per-turn anchor (S7d).
9. Persona block goes to the output style (T4), minus Expertise, the skill self-check and the Co-Authored-By bullet.
10. Slim Engram block merges with our Memory Contract into one `memory` block; the full Engram protocol stays with the Engram MCP/SessionStart hook.

## 8. Open questions for the parent

1. Fidelity vs cost: the plan loads about 32,541 B always-on (about 8,135 tokens) vs 81,488 B gentle-ai. Is "portar contenido completo" satisfied by porting every Claude-relevant section (this map), or must gentle-ai's review lifecycle text also be adapted to `odd-review` inside CLAUDE.md?
2. Cards: keep them as lazy cards (this map) or move them to unscoped rules (S4 says the rest go to `~/.claude/rules/`)? Unscoped rules cost always-on bytes; I recommend cards.
3. Add `paths:` for skills (`.atl/skill-registry.md`, `**/SKILL.md`) so `skills.md` could become a path rule? The registry protocol is needed at delegation time, before those files are read, so I did not.
4. The `odd-tracking` rule loads on read of `odd/tasks/**`; accept that new-document creation relies on the `protocol` block?
5. Co-Authored-By: confirm dropping gentle-ai's 'never add attribution' bullet.
6. Coordinator ON text: keep the one-line mode rule in the hook (this map) or put a conditional paragraph in the `delegation` block?
7. Subagents inherit CLAUDE.md; the scope line 'parent only, not delegated workers' is kept in `identity` (S7b `omitClaudeMd` covers read-only agents only; `odd-worker`/`odd-verify` still receive it).
