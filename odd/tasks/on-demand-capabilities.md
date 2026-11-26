# On-demand capabilities: skills, subagents, workflows, registry and MCP
Goal: improve, harden and slim odd-claude's Layer 2 (On-demand capabilities of `docs/claude-code-extensibility.md`): skills, subagent frontmatter, dynamic workflows, skill registry and MCP text. Branch: `feat/on-demand-capabilities` (base `a16beb2`). Delivery: one work-unit commit per task, push/PR are the user's.
Runner: `node:test` via `npm test` inside `plugins/odd-claude` + `npm run check`; installer tests run against temp `HOME`/`CLAUDE_CONFIG_DIR`, never the real `~/.claude`.

## Specs

### S1 Goal (verbatim)
- "Vamos con la siguien te fase de estos nuevos cambios: Layer 2 - On-demand capabilities la idea es mejorar y reforzar y optimizar"

### S2 Fronts in scope (verbatim answer, multi-select)
- "Skills: limpieza y frontmatter, Subagentes: frontmatter, Workflows dinámicos, Skill registry y MCP"

### S3 Skill `odd` (verbatim answer)
- "Adelgazar (Recommended)": keep only skill-only content (completion gate table, review forecast) plus pointers to `claude-md/` blocks and rules; fix identity and stale references.

### S4 4r-review packaging (verbatim answer)
- "Workflow + skill mínima (Recommended)": the workflow does the orchestration and the merge; the skill stays as a light entry point that resolves the diff and launches the workflow (inline fallback when workflows are disabled).

### S5 skill-creator (verbatim answer)
- "Mantener la nuestra (Recommended)": keep ours; only review its description.

### S6 Parent proposals within S2 (evidence-backed, from the mapping)
- S6a Skills: no stale references to "the odd output style" as holder of Task Size/Delegation/steps; identity text matches `claude-md/01-identity.md`; descriptions over 200 chars trimmed (`odd-profiles`, `odd-retro`, `odd`, `4r-review`) without breaking pinned tests.
- S6b Subagents: the installer writes the profile's per-role `effort:` into installed agent frontmatter next to `model:` (today only `model:` is written; effort applies only when the parent passes it per spawn).
- S6c Registry: `.atl/skill-registry.md` keeps its exact-path table; prose that repeats `rules/odd-skills.md` shrinks to one contract line.
- S6d MCP `odd-review`: the transition-arguments `NOTE` appended to 8 tool descriptions is stated once (server instructions or `review_status`); the "start with review_status, follow next_transition" protocol keeps one always-on copy (`claude-md/03-protocol.md` step 7) plus the MCP's own instructions, and is removed from the other always-on duplicates. `odd-peers` is unchanged.
- S6e Measure before/after: description bytes, `skills/odd/SKILL.md` bytes, `skills/4r-review/SKILL.md` bytes, total `odd-review` tool description bytes.

## Decisions
- D1 Rejected after mapping (evidence in Log L4): `allowed-tools` on read-only skills (it pre-approves, does not restrict); `context: fork` on odd-retro/4r-review/judgment-day (intake asks the human; forks must not spawn subagents); `isolation: worktree` on odd-jd-fix (judges bind to the parent's tree, parent owns git); `skills:` preload on odd-worker (replaces the parent's per-task subset with a static list); judgment-day as workflow (mid-run human approval gate and shell hash).
- D2 Workflow name `odd-4r-review` (avoids clashing with the `/4r-review` skill); lens agents get the diff text through `args` because `odd-review-*` have no Bash; `agent(..., {agentType: 'odd-review-<lens>', schema})`.
- D3 Baseline (commit `a16beb2`): description bytes 4356; `skills/odd/SKILL.md` 4575 B; `skills/4r-review/SKILL.md` 3816 B; `src/mcp/tools.ts` 32067 B with `NOTE` used 8 times.

## Tasks
- [ ] T1 S3,S5,S6a Slim skill `odd`, fix stale refs, trim long descriptions. Route: delegated odd-worker (Coordinator ON). Risk: none. Commit: -. done when: `grep -n "odd output style" plugins/odd-claude/skills -r` is empty, every description ≤200 chars, `npm test` and `npm run check` pass.
- [ ] T2 S6b Installer writes per-role `effort:` into installed agents. Route: delegated odd-worker (Coordinator ON). Risk: item 5 (installer). Commit: -. done when: an installer test shows `effort:` written per profile role and absent when the role has none; `npm test` passes; independent odd-verify PASS.
- [ ] T3 S4,S6a Workflow `odd-4r-review` + minimal `4r-review` skill + installer ships `workflows/`. Route: delegated odd-worker after T2 (shares `src/installer/files.ts`). Risk: item 5 (installer). Commit: -. done when: workflow file parses with a pure-literal `meta`, a test checks install plan includes `workflows/odd-4r-review.js`, the skill has an inline fallback, `npm test` passes; independent odd-verify PASS.
- [ ] T4 S6c,S6d Registry prose slim + MCP NOTE/protocol dedupe. Route: delegated odd-worker, parallel with T1/T2 (disjoint surfaces). Risk: none. Commit: -. done when: `NOTE` appears in at most one description, review protocol appears once in `claude-md/` and not in `rules/odd-tracking.md`, `npm test` passes.
- [ ] T5 S6e Measure after and record in Log. Route: parent (state Bash). Risk: none. done when: Log has before/after numbers.

## Log
- L1 "Vamos con la siguien te fase de estos nuevos cambios: Layer 2 - On-demand capabilities la idea es mejorar y reforzar y optimizar"
- L2 Scope answer: "Skills: limpieza y frontmatter, Subagentes: frontmatter, Workflows dinámicos, Skill registry y MCP"
- L3 Design answers: odd skill "Adelgazar (Recommended)"; 4r-review "Workflow + skill mínima (Recommended)"; skill-creator "Mantener la nuestra (Recommended)".
- L4 Mapping (4 odd-explore): allowed-tools pre-approves only (code.claude.com/docs/en/skills); fork has no history and odd-retro intake asks the human (skills/odd-retro/SKILL.md:25); odd-jd-fix edits the parent tree the judges bind to (skills/judgment-day/SKILL.md:47,52); plugins ship workflows in `workflows/` (code.claude.com/docs/en/workflows.md), installer copies only skills/rules/agents/output style (src/installer/files.ts:84-101); applyAgentModel writes only `model:` (src/installer/models.ts:78-86); NOTE at src/mcp/tools.ts:123 appended at 8 tools; review protocol duplicated in claude-md/03-protocol.md:15, claude-md/05-delegation.md:20, rules/odd-tracking.md:47, review-server.ts:22, tools.ts:358.
