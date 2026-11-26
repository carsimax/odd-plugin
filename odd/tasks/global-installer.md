# Global installer: odd-claude without the plugin (TUI + scripts)
Goal: stop shipping odd-claude as a Claude Code plugin; install, update and uninstall it globally (`~/.claude` + `~/.odd-claude`) through a Node + Ink TUI modeled on gentle-ai, with a per-agent model selector. Branch: `feat/global-installer`.
Runner: `node:test` via `npm test` inside `plugins/odd-claude` + `npm run check`; installer tests run against temp `HOME`/`CLAUDE_CONFIG_DIR`, never the real `~/.claude`.

## Specs

### S1 User request (verbatim)
- "quiero quitar la dependencia del plugin"
- "quiero que todo esto se instale por medio de una TUI y scripts para que quede de forma global"
- "Liberarnos del plugin nos va ayudar a otras cosas que necesitamos para funciones futuras."

### S2 Operations (verbatim)
- "La idea es instalar, actualizar, desinstalar."

### S3 TUI reference (verbatim)
- "algo mas parecido a la tui de gentle-ai"
- Reference patterns (exploration of `upstream/gentle-ai`): linear route table of screens (Welcome -> Detection -> Profile -> per-agent models -> Review -> Installing -> Complete), welcome menu (Install, Update, Configure models, Manage backups, Uninstall, Quit), every TUI choice mirrored by a CLI flag, `--dry-run`.

### S4 Model selector (verbatim)
- "Podemos tener tambien el selector de modelos para los agentes (por default los modelos que ya tenemos)"
- Defaults = the current `balanced` preset in `plugins/odd-claude/src/lib/profiles.ts` (explore=haiku, verify=opus, worker=sonnet, jd-fix=sonnet, jd-judge-a=opus, jd-judge-b=sonnet, review-readability/reliability/resilience=sonnet, review-risk=opus). Presets `economy` and `max` stay selectable.

### S5 Decisions (user answers, verbatim)
- Product: "odd-claude completo"
- TUI stack: "Node + Ink"
- Location: "olvida odd-skills too sera sobre odd-claude"
- Updates: "GitHub Releases (Recomendado)"
- TUI distribution: "Bundle esbuild (Recomendado)" (one `odd-claude.mjs` in the release; user needs only Node >= 22, no npm install)
- Names: "Prefijo odd- (Recomendado)" (`/odd-status`, `/odd-profiles`, `/odd-peers`; MCP servers `odd-review`, `odd-peers` -> `mcp__odd-review__*`; agents keep `odd-*`)
- Plugin distribution: "Eliminarla y migrar (Recomendado)" (the TUI detects an installed plugin and offers to uninstall it first to avoid duplicate hooks)
- External deps (Engram, codegraph): "Instalar automático"

### S6 Target layout (design accepted with the decisions above)
```
~/.odd-claude/
  versions/<x.y.z>/          dist/, cards/, agents/, skills/, output-styles/ (release payload)
  current -> versions/x.y.z  update = symlink swap; rollback = swap back
  data/                      state that replaced CLAUDE_PLUGIN_DATA (profiles.json, persona, delegation...)
  manifest.json              installed files in ~/.claude with sha256 (ownership ledger)
  backups/<ts>/              copy of every ~/.claude file before it is changed
~/.claude/
  skills/, agents/, output-styles/odd.md   copied, placeholders resolved to absolute paths
  settings.json              + 9 hooks -> node ~/.odd-claude/current/dist/hooks/run.js <Event>; + outputStyle "odd"
  MCP (user scope)           odd-review, odd-peers, codegraph, engram via `claude mcp add|remove -s user`
```
Rules: a file in `~/.claude` is replaced or removed only when its hash matches the manifest (user-edited or foreign files are reported, never overwritten); uninstall removes exactly the manifest entries, our hook entries and MCP servers, and restores the previous `outputStyle`; downloads verify `checksums.txt`. The repo is private (`carsimax/odd-plugin`), so release download uses `gh` auth.

