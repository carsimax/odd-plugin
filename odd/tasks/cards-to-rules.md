# Cards to rules: fuse orchestrator cards into always-on ~/.claude/rules/
Goal: remove the lazy `cards/` payload; its content becomes fused, de-duplicated always-on rules installed under `~/.claude/rules/`. Branch: `feat/cards-to-rules`. Delivery: work-unit commits on the branch by the parent; push/PR are the user's decision.
Runner: `npm test` and `npm run check` inside `plugins/odd-claude`; installer tests run against temp `HOME`/`CLAUDE_CONFIG_DIR`, never the real `~/.claude`.

## Specs

### S1 Goal (verbatim)
- "Todas las cards deberian a pasar ser  ~/.claude/rules/"

### S2 Loading mode (verbatim answer)
- "Siempre cargadas, fusionadas (Recomendado)"
- Option text the user chose: "Pasan a rules/ sin `paths:`, pero se fusionan y recortan los duplicados con CLAUDE.md antes, para que el costo always-on sea bastante menor que 11k tokens. Se elimina la indirección 'lee la card X'."

### S3 Budget (parent-derived from S2)
- The card-derived rule files (no `paths:` frontmatter) total at most 24,000 bytes, enforced by a test. Today the 9 cards total ~45 KB.
- Provenance (`cards/SOURCES.md`) must NOT be installed under `~/.claude/rules/` (it would load every session); it moves to a non-loaded location.

### S4 Non-goal (verbatim)
- "renombrar a src/ sera despues pero anotalo" — renaming `plugins/odd-claude/` is out of scope (noted in memory as backlog).

## Tasks
- T1 [S1-S3] route: delegated (Coordinator ON) — fuse cards into `rules/` files without `paths:`, drop content duplicated in `claude-md/`, move provenance, replace every "read the card"/`cards/...` reference (claude-md, skills, README, scripts, content tests); add the S3 budget test. commit: - . done when: `plugins/odd-claude/cards/` no longer exists, budget test passes, `grep -rn "cards/" claude-md skills rules README.md` has no live card references.
- T2 [S1] route: delegated (Coordinator ON) — runtime/installer: drop `cards` from `PAYLOAD_ITEMS`, remove `cardsDir`/`resolveCardsDir` from session context (the Coordinator ON line points to the installed rule instead), fix `quota.ts` guidance text, update specs/testkits. commit: - . done when: `npm test` and `npm run check` pass and a temp-HOME install produces the new rule files under `rules/` and no `cards` dir in the version payload.
- T3 [S1-S3] route: parent + odd-verify (Risk item 3/5: installed layout and installer payload) — independent verification. commit: n/a. done when: verifier verdict per S#.

## Log
- L1 (user, verbatim): "Todas las cards deberian a pasar ser  ~/.claude/rules/ renombrar a src/ sera despues pero anotalo"
- L2 (user answer, verbatim): "Siempre cargadas, fusionadas (Recomendado)"
- L3 (parent): Context: in Claude Code, a `~/.claude/rules/*.md` file without `paths:` frontmatter loads at session start like CLAUDE.md; cards had no repo path to scope them to.
