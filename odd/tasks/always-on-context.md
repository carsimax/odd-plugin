# Always-on context: managed CLAUDE.md + rules, neutral output style
Goal: move odd-claude's always-on context (Layer 1 of `docs/claude-code-extensibility.md`) into installer-managed `~/.claude/CLAUDE.md` blocks and `~/.claude/rules/`, port gentle-ai's Claude CLAUDE.md content, and reduce the output style to a unified neutral persona/tone. Branch: `feat/always-on-context`.
Runner: `node:test` via `npm test` inside `plugins/odd-claude` + `npm run check`; installer tests run against temp `HOME`/`CLAUDE_CONFIG_DIR`, never the real `~/.claude`. Upstream references: `upstream/gentle-ai` @ 423d90a, `upstream/gentle-shell` @ d397fab (both pulled 2026-11-26).

## Specs

### S1 Goal (verbatim)
- "Ahora que tenemos fuera el plugin podemos aprovechar mas caracteristicas de claude y mejorar el rendimiento y los costos, me gustaria atacando y aprovechando el Layer 1 - Always-on context de docs/claude-code-extensibility.md"

### S2 Ownership (verbatim)
- "La ide a es que todo lo gestione ~/.claude/CLAUDE.md y ~/.claude/rules/ junto a lo demas que propones"

### S3 Port source (verbatim)
- "la idea es portear el claude.md que inyecta gentle-ai para claude (actualiza el upstream y revisa)"

### S4 Port scope and budget (verbatim answer)
- "Portar contenido completo. Mantener el CLAUDE.md dentro de los 20k tokens y los demas pasarlos a ~/.claude/rules/"
- Budget measure: the odd-claude managed blocks in CLAUDE.md total at most 80,000 bytes (20k tokens at ~4 bytes/token), enforced by a test.
- Rules prefer `paths:` frontmatter when the content is situation-specific (a rule without `paths:` loads at session start like CLAUDE.md and saves nothing).

### S5 Output style role (verbatim answer)
- "Solo persona/tono (Recommended)"

### S6 Neutral output style (verbatim)
- "Y vamos a cambiar el outputstyle de odd a portear el outputstyle de neutral (revisa gentle-shell y gentle-ai para hacer una sola version)"

### S7 "lo demas que propones" (parent proposals the user accepted with S2)
- S7a CLAUDE.md is managed through marker blocks (`<!-- odd-claude:ID -->` ... `<!-- /odd-claude:ID -->`), never touching user text outside them; install, update and uninstall are idempotent; a user-edited block is a conflict, never overwritten silently.
- S7b Bounded read-only subagents (`odd-explore`, `odd-review-*`, `odd-jd-judge-*`) set `omitClaudeMd: true` so they do not pay the always-on CLAUDE.md.
- S7c Situation cards become path-scoped rules where a path trigger exists (e.g. tracking for `odd/tasks/**`).
- S7d Static text leaves the SessionStart/UserPromptSubmit `additionalContext`; hooks keep only per-session dynamic lines (scratch dir, profile, reinjection after compact/resume, peers, language anchor).
- S7e User-only skills get `disable-model-invocation: true`.
- S7f Measure before/after: deterministic always-on byte/token inventory, plus a bench run.

## Decisions
- D1 The output style file keeps the name `odd` (settings `outputStyle: "odd"` stays valid); only its content becomes the unified neutral persona/tone.
- D2 The installer never edits the user's own text in CLAUDE.md; duplicated hand-written sections are reported to the user, not removed.
- D3 Cards: "Rules con paths o lazy (Recommended)": cards with a real path trigger become path-scoped rules (`rules/odd-tracking.md`, `paths: odd/tasks/**`); the rest stay lazy in `~/.odd-claude/current/cards`.
- D4 gentle-ai review lifecycle: "Descartar (Recommended)" (odd-review MCP instructions cover it).
- D5 Parent defaults: drop gentle-ai's "never add Co-Authored-By" bullet; coordinator ON/OFF stays one hook line; odd-worker/odd-verify/odd-jd-fix keep CLAUDE.md; a minimal feature-document layout stays in the always-on `protocol` block because path rules load on read, not on create.