### S7 Status line and claude.ai sync (user request, verbatim)
- "Aprovechando el instalador podemos portear de /Users/carsimax/Downloads/claude_settings/ el estatus line? y agregale un elemento pequeño indicando la version de odd-claude (ej. v.1.0.0) y portear la deshabilitacion y sincronizacion de claude.ai sync?"
- Source: `statusline-command.sh` (bash + jq: model/effort, context bar with autocompact marker, 5h/7d limits with reset time, repo/branch/+-) and `statusline-settings.json` keys `disableClaudeAiConnectors: true`, `syncClaudeAiSkills: false`, `syncClaudeAiPlugins: false`. Also port the `enabledPlugins` builtin disabling, universal for any account and Claude Code version: no hardcoded list. The installer discovers builtins at install time with `claude plugin list --json` (entries whose `id` ends in `@builtin`; observed fields `id`, `scope`, `enabled`), lists them in the TUI as checkboxes (default: disable all), and never touches entries with `scope: "managed"` nor `cc-plugin-sec-default@builtin` (security guard), nor any non-builtin `enabledPlugins` entry. The 13 names in the source file are only an example (this account lists 6 builtins on the current version). The claude.ai keys (`disableClaudeAiConnectors`, `syncClaudeAiSkills`, `syncClaudeAiPlugins`) are account-independent settings, so they apply the same for everyone. Previous values are backed up and restored on uninstall; flag `--keep-builtin-plugins` skips it, `--disable-builtin <id>` (repeatable) selects a subset non-interactively. If `claude plugin list --json` fails, the step is skipped with a warning (never guessed).
- Design: script installed at `~/.odd-claude/current/statusline.sh`, `statusLine` in `settings.json` points to it; a small dim trailing segment `odd v<version>` read from the installed `current` version (no network); comments translated to English; previous `statusLine` and the three claude.ai keys are backed up and restored on uninstall; claude.ai sync disabling is a TUI option (default on) with flag `--no-claude-ai-sync`, the status line a TUI option (default on) with flag `--no-statusline`.
- User answer (verbatim): "si incluye Desactivar los plugins @builtin"
- User answer (verbatim): "evidentemente claude puede tener los builtin y lo que trae de claude.ai sync puede ser diferente en otras cuenta de claude,hazlo unniversal para que aplique para cualquier persona"
- Decision: the three claude.ai keys are three separate options (connectors, skills, plugins), each default on (= disable), flags `--keep-claude-ai-connectors|skills|plugins`.

### S8 Bench installed arm (user decision, verbatim)
- User answer (verbatim): "T10: brazo 'installed' (Recomendado)" - option text: "en vez de --plugin-dir, el brazo de odd-claude se instala con el instalador en un CLAUDE_CONFIG_DIR aislado. El eval vuelve a medir lo que se distribuye de verdad y CI queda en verde."

## Tasks
Delivery: `ask-on-risk`. Forecast ~3500 authored lines -> chained PRs; slice boundaries recorded per task below.
- [x] T1 (S1, S5) Runtime decoupling: data dir from `ODD_CLAUDE_HOME`/`~/.odd-claude/data` (keep `CLAUDE_PLUGIN_DATA` fallback until T8), plugin root from install layout, version from package.json; rename runtime namespace (`retro.ts` worker match, `/odd-peers` regex in `user-prompt-submit.ts`, profile context line, `mcp__odd-review__` in `stop.ts`/`consent.ts`, `exploration-budget.ts`, peers messages). Route: worker. Commit: `refactor(runtime): ...`
- [x] T2 (S1, S5) Content rename: harness skills to `odd-*` names, `odd-claude:x` -> `x`, `/odd-claude:y` -> `/odd-y`, `mcp__plugin_odd-claude_*` -> `mcp__odd-*`, skills, cards, agents, output style, README; update `scripts/check-naming.mjs`. Route: worker (after T1). Commit: `refactor(content): ...` Placeholders `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` kept; T3 substitutes them at install time.
- [x] T3 (S2, S4, S6) Installer core A: payload staging into `versions/`, placeholder resolution, manifest/ledger with sha256, backups, agent `model:` frontmatter + `profiles.json` from the model selection, install/uninstall of files, dry-run plan. Route: worker. Commit: `feat(installer): ...`
- [x] T4 (S1, S2, S5, S6) Installer core B: `settings.json` hook merge/unmerge and `outputStyle` set/restore with backups, MCP registration via `claude mcp` user scope, plugin detection + `claude plugin uninstall` migration. Route: worker (parallel with T3, disjoint surfaces). Commit: `feat(installer): ...`
- [x] T5 (S2, S5) Update + external deps: GitHub Releases check/download via `gh` with checksum verification, `current` symlink swap and rollback; automatic install of Engram (`brew install gentleman-programming/tap/engram`) and codegraph (method to research) with confirmation, then MCP registration. Route: worker (after T3/T4). Commit: `feat(installer): ...`
- [x] T6 (S2, S3, S4, S5) Ink TUI: screens per S3, model selector per S4, non-interactive flags (`--profile`, `--model <agent>=<model>`, `--dry-run`, `--yes`, `install|update|uninstall`), esbuild bundle to `odd-claude.mjs`. Route: worker (after T3/T4). Commit: `feat(tui): ...`
- [x] T7 (S1, S2, S5) Scripts + release: `scripts/install.sh` bootstrap (checks Node >= 22 and `gh`, downloads bundle + payload, runs the TUI), `.github/workflows/release.yml` (bundle, payload tarball, `checksums.txt` on tag), single version source + bump script. Route: worker. Commit: `ci(release): ...`
- [x] T8 (S5) Remove plugin distribution: delete `.claude-plugin/marketplace.json`, `plugins/odd-claude/.claude-plugin/plugin.json`, plugin-only fallbacks; replace CI `claude plugin validate` with an installer e2e in a temp HOME; README migration guide. Route: worker (last). Commit: `chore!: ...`
- [x] T9 (S7) Status line + claude.ai sync: port `statusline-command.sh` with the `odd v<version>` segment, settings merge/restore for `statusLine`, the three claude.ai keys and the builtin `enabledPlugins` entries, TUI options and flags, tests. Route: worker (after T4, before T6). Commit: `feat(installer): ...`
- [x] T10 (S8) Bench: replace the --plugin-dir odd-claude arm with an installer-based arm in the isolated config dir; fix the 2 test:bench failures from T8. Route: worker. Commit: `refactor(bench): ...`

