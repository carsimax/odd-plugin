# odd-claude roadmap

**Goal.** odd-claude is [gentle-shell](../upstream/gentle-shell) ported to a Claude Code plugin (`odd-claude`, commands `/odd-claude:<x>`, agents `odd-*`). The upstream repo is the only source of behaviour. Built from [research/portability-matrix.md](research/portability-matrix.md) (132 rows, IDs `R##` runtime / `A##` asset), [research/open-questions.md](research/open-questions.md) and [research/claude-code-extensibility.md](research/claude-code-extensibility.md) §12. Decisions and naming: [README.md](README.md).

Status: **v2.0.0 reached** for native RDD (faithful core; Phases 1–5, 7 and the RDD part of 8 done; Phase 6 dropped by user decision 2026-11-19; peer orchestrators R07 shipped in 2.1.0; 2.2.0 is the production-readiness release, Node >= 22; 2.3.0 makes balanced the default model profile; 3.0.0 is the simplification release that removes the hooks module and the visual extras; 4.0.0 aligns with upstream v5: the delivery check only warns; 5.0.0 is the refinement round: agent escalation removed, the tier is decided by assess alone, prompts and hooks simplified; 5.1.0 hardens the rules (completion gate, test-first excuse table, claim-free verifier handoff, never-weaken rule) and adds the systematic-debugging and receiving-review skills (branches feat/harden-rules, feat/debug-feedback); 5.2.0 adds the session retro skill with a local transcript digest CLI and pressure testing in skill-creator and skill-improver (branch feat/retro-pressure); 5.3.0 adds done-when per task with a feature-document lint CLI, odd-verify calibration, concise review_status and the AI-leaders harness research doc (branch feat/harness-research)). Phase contents follow the matrix "Candidate phases" with the adjustments listed under [Deviations](#deviations-from-the-matrix-candidate-phases).

## Guiding principles

1. **Critical behaviour works with classic hooks.** The ODD prompt and every guard rely on SessionStart / UserPromptSubmit `additionalContext` and PreToolUse / Stop hooks, never on mods.
2. **Mods were an optional enhancement layer (removed in the simplification pass, `odd/tasks/simplify.md`: the `hooks/register.ts` mod, `agent.spawn` routing and the `agents`, `changes` and `quiet` commands no longer exist; history below is kept as it was).** The plugin is fully functional if `modules` is not loaded (flag-gated; per spike Q1 it loads interactively and in `-p` on v2.1.326, and panes, commands and tools work, but `prompt.compose/section/context` are blocked for third-party mods by `cc-plugin-sec-default`, so no behaviour may rely on mod prompt injection). Each mod feature has a documented non-mod fallback.
3. **Settings-only items go through an opt-in `/odd-claude:setup`** (status line, `defaultMode`, output-style selection, env): it shows the proposed change and writes only with consent. Plugins cannot write settings.
4. **Naming is `odd`** everywhere (plugin `odd-claude`, `odd_*` tools, `ODD_*` env, `<odd-…>` tags). Never `gentle-`.
5. **No telemetry** of any kind (R37, A49 excluded by decision).
6. **Port pure-TS logic from upstream as-is** where possible (guards, admission, JD validation); change only input extraction and tool names. Upstream tests are the behavioural spec (A58).
7. **Upstream-only sourcing**; no other project is used as input.

---

## Phase 0: Gates (open questions)

Spikes and decisions from [open-questions.md](research/open-questions.md). Each is small (S) unless noted; results go back into that file. Spike results (2026-11-18, Claude Code 2.1.326) are in [open-questions.md Findings](research/open-questions.md#findings); Q4 and Q5 were decided by the user on 2026-11-18.

| Q | Question | Type | Blocks |
|---|---|---|---|
| Q1 | Are mods enabled on this account/build? **Answered**: mods load interactively and in `-p`; panes (`ui.open` + `ui.render`), commands and `$.tool.register` work; `prompt.compose/section/context` are NOT available to third-party mods (blocked by `cc-plugin-sec-default`) | spike | Phase 5 (panes, tools, commands only); no `prompt.compose` path exists for R01/R02 |
| Q2 | Does output style `force-for-plugin` apply the persona without `/setup`? **Yes**: persona ships via forced output style | spike | Phase 1 `/odd-claude:setup` scope; Phase 2 R01 delivery choice (output style vs SessionStart injection) |
| Q3 | Do plugin hooks run in subagents and expose `agent_type`? What happens to ignored plugin-agent frontmatter? **Yes**: hooks fire in subagents with `agent_type` `<plugin>:<agent>`; ignored fields only warn in the debug log | spike | Phase 3 (R23, R26, R27, R28, A15, R25 bypass behaviour); Phase 2 A02/A05/A06 read-only claims and R10; Phase 4 reviewer isolation |
| Q4 | RDD: reuse the Go review binary, reimplement, or ship v1 without native review? **Decided 2026-11-18: "v1 sin RDD nativo; review con agentes"** (native RDD → v2; v1 is option C with agent-based review, see below) | **user decision** | Phase 4 shaped as advisory agent review; native RDD items moved to Phase 8 |
| Q5 | Inter-session messaging: `$.store` (mods) vs MCP channels (preview)? **Decided 2026-11-18: inter-session messaging → v2** | **user decision** | Phase 8 / v2 (R07); nothing else |
| Q6 | How are plugin MCP tools (engram, codegraph) named and granted in plugin agent `tools:`? **Yes**: `mcp__plugin_<plugin>_<server>__<tool>` in `tools:` | spike | Phase 1 doctor/engram dependency; Phase 2 agents A01–A06, R13; Phase 8 / v2 review MCP (R29) |
| Q7 | Exact mod types for this build (generated `.d.ts`)? **Answered**: types written to `<plugin>/.claude-plugin/types/` on the first interactive `--plugin-dir` load | spike (only if Q1 = yes) | Phase 5; any mod path |

### Q4: decided (2026-11-18)

User answer: "v1 sin RDD nativo; review con agentes (Recomendado)". The four lenses (`odd-review-risk`, `odd-review-resilience`, `odd-review-readability`, `odd-review-reliability`) and Judgment Day ship as agents + skills, **advisory**, with no external binary and no native lineage/consent/capture tools. Native RDD → **v2**. Options considered: A reuse the upstream Go review binary behind MCP (R29); B reimplement in TS (`lib/review-*.ts`); C v1 without native review. The decision is C, with the review done by agents. Native-RDD-only items are v2 scope (Phase 8).

### Q5: decided (2026-11-18)

User answer: "Fuera de v1 (Recomendado)". Inter-session orchestrator messaging (R07) → **v2**; neither `$.store` nor MCP channels is built in v1.

Exit criteria for Phase 0: every spike has a written result in `open-questions.md` (status closed + evidence; all seven answered); Q4 and Q5 have an explicit user decision recorded (done, 2026-11-18).

---

## Phases

Effort = count of matrix S/M/L items (S ≤ 1 day, M ≈ days, L ≈ weeks/spike) computed from the matrix; "–" rows have no effort. Per-phase effort excludes the shared skeleton work that has no matrix row (manifest, hooks scaffolding, `/odd-claude:setup`), which is noted where it applies.

### Phase 1: Skeleton, setup, doctor, engram dependency

- **Goal:** an installable `odd-claude` plugin that loads, declares Engram, and can diagnose and configure itself.
- **Matrix IDs:** R38
- **Deliverables:** `.claude-plugin/plugin.json` (+ marketplace entry), `dependencies` on `engram@engram`, `${CLAUDE_PLUGIN_ROOT}` layout (`cards/`, `agents/`, `skills/`, `hooks/`, `bin/`), `/odd-claude:doctor`, `/odd-claude:status` (R38), `/odd-claude:setup` (opt-in settings writer: statusLine, `defaultMode`; the persona does not need it: forced output style per Q2), hooks scaffolding with shared state-file helper.
- **Dependencies / gates:** Q2 (answered), Q6 (answered).
- **Exit criteria:** `claude plugin validate` passes; `claude plugin test` passes; `/odd-claude:doctor` reports engram/codegraph/git presence and exits with the missing items listed; `/odd-claude:setup` shows a diff and writes nothing without confirmation (tested with a declined run and an accepted run on a temp settings file).
- **Effort:** 1 M (R38) + skeleton/setup work with no matrix row (~M).
- **Risk:** low. `setup` writes user settings: must be idempotent and reversible; keep write scope to listed keys.

### Phase 2: Core declarative layer

- **Goal:** the ODD workflow as text/config: prompt, cards, agents, skills, native-tool mappings. No enforcement code.
- **Matrix IDs:** R01, R02, R05, R06, R10, R11, R12, R13, R15, R16, R50, R53, R72, A01, A02, A03, A04, A05, A06, A12, A13, A14, A17, A18, A19, A20, A21, A22, A23, A24, A26, A30, A31, A32, A33, A35, A36, A37, A38, A41, A42, A43, A44, A45, A46, A54
- **Deliverables:** persona via a forced output style `odd` with `force-for-plugin: true` (R01, verified in Q2; no `/setup` needed) plus SessionStart/UserPromptSubmit `additionalContext` for the rest of the prompt text (R01, R02); never mod `prompt.compose/section/context`, blocked for third-party mods (Q1). Mods are used only for panes, tools and commands UX (Phase 5); `/odd-claude:persona` (R02); reply-language anchor (R72); `cards/*.md` (A12–A14, A17–A23) with tool names rewritten (`subagent_run` → `Agent`, `todo` → TodoWrite) and the "Pi Runtime Overlays" section rewritten (A14); agents `odd-explore`, `odd-verify`, `odd-worker`, `odd-jd-fix`, `odd-jd-judge-a`, `odd-jd-judge-b` (A01–A06); skills under `odd-claude:` (branch-pr, chained-pr, cognitive-doc-design, comment-writer, `odd`, ui-design, issue-creation, judgment-day, skill-creator, skill-improver, skill-registry, tui-design, work-unit-commits); `/odd-claude:skill-creation` (A46); `support/test-first*.md` (A24); `odd/tasks/<feature>.md` format (A54); codegraph MCP + SessionStart warm-up (R13); `/odd-claude:background-subagents` (R12); `/odd-claude:skill-registry` + hook `odd-skill-registry` (R53); `assets/sounds/` (A26).
- **Dependencies / gates:** Phase 1; Q2 (R01), Q6 (agent tool allowlists), Q3 (read-only agent claims; R10 behaviour).
- **Exit criteria:** `claude plugin validate` passes; a fresh session shows the ODD persona (observed in system prompt/behaviour); every skill and agent lists with the `odd-claude:` namespace; grep over shipped files finds no `gentle` string other than attributed notices (A44 `NOTICE.md`, A26 `LICENSE.md`); each `odd-*` agent runs a smoke task using the engram/codegraph MCP names confirmed in Q6; a documented fallback exists if a subagent cannot ask questions (R10).
- **Effort:** 42 S + 4 M (R01, R05, A12, A14).
- **Risk:** medium-low; volume rather than difficulty. Watch rewrite drift in cards (A12, A14) and the overlap between A12 and A35.

### Phase 3: Coordinator, advisory budget and permission modes (no deny hooks)

Originally "Guards" (enforcement through deny/ask hooks). Superseded by user decision S6 (2026-11-18, `odd/tasks/v0-5-guards.md`): the plugin ships **no** hook that returns deny, ask or block; protection relies on Claude Code native permissions. The original goal and exit criteria are kept in the feature doc (S1) as the historical record.

- **Goal:** coordinator mode and admission as prompt rules, advisory exploration budget and context backstop, and the permission-mode mapping through setup. No enforcement hooks.
- **Matrix IDs:** R14, R20, R21, R22, R23, R24, R25, R26, R27, R28, R34, A15, A16, A58
- **Dropped by user decision 2026-11-18 (IDs kept in place, not deleted):** R21 (bash guard), R22 (path guard), R23 (child guard), R26 (writer admission), R27 (verifier admission), R28 (JD dispatch hook + digest helper). Admission and JD dispatch stay as text in cards and the judgment-day skill; they are never enforced.
- **Deliverables (as shipped):** coordinator mode (A15, A16) as a prompt mode ON by default, stored in plugin state and stated in the SessionStart context, `/odd-claude:coordinator on|off|status`; `odd-explore-budget` (R14) and `odd-context-backstop` (R34) as advisory PostToolUse `additionalContext`; permission-mode mapping to native `default`/`acceptEdits`/`auto`/`plan`/`bypassPermissions` with `defaultMode` through setup, with an explicit `bypassPermissions` warning (R20, R24, R25); tests in the Node test runner (A58).
- **Dependencies / gates:** Phase 2 (agent names), Q3 (hooks fire in subagents, and under `bypassPermissions`).
- **Exit criteria (as amended by S6):** `npm test`, `npm run check` and `claude plugin validate` pass; no `permissionDecision`/`"deny"`/block output in plugin source, dist or hooks; no Stop hook is registered, so hooks cannot loop; a fresh session states coordinator ON and a destructive command in a temp dir is not blocked by odd-claude; `claude plugin test` reports "no hooks module" (the plugin ships no mods).
- **Effort:** 3 S + 3 M (R14, R20, R34, A15, A16, A58 and the setup mapping).
- **Risk:** medium. No enforcement exists by decision: `bypassPermissions` removes every prompt and nothing in odd-claude catches a destructive or sensitive action. The setup dry run says so explicitly.

### Phase 4: Advisory review (agent-based)

- **Goal:** v1 independent review with agents and skills, advisory only, as decided in Q4: the four lenses plus Judgment Day. No external binary and no native lineage/consent/capture tools.
- **Matrix IDs:** A07, A08, A09, A10, A11
- **Deliverables:** agents `odd-review-risk`, `odd-review-resilience`, `odd-review-readability`, `odd-review-reliability` (A07–A10) with `Read, Grep, Glob` and the candidate change passed in the prompt (no `odd_review_scope`); `4r-review` command/skill (A11) that launches the four lenses via `Agent` and merges their findings into one advisory report; Judgment Day agents and skill come from Phase 2 and guard dispatch from Phase 3 (A01–A06, R28); the review output states it is advisory and gates nothing.
- **Dependencies / gates:** Phases 1–3; Q3 (answered; reviewers are isolated subagents), Q6 (answered).
- **Exit criteria:** `4r-review` on a sample change runs four reviewers and returns a merged advisory report; each lens agent lists under `odd-claude:`; reviewers cannot write (`tools` allowlist excludes Edit/Write, verified by a guard test); a Judgment Day round still runs on the same sample; no external binary or `odd_review*` tool is referenced by any shipped file.
- **Effort:** 5 S.
- **Risk:** low-medium. Advisory only: no approval state, no publication gating, no contract parity with upstream native RDD (native RDD is v2, Phase 8).

### Phase 5: Mods UX (optional)

- **Status:** done (v1.1, branch feat/v1.1-mods); **the mod, `agent.spawn` routing and the `/odd-claude:agents`, `/odd-claude:changes` and `/odd-claude:quiet` commands were later removed in the simplification pass (`odd/tasks/simplify.md`)**. R42 (tokens/s) and R44 (statusLine) shipped through the setup statusline subcommand, since removed together with the banner and the themes (simplification pass); the `$.ui.status` mod variant was never shipped.
- **Goal:** richer UI where mods are available, with the non-mod fallback already shipped in earlier phases.
- **Matrix IDs:** R09, R36, R39, R40, R42, R44, R45, R46, R51
- **Deliverables:** `/odd-claude:agents` (R09, text fallback first, pane via mod), `/odd-claude:stats` (R36, local only), `/odd-claude:profiles` (R39), dynamic per-spawn model routing via `agent.spawn` with static frontmatter `model`/`effort` as base (R40), statusLine script `odd-status` (R44, R42 TPS segment), startup banner (R45), `/odd-claude:changes` (R46), tool-render tweaks (R51).
- **Dependencies / gates:** Phase 2; Q1 (mods available), Q7 (types). Each item ships its non-mod version (command or statusLine via setup) regardless of Q1.
- **Exit criteria:** with mods enabled, each mod feature appears (pane/status/tool); with `modules` not loaded and in `-p`, the plugin loads without errors and the fallback commands work; no mod is referenced by any Phase 1–3 behaviour.
- **Effort:** 5 S + 4 M (R09, R36, R44, R39).
- **Risk:** medium: preview/gated API may change between Claude Code versions; types are per-version. R42 needs token/time data in the statusLine payload (verify).

### Phase 6: Web tools (dropped by user decision 2026-11-19)

- **Status:** **dropped by user decision 2026-11-19**; nothing ported and v1.2 is not released. Reason: Claude Code's own Artifact tool and built-in design/chart features cover the need, and the Tower web UI is not wanted. User answers (verbatim): Tower → "No incluirlo"; design tools → "Esto necesario?, claude ya tiene sus herramiento de diseño"; scope → "Cerrar la fase sin portar nada".
- **Matrix IDs:** none (the six former IDs moved to [Out of scope](#out-of-scope): R17, R18, R19, A28, A34, A52).
- **Original goal (historical):** local design canvas and Tower web servers (`/odd-claude:guide`, `/odd-claude:design` with `odd_design`/`odd_design_comments`, `/odd-claude:tower`, `assets/design-canvas/`, `web/tower/`).

### Phase 7: Cosmetic and small items

- **Goal:** low-value, low-effort extras.
- **Matrix IDs:** R35, R54, R56, R57 (dropped by user decision 2026-11-18), R62, R63 (dropped by user decision 2026-11-18), R64, R70, A50
- **Status:** done (v1.0, branch feat/v1.0-polish). R57 and R63 were not implemented.
- **Deliverables:** `--fallback-model` guidance + hook `odd-stop-failure` (R35, same-provider only); themes `odd-*` (R54, A50; later removed in the simplification pass, `odd/tasks/simplify.md`); `/odd-claude:scratch` + hooks (R56); ~~notification/audio hooks reusing A26 WAVs (R57; `$.audio` mod variant optional)~~ dropped by user decision 2026-11-18; terminal-title hook (R62); ~~star prompt (R63)~~ dropped by user decision 2026-11-18; resume hint (R64); agent status file hooks (R70).
- **Dependencies / gates:** Phase 1; A26 from Phase 2; Q1 only for the optional audio mod.
- **Exit criteria:** each hook runs without output errors on macOS (and is a no-op where `afplay`/`paplay` is missing); themes load in `claude plugin validate`; scratch dir is created at SessionStart and removed at SessionEnd.
- **Effort:** 8 S + 1 M (R35).
- **Risk:** low. R35 cross-provider fallback is not possible (Anthropic models only). R63 is outward-facing; needs an explicit keep/drop decision.

### Phase 8: v2, native RDD + peer orchestrators

- **Status:** **RDD shipped in v2.0.0 (faithful core, branch feat/v2-rdd; feature doc `odd/tasks/v2-rdd.md`)**; peer orchestrators (R07) are **shipped in 2.1.0 (branch release/2.1.0; feature doc `odd/tasks/r07-peers.md`)**: file mailbox + hooks, no mods (the earlier `$.store` plan was superseded by user decision 2026-11-21, S3). Tools `odd_orchestrator_session_id`, `odd_orchestrator_list`, `odd_orchestrator_send_message`; consent by `/odd-claude:peers allow <id>` typed by the human; delivery on the next prompt / SessionStart; limits and the shell-access limit are in the plugin README.
  - **Shipped:** the native review engine (state machine, atomic authority store with revision CAS, directory lock, git snapshots, risk classification, consent, capture, correction, acknowledge/burn with receipts), isolated `claude -p` reviewers, the review MCP server (final tool names `review_*`, not `odd_review*`: the plugin guard forbids that literal in shipped files), the RDD mode switch CLI (`review-mode.js`, off by default), the Stop settle reminder and the `git push` / `gh pr` delivery gate. Scoped exception to the no-deny rule: only those two can block, only with RDD on (S3).
  - **Deferred (not in 2.0.0):** store maintenance (recover, reclaim, quarantine, legacy); consolidating the duplicated helpers in `status.ts`; the slash commands and skills of the original deliverables (`/odd-claude:rdd`, `/odd-claude:review-session-permission`, `provider-defect-report`, `rdd-defect-workflow`), none of which was needed for the core.
  - **R07 deferred:** push delivery to a live idle session (R08 sockets and presence registry, not ported), more tools beyond the core three, Windows, end-to-end verification of `/clear` and of an idle interactive session.
  - **Known residuals (documented, see the plugin README):** a lineage directory abandoned by a crash in the middle of START is inert and is swept by the next START (bounded, see the plugin README); dead lock directories are reclaimed only on the next mutation; a complete lock-claim guarantee needs a no-replace rename that Node does not expose; the delivery gate is lexical (aliases and scripts are not recognized).
  - **Update (upstream v5, `odd/tasks/upstream-v5.md` S2):** the delivery gate no longer blocks `git push` / `gh pr`: with RDD on and an unreviewed candidate it shows one advisory notice and the command always runs; only the Stop settle reminder can block. The "gate blocking" exit criterion below and the lexical-gate residual above describe the 2.0.0 behaviour.
- **Goal:** the explicit **v2** milestone: the portable items deliberately left out of v1 (native RDD and inter-session peers), planned for after v1 ships. These are the only v2 scope.
- **Matrix IDs:** R03, R07, R29, R30, R31, R32, R33, R74, A39, A40, A47, A48
- **Deliverables:** (native RDD, v2; Q4 option A or B reopened when v2 starts) MCP server with `odd_review`, `odd_review_run`, `odd_review_capture`, `odd_review_capture_group`, `odd_review_scope`, `odd_phase` (R29), candidate views (R33), request-context placement (R74), contract fragment injection (R03), `contracts/review-integration/` and `contracts/provider-mirror/` (A47, A48), `/odd-claude:rdd`, `/odd-claude:review-mode`, `/odd-claude:review-session-permission` (R30), Stop hook `odd-settle-nudge` (R31), publication gate tied to review approval `odd-delivery-gate` (R32), skills `provider-defect-report`, `rdd-defect-workflow` (A39, A40). (Peers, shipped in 2.1.0) `odd_orchestrator_*` tools over a file mailbox + hooks (R07; `$.store` dropped, S3).
- **Dependencies / gates:** v1 shipped; at v2 start, a decision on the review engine (Q4 option A or B) and on the peer channel (`$.store` vs MCP channels, Q5), Q1 if `$.store`.
- **Exit criteria:** per item when promoted: a full native review run (scope → four reviewers → capture → verdict), delivery gate blocking `git push` / `gh pr` on a failing preflight, contract schema validation; two sessions exchange a message with a grant before delivery; or the item is formally dropped (moved to out of scope).
- **Effort:** 3 S (R74, A39, A40) + 6 M (R03, R30, R31, R32, A47, A48) + 3 L (R07, R29, R33).
- **Risk:** high: external binary or the largest TS port (contracts, drift), and a preview channel for peers. Not part of the v1 parity claim (v2 scope).

### Deviations from the matrix candidate phases

- Matrix group 0 splits into Phase 0 (gates) and Phase 1 (skeleton).
- A15 and A16 are both in Phase 3 (A16 is generated from A15; the matrix lists A15 in guards and A16 in core).
- A34 (skill `design`) was moved to Phase 6 (unusable without R18) and is now out of scope with Phase 6 (2026-11-19); A39 and A40 move from the matrix review group to Phase 8 (they need the review binary / native RDD). Per Q4 the matrix review group is split: A07–A11 form the v1 advisory Phase 4; R03, R29–R33, R74, A39, A40, A47, A48 go to Phase 8 (v2) with R07.
- Unassigned in the matrix and placed here: A58 (tests) in Phase 3 because it is the spec for the guards; R10 in Phase 2; R07 in Phase 8 / v2 (Q5); R55 out of scope (native history covers it).
- R15 stays in Phase 2 (native TodoWrite; sidebar is a Phase 5 mod add-on). R57 is in Phase 7 only. R39/R40 are in Phase 5; static `model`/`effort` frontmatter ships with the Phase 2 agents.

---

## Milestones and releases

| Version | Contents | Phases | Notes |
|---|---|---|---|
| v0.1 | Installable skeleton: loads, engram dependency, `doctor`, `status`, `setup` | 0 + 1 | `claude plugin validate`/`test` green |
| v0.2 | ODD core: persona, cards, agents, skills | 2 | usable without enforcement |
| v0.5 | ODD core + coordinator mode (prompt) + advisory budget + permission-mode mapping | 2 + 3 | no deny hooks by user decision (S6); makes no safety claims, protection relies on Claude Code native permissions; independent verification of the delivered units |
| v0.8 | Advisory review: four lenses + Judgment Day as agents and skills | 4 | per Q4; no native RDD, no external binary |
| v1.0 | Parity target (below) | 1–4 + 7 | reached (branch feat/v1.0-polish); R57 and R63 dropped by user decision 2026-11-18 |
| v1.1 | Mods UX | 5 | reached (branch feat/v1.1-mods); R42 and R44 shipped via setup; mod, banner, themes, statusline and agents/changes/quiet later removed (simplification) |
| v2 | Native RDD + peer orchestrators: R03, R07, R29, R30, R31, R32, R33, R74, A39, A40, A47, A48 | 8 | native RDD **shipped as 2.0.0** (faithful core, TypeScript, "camino B"); R07 peers **shipped in 2.1.0** (file mailbox + hooks; `$.store` superseded) |

**What "parity" means for v1.0.** Every matrix item with a 🟡 or ✅ verdict in Phases 1–4 and 7 is delivered or has a documented native equivalent, so that an ODD session (prompt, delegation, writer/verifier rules, guards, Judgment Day, advisory four-lens review) behaves as in gentle-shell for the same user task. Parity is **not** pixel/TUI parity: the 29 ❌ matrix rows and the extra out-of-scope entries below (Pi-host rendering, launcher/installer, providers, keybindings, desktop/herdr, voice/music, telemetry) are excluded, Pi-specific pieces are replaced by native Claude Code tools, and cross-provider model fallback is impossible. Mod-only UX (Phase 5) is extended parity shipped after 1.0; web tools (Phase 6) were dropped on 2026-11-19. Per the Q4 decision, v1.0 parity covers the **advisory** agent-based review only: native RDD (`odd_review*` tools, contract mirror, candidate views, review-approval publication gate, lineage/consent/capture) and inter-session peers (R07) are **v2 scope** (Phase 8: R03, R07, R29, R30, R31, R32, R33, R74, A39, A40, A47, A48) and excluded from the v1 parity claim; the release notes say so.

---

## Out of scope

Excluded rows (every other matrix ID is in a phase above, v2 included). Out-of-scope items are not v2 candidates unless explicitly revisited. Mostly matrix ❌; R55 is 🟡 in the matrix but needs nothing shipped.

| ID | Reason |
|---|---|
| R04 | Not needed: subagents have isolated context natively |
| R08 | Subsumed by R07's mechanism; Pi-process sockets not needed |
| R17 | Dropped by user decision 2026-11-19 (Phase 6): Claude Code's own Artifact tool and built-in design/chart features cover the need |
| R18 | Dropped by user decision 2026-11-19 (Phase 6): design canvas tools not needed, Claude Code has its own design tools |
| R19 | Dropped by user decision 2026-11-19 (Phase 6): Tower web UI not wanted ("No incluirlo") |
| R37 | Telemetry: excluded by decision |
| R41 | OpenAI-specific; Claude Code has its own `/fast` |
| R43 | Plugins cannot register providers |
| R47 | Native image paste/attach |
| R48 | Native `/` menu replaces the palette (an `/odd-claude:commands` help list may be added ad hoc) |
| R49 | Native vim mode; plugins cannot ship keybindings |
| R52 | No equivalent concept (codemode/hidden tools) |
| R55 | Native history covers it; nothing to ship |
| R58 | Native voice exists; custom STT worker not shippable |
| R59 | Needs TUI control to hand the terminal to an external program |
| R60 | Separate desktop app built around Pi RPC |
| R61 | herdr hosts Pi sessions |
| R65 | Pi npm dependency |
| R66 | Replaced by marketplace install |
| R67 | Replaced by marketplace + plugin `dependencies` |
| R68 | Marketplace update/uninstall |
| R69 | Pi-host rendering concerns |
| R71 | Tied to desktop/herdr (R60/R61) |
| R73 | Plugin files are versioned by the marketplace; no user-edited copies |
| A25 | Not needed (see R73) |
| A27 | Marketplace replaces the installer |
| A28 | Dropped by user decision 2026-11-19 (Phase 6): design canvas assets not needed (R18 dropped) |
| A29 | Logo excluded by naming decision and upstream `TRADEMARKS.md`; a new odd-claude icon is a separate branding task |
| A49 | Telemetry contract: excluded by decision |
| A34 | Dropped by user decision 2026-11-19 (Phase 6): skill `design` unusable without R18; Claude Code has its own design tools |
| A51 | herdr-specific (its "mods" are herdr JS, not Claude Code mods) |
| A52 | Dropped by user decision 2026-11-19 (Phase 6): Tower web UI not wanted (R19) |
| A53 | Upstream design history, not product |
| A55 | Upstream docs: source material only |
| A56 | Pi-package build/CI scripts; `prepare-verifier.mjs` and `check-provider-contract.mjs` may be copied case by case inside Phases 3/4 |
| A57 | Generated Pi runtime mirror; odd-claude chooses its own build output |

---

## Delivery conventions

- **Feature docs:** one per feature at `odd/tasks/<feature>.md` in the A54 format (header, `## Specs` `S#`, `## Tasks` `T#`, `## Delivery`, `## Risks`, `## Log` `L#`). Upstream's 230 task docs are not copied.
- **Work-unit commits:** one reviewable unit per commit, about 400 lines of change at most, with its tests and docs together (skill `work-unit-commits`).
- **Tests with behaviour:** behaviour changes ship with tests written first where a deterministic runner applies; guards reuse upstream tests adapted to Node (A58). Docs-only changes state the exception.
- **Checks on every change:** `claude plugin validate` and `claude plugin test` must pass, plus the focused tests of the touched unit.
- **Naming and telemetry checks:** no `gentle-` identifiers we name (attributed notices excepted) and no telemetry code, enforced by grep in checks.
- **Spikes:** results written to `docs/research/open-questions.md` with evidence before dependent work starts.
- **High-risk phase (3):** independent verification per unit; guards fail safe. Phase 4 is advisory and low-medium risk.

## Status

| Phase | Name | Blocked by | Version | Status |
|---|---|---|---|---|
| 0 | Gates | – | – | Q1, Q2, Q3, Q6, Q7 answered; Q4, Q5 decided (2026-11-18) |
| 1 | Skeleton, setup, doctor, engram | Q2, Q6 | v0.1 | done (v0.1, branch feat/v0.1-skeleton) |
| 2 | Core declarative layer | Phase 1; Q2, Q3, Q6 | v0.2 | done (v0.2, branch feat/v0.2-core) |
| 3 | Coordinator, advisory budget, permission modes (no deny hooks) | Phase 2; Q3 | v0.5 | done (v0.5, branch feat/v0.5-guards) |
| 4 | Advisory review (agents) | Phases 1–3 | v0.8 | done (v0.8, branch feat/v0.8-review) |
| 5 | Mods UX (optional) | Phase 2; Q1, Q7 | v1.1 | done (v1.1, branch feat/v1.1-mods); R42 TPS and R44 statusLine shipped via setup; mod, banner, themes, statusline and agents/changes/quiet later removed (simplification) |
| 6 | Web tools | – | – | dropped by user decision 2026-11-19 (Claude Code's own Artifact tool and built-in design/chart features cover the need; Tower not wanted); v1.2 not released |
| 7 | Cosmetic and small | Phase 1 | v1.0 | done (v1.0, branch feat/v1.0-polish); R57, R63 dropped by user decision 2026-11-18 |
| 8 | v2: native RDD + peer orchestrators | v1 shipped | v2 | RDD done (v2.0.0, branch feat/v2-rdd, faithful core); peers (R07) shipped in 2.1.0; production readiness shipped in 2.2.0 (Node >= 22, branch release/2.2.0); balanced default profile, per-role RDD reviewer models, parallel haiku explorers and a single neutral persona shipped in 2.3.0 (branch feat/balanced-profile); simplification (hooks module, banner, themes, statusline, agents/changes/quiet removed) shipped in 3.0.0 (branch feat/simplify); upstream v5 alignment (warn-only delivery check, escalation object, verifier skips sensitive files, JD ID grammar and hash preimage, skill reference fix) shipped in 4.0.0 (branch feat/upstream-v5); refinement round (agent escalation removed, one source per prompt rule, lighter hooks, lens charter in engine reviewers, shared pid probe, `skill-creation` removed) shipped in 5.0.0 (branch feat/refine-v5); 5.1.0 hardens the rules (completion gate, test-first excuse table, claim-free verifier handoff, never-weaken rule) and adds the systematic-debugging and receiving-review skills (branches feat/harden-rules, feat/debug-feedback); 5.2.0 adds the session retro skill with a local transcript digest CLI and pressure testing in skill-creator and skill-improver (branch feat/retro-pressure); 5.3.0 adds done-when per task with a feature-document lint CLI, odd-verify calibration, concise review_status and the AI-leaders harness research doc (branch feat/harness-research) |