## Tasks
- [x] T1 S3,S4,S7c port map: render gentle-ai's Claude CLAUDE.md (golden/testdata or sandboxed `go run` with temp HOME), inventory every section (bytes, Claude-relevant, SDD/multi-agent residue), and map each to CLAUDE.md block, path-scoped rule (with `paths:`), unscoped rule, or drop, adapted to odd-claude names (cards, agents, MCP tools); merge with our current output style protocol. Route: odd-worker. Commit: docs(research). done when: `docs/research/always-on-context-port-map.md` exists with a per-section table whose CLAUDE.md total is <= 80,000 bytes.
- [x] T2 S2,S7a installer: managed marker blocks in `~/.claude/CLAUDE.md` (create file if absent, ledger hash per block, conflict on edited block, uninstall removes only owned blocks) + `rules/` payload installed as whole files via the existing ledger. Route: odd-worker. Commit: feat(installer). done when: `npm test` covers create/update/unchanged/conflict/uninstall for blocks and rules, and passes.
- [ ] T3 S4,S5,S7c,S7d content: author the CLAUDE.md block sources and `rules/odd-*.md` per T1; protocol leaves the output style; byte-budget test. Depends T1,T2. Route: odd-worker. Commit: feat(context). done when: budget test asserts managed blocks <= 80,000 bytes and passes; every rule with a path trigger has `paths:`.
- [ ] T4 S5,S6 output style: replace `output-styles/odd.md` with one unified neutral persona/tone style from gentle-ai (`internal/assets/claude/output-style-neutral.md`, `persona-neutral-residual.md`) and gentle-shell (`lib/persona-config.ts` and its neutral persona text). Route: odd-worker. Commit: feat(style). done when: style contains no ODD protocol sections and a test/grep check proves it; neutral persona rules (no voseo, tú) present.
- [ ] T5 S7d hooks: SessionStart/UserPromptSubmit drop static text now in CLAUDE.md/rules; keep dynamic lines. Depends T3. Route: odd-worker. Commit: refactor(hooks). done when: hook spec tests updated and `npm test` passes.
- [ ] T6 S7b,S7e agents/skills: `omitClaudeMd: true` on read-only bounded agents; `disable-model-invocation: true` on user-only skills. Route: odd-worker. Commit: feat(agents). done when: `npm run check` and `npm test` pass; frontmatter grep shows the flags.
- [ ] T7 S1 docs: README/docs describe managed CLAUDE.md blocks, rules, the new style and uninstall behavior. Depends T2-T6. Route: odd-worker. Commit: docs. done when: docs mention block markers, rules dir and budget.
- [ ] T8 S7f measure: deterministic before/after inventory of always-on bytes (style + CLAUDE.md blocks + unscoped rules + hook context) and a bench run. Depends T3-T6. Route: inline/odd-worker. done when: numbers recorded in `## Log`.
- [ ] T9 verify (Risk 5: installer, 3: config contract): independent `odd-verify` + sandbox install/update/uninstall smoke with temp HOME. Depends T2-T7. Route: odd-verify. done when: verifier reports pass, or findings fixed.

## Log
- L1 User request: "Ahora que tenemos fuera el plugin podemos aprovechar mas caracteristicas de claude y mejorar el rendimiento y los costos, me gustaria atacando y aprovechando el Layer 1 - Always-on context de docs/claude-code-extensibility.md"
- L2 "La ide a es que todo lo gestione ~/.claude/CLAUDE.md y ~/.claude/rules/ junto a lo demas que propones, y la idea es portear el claude.md que inyecta gentle-ai para claude (actualiza el upstream y revisa)"
- L3 Review evidence: gentle-ai writes marker sections into `~/.claude/CLAUDE.md` (`internal/components/filemerge/section.go`), no `rules/`, tone in an output style; installed Claude CLAUDE.md = 81,488 B (`internal/components/agentguidance/testdata/orchestrator-module-baseline.json`). Current odd-claude always-on: output style 10,672 B + session context ~3 KB.
- L4 Answers: "Portar contenido completo. Mantener el CLAUDE.md dentro de los 20k tokens y los demas pasarlos a ~/.claude/rules/"; output style "Solo persona/tono (Recommended)".
- L5 "Y vamos a cambiar el outputstyle de odd a portear el outputstyle de neutral (revisa gentle-shell y gentle-ai para hacer una sola version)"
- L6 T1 done: `docs/research/always-on-context-port-map.md` (20,248 B). Rendered gentle-ai Claude CLAUDE.md = 81,488 B (matches baseline). Mapping: 8 CLAUDE.md blocks 32,541 B source (<= 80,000), path-scoped rules 21,769 B, dropped 24,430 B, merged duplicates 17,913 B.
- L7 Answers: cards "Rules con paths o lazy (Recommended)"; review lifecycle "Descartar (Recommended)".
- L8 T2 done: `src/installer/claude-md.ts` (+15 specs), files/manifest/payload/plan wired; block id = filename minus `.md` and optional `NN-` prefix; malformed markers => all blocks conflict. Parent spot check `node --test dist-test/installer/*.spec.js`: 205 pass, 0 fail. Test-first deviation: worker wrote the implementation before specs (no clean RED); recorded, not repeated. Follow-up for T3: add `claude-md`/`rules` to `scripts/measure.mjs` and `scripts/check-naming.mjs`.