## Log
- L1 (2026-11-25) User request: "Ahora bien quiero quitar la dependencia del plugin quiero que todo esto se instale por medio de una TUI y scripts para que quede de forma global. La idea es instalar, actualizar, desinstalar. Liberarnos del plugin nos va ayudar a otras cosas que necesitamos para funciones futuras. algo mas parecido a la tui de gentle-ai. Podemos tener tambien el selector de modelos para los agentes (por default los modelos que ya tenemos)"
- L2 (2026-11-25) Exploration: plugin coupling = 9 hooks + 2 MCP via `${CLAUDE_PLUGIN_ROOT}`, ~24 skill and ~17 card lines with plugin vars, `state.ts:26-27` throws without a data dir, 5 runtime files depend on the `odd-claude:` prefix; `dist/` is committed with no runtime npm deps; only `odd-explore` pins `model:`; no release workflow; version hand-edited in 3 files.
- L3 (2026-11-25) User request mid-turn: "Aprovechando el instalador podemos portear de /Users/carsimax/Downloads/claude_settings/ el estatus line? y agregale un elemento pequeño indicando la version de odd-claude (ej. v.1.0.0) y portear la deshabilitacion y sincronizacion de claude.ai sync?"
- L4 (2026-11-25) User: "si incluye Desactivar los plugins @builtin"
- L5 (2026-11-25) User: "evidentemente claude puede tener los builtin y lo que trae de claude.ai sync puede ser diferente en otras cuenta de claude,hazlo unniversal para que aplique para cualquier persona". Evidence: `claude plugin list --json` on this machine lists 6 `@builtin` entries (agents-md, plugin-authoring, privacy, sec-default [managed], telemetry, you-should-know), not the 13 of the source file.
- L6 (2026-11-25) T1 committed 8e69753: npm test 1228 tests, 1226 pass, 0 fail, 1 skipped, 1 todo; check-naming ok.
- L7 (2026-11-26) T2 7af07c1, T3 ceb6cac, T4 6c597a8 merged on feat/global-installer: npm test 1288 tests, 1286 pass, 0 fail; check-naming ok. MCP detection checked against real `claude mcp get` output (exit 1 + `No MCP server named`).
- L8 (2026-11-26) T5 544daff, T9 230ca2e, T7 ca5a573, T6 2edba6d: npm test 1420 tests, 1418 pass, 0 fail; tui 22/22; install.test.sh 40/40; e2e install+uninstall with the real claude CLI in a temp HOME restored settings.json exactly (jq -S).
- L9 (2026-11-26) T8 (partial, T8 left unchecked): plugin manifest, marketplace and `.mcp.json` deleted, version 6.0.0, doctor reports the install, CI and `scripts/tests/installer-e2e.sh` added, READMEs migrated. npm test 1419 tests, 1417 pass, 0 fail (3 plugin-manifest tests removed, 2 added); check-naming ok; tui 22/22; install.test.sh 40/40; `npm run test:e2e` ok. Open: `npm run test:bench` has 2 failures (`a real run without a credential in the environment refuses before spawning anything`, `a full CLI run writes runs.jsonl and report.md`): `bench/src/eval/cli.ts:57` requires `.claude-plugin/plugin.json` and bench is outside T8's edit surface; needs a parent decision.
- L10 (2026-11-26) T8 committed 099a607; test:bench had 2 failures from the plugin.json removal; user chose T10.
- L11 (2026-11-26) T10: coord-on/coord-off install odd-claude per run with `runFullInstall` (source plugins/odd-claude, deps/statusline/migration off, builtin kept, claude.ai default) into the run's CLAUDE_CONFIG_DIR + ODD_CLAUDE_HOME; argv `--setting-sources user`, no `--plugin-dir`; record field `odd_installed` replaces `plugin_staged`. test:bench 239 tests, 239 pass, 0 fail; plugins npm test 1419 tests, 1417 pass, 0 fail, 1 skipped, 1 todo; check-naming ok. docs/eval/README.md still describes --plugin-dir (outside T10 surfaces).
