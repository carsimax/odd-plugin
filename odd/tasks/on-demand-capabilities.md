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
- [x] T1 S3,S5,S6a Slim skill `odd`, fix stale refs, trim long descriptions. Route: delegated odd-worker (Coordinator ON). Risk: none. Commit: 7263fa5. done when: `grep -n "odd output style" plugins/odd-claude/skills -r` is empty, every description ≤200 chars, `npm test` and `npm run check` pass.
- [x] T2 S6b Installer writes per-role `effort:` into installed agents. Route: delegated odd-worker (Coordinator ON). Risk: item 5 (installer). Commit: 56fd3de + b0f62ad. done when: an installer test shows `effort:` written per profile role and absent when the role has none; `npm test` passes; independent odd-verify PASS.
- [x] T3 S4,S6a Workflow `odd-4r-review` + minimal `4r-review` skill + installer ships `workflows/`. Route: delegated odd-worker after T2 (shares `src/installer/files.ts`). Risk: item 5 (installer). Commit: a28840a + c3b7fa1. done when: workflow file parses with a pure-literal `meta`, a test checks install plan includes `workflows/odd-4r-review.js`, the skill has an inline fallback, `npm test` passes; independent odd-verify PASS.
- [x] T4 S6c,S6d Registry prose slim + MCP NOTE/protocol dedupe. Route: delegated odd-worker, parallel with T1/T2 (disjoint surfaces). Risk: none. Commit: 197c29f. done when: `NOTE` appears in at most one description, review protocol appears once in `claude-md/` and not in `rules/odd-tracking.md`, `npm test` passes.
- [x] T5 S6e Measure after and record in Log. Route: parent (state Bash). Risk: none. done when: Log has before/after numbers.

## Log
- L1 "Vamos con la siguien te fase de estos nuevos cambios: Layer 2 - On-demand capabilities la idea es mejorar y reforzar y optimizar"
- L2 Scope answer: "Skills: limpieza y frontmatter, Subagentes: frontmatter, Workflows dinámicos, Skill registry y MCP"
- L3 Design answers: odd skill "Adelgazar (Recommended)"; 4r-review "Workflow + skill mínima (Recommended)"; skill-creator "Mantener la nuestra (Recommended)".
- L4 Mapping (4 odd-explore): allowed-tools pre-approves only (code.claude.com/docs/en/skills); fork has no history and odd-retro intake asks the human (skills/odd-retro/SKILL.md:25); odd-jd-fix edits the parent tree the judges bind to (skills/judgment-day/SKILL.md:47,52); plugins ship workflows in `workflows/` (code.claude.com/docs/en/workflows.md), installer copies only skills/rules/agents/output style (src/installer/files.ts:84-101); applyAgentModel writes only `model:` (src/installer/models.ts:78-86); NOTE at src/mcp/tools.ts:123 appended at 8 tools; review protocol duplicated in claude-md/03-protocol.md:15, claude-md/05-delegation.md:20, rules/odd-tracking.md:47, review-server.ts:22, tools.ts:358.
- L5 T1 done (7263fa5): skills/odd/SKILL.md 4575 B -> 2162 B; descriptions <=200 chars guarded by src/conformance/skill-descriptions.spec.ts (RED: 4r-review 219, odd-profiles 253, odd-retro 220, "odd output style" in odd). T4 done (197c29f): NOTE only on review_status (odd-review tool descriptions 4556 B -> 3240 B); registry Contract+Loading protocol prose -> one line; rules/odd-tracking.md points to protocol step 7; claude-md/05-delegation.md:20 did not restate the protocol, left unchanged. T2 committed 56fd3de: roleEffort/applyAgentEffort, differential vs a16beb2 shows only added effort lines; odd-verify running.
- L6 Seam check after T1/T2/T4 (parent, `npm test` in plugins/odd-claude): tests 1459, pass 1457, fail 0, skipped 1, todo 1 (lock-race A1 documented limit); `npm run check`: check-naming ok. Parallel worker runs earlier showed load-sensitive lock/store failures; not reproduced in the single run.
- L7 odd-verify T2: partial. PASS: per-role effort, idempotency, upgrade as installer-owned update, conflict on user edit, CRLF, differential. Unmet: effort written to haiku agents while src/review/reviewer-model.ts:24,29 holds haiku carries no effort. Advisories: stale README.md:487 and skills/odd-profiles/SKILL.md:9; missing upgrade/custom tests. Known pre-existing limit (not fixed): custom per-role effort reset to balanced by writeProfileState (src/installer/models.ts:59-60). One correction batch sent to the T2 writer.
- L8 T3 committed a28840a: workflows/odd-4r-review.js (agentType odd-review-<lens>, schema per charter row, JS merge), minimal skill with inline fallback (3816 B -> 3766 B), installer ships workflows/*.js under manifest ownership. Writer: npm test 1463 pass 0 fail; check-naming ok. odd-verify running. Parent removed ~14k leaked odd-src-*/odd-home-*/diffhome-* temp dirs left by test runs (pre-existing test-isolation leak).
- L9 T2 correction b0f62ad (haiku guard in roleEffort, upgrade/per-profile tests, README/odd-profiles docs). Re-verify limited to blockers: PASS on haiku (every preset, custom-to-haiku, undefined role passes source frontmatter untouched) and non-haiku lines unchanged vs 56fd3de; installer specs 32/32. Doc advisory: README.md:487 names a nonexistent `/odd-install` and says `~/.claude/agents` (target is CLAUDE_CONFIG_DIR when set); per-spawn `effort` override claim is true (the Agent tool exposes `effort`). Fixed with the T3 continuation.
- L10 odd-verify T3: FAIL, blocker: clean-lens evidence lines dropped from the report (baseline step 4). Advisories folded into the same correction as baseline-preserving gaps: user intent in the lens prompt, semantic merge at presentation, malformed replies as failed lens, fallback presentation rules, check-naming scans workflows/. One correction batch sent to the T3 writer.
- L11 T3 correction c3b7fa1 (per-lens status/evidence, optional intent, malformed reply = failed lens, fallback presentation rules, check-naming scans workflows/). Re-verify limited to blockers: 6/6 PASS; focused specs 72/72. Docs fix 1235efe (README names `node odd-claude.mjs`, config dir incl. $CLAUDE_CONFIG_DIR). Unverified: a real Claude Code run of the workflow (Workflow tool args, disableWorkflows, schema enforcement) needs a live `/4r-review` under an installed build. Advisory (pre-existing): check-naming exits 0 silently when run through a symlinked path (/tmp vs /private/tmp).
- L12 T5 measure (before a16beb2 -> after): skill description bytes 4356 -> 4296 (every request); skills/odd/SKILL.md 4575 -> 2162 B; odd-review tool descriptions 4556 -> 3240 B (every session with the MCP); skills/4r-review/SKILL.md 3816 -> 4400 B (body on use only; orchestration moved to workflows/odd-4r-review.js, 5724 B, loaded only when run). Final parent run: `npm test` tests 1475, pass 1473, fail 0, skipped 1, todo 1; `npm run check`: check-naming ok.
