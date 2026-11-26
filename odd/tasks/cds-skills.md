# cds-skills: lite port of odd-claude (Claude Development System)
Objective: a `cds-skills/` folder at the repo root holding a lite, curl-installable port of odd-claude (skills, agents, CLAUDE.md + rules, output style) with no deterministic code at runtime. Branch: `feat/cds-skills` (base `8f5946b`), worktree `/Users/carsimax/Developer/03-PERSONAL/odd-claude-cds-skills`. Delivery: `ask-on-risk`, one work-unit commit per task; push/PR/release are the user's.
Runner: `bash cds-skills/test/install.test.sh` (temp `HOME`, never the real `~/.claude`). Sources to port live in `plugins/odd-claude/` (`claude-md/*.md`, `rules/`, `agents/`, `skills/`, `output-styles/odd.md`, `support/`).

## Specs

### S1 Goal (verbatim, L1)
- "Podemos trabajar en un subrepo dentro de este para una version lite de odd-lite llamado cds-skills (cluade development system) ya que tengo colegas que solo quiero algo simple para ellos por lo cual no solo es copiar si no portear. por medio de curl un script que solo le instale lo siguiente:\n- Los skills\n- Los Agentes\n- Claude.md y los rules\n- Outputstyle"
- It is a PORT, not a copy: every reference to hooks, CLIs (`node ... dist/...`), the `odd-review` MCP, Workflow scripts, Engram, codegraph, profiles, Coordinator mode, session context lines, scratch dir, skill registry, StopFailure or `odd-claude` installer commands is removed or rewritten as plain instructions.

### S2 No deterministic code (verbatim)
- "No tendra rdd (de forma determinista) y general nada del codigo determinista deberia supirlo la skill"
- The only executable code is the installer (`install.sh`, `uninstall.sh`) and its test. Nothing installed runs code: no hooks, no MCP servers, no scripts referenced by skills.

### S3 Fixed economy models, all effort medium (verbatim)
- "los agentes solo van a seguir la linea base de perfil economico" ... "la idea es que ellos no personalizen nada"
- L2: "si esta bien haiku y sonner pero todo medium"
- Exact table, written in each agent's frontmatter (`model:` and `effort: medium`):
  cds-explore haiku; cds-worker sonnet; cds-verify haiku; cds-jd-fix sonnet; cds-jd-judge-a sonnet; cds-jd-judge-b sonnet; cds-review-risk, cds-review-resilience, cds-review-readability, cds-review-reliability haiku. Native agents (Explore, Plan, general-purpose): the CLAUDE.md instructs passing `model: sonnet`.
- Assumption to check: odd-claude's installer never writes `effort` for haiku (see `plugins/odd-claude/src/installer/`). If that is because haiku does not support effort, haiku agents omit `effort` and the Log records why; otherwise all agents carry `effort: medium`.
- No profile skill, no settings, no customization surface.

### S4 Layout and naming
- L3: "si dentro de aqui y el curl de aqui". Folder `cds-skills/` at the repo root of `carsimax/odd-plugin`.
- Install command: `curl -fsSL https://raw.githubusercontent.com/carsimax/odd-plugin/main/cds-skills/install.sh | bash`; `CDS_REF=<git ref>` overrides `main`.
- Everything installed carries the `cds` prefix so it never collides with odd-claude or user files: skills `cds-<name>`, agents `cds-<name>.md`, rules `cds-<name>.md`, output style `cds` (`output-styles/cds.md`).
- Delegation is fixed organic (what odd-claude calls Coordinator mode OFF); no toggle.

### S5 Scope of skills
- Port (simplified): `odd` -> `cds` (ODD protocol, feature doc `odd/tasks/` as convention without lint, include the content of `support/feature-doc-format.md` and `support/test-first.md` it needs), `systematic-debugging`, `receiving-review`, `branch-pr`, `chained-pr`, `work-unit-commits`, `comment-writer`, `issue-creation`, `cognitive-doc-design`, `ui-design`, `tui-design`, `4r-review` (inline Agent route only, no Workflow/MCP), `judgment-day` (one blind round plus one fix, no ledger or hash).
- Drop: `odd-background-subagents`, `odd-coordinator`, `odd-doctor`, `odd-profiles`, `odd-retro`, `odd-scratch`, `odd-setup`, `odd-skill-registry`, `odd-stats`, `odd-status`, `skill-creator`, `skill-improver`.
- Agents drop `mcp__codegraph__*` and `mem_save` tools.

### S6 Installer behavior
- Downloads the tarball of `CDS_REF` (default `main`) from GitHub, copies only the `cds-skills/payload` files to `~/.claude/{skills,agents,rules,output-styles}` (honor `CLAUDE_CONFIG_DIR` if set).
- CLAUDE.md: content goes between `<!-- cds:start -->` and `<!-- cds:end -->`; existing content outside the markers is preserved; a timestamped backup is made before writing; reinstall replaces the block, never duplicates it.
- Output style: sets `"outputStyle": "cds"` in `settings.json` with `jq` when available (preserving other keys); without `jq`, prints the instruction `/output-style cds` and does not edit JSON.
- Records installed files in `~/.claude/cds-skills/manifest.txt`; reinstall removes stale `cds` files from the previous manifest; `uninstall.sh` removes only manifest files, the marker block and the `outputStyle` value when it is `cds`.
- bash + coreutils + curl + tar only (jq optional); works on macOS and Linux; `set -euo pipefail`.

### S7 Docs
- `cds-skills/README.md`: what it installs, the curl command, `CDS_REF`, uninstall, the model table, what was dropped versus odd-claude. English (technical artifacts default to English).

## Tasks
- T1 | S1 S2 S3 S4 | odd-worker (parallel unit A) | pending | CLAUDE.md lite + rules `cds-delegation`, `cds-verification`, `cds-tracking` (path-scoped like odd-tracking) + output style `cds.md` under `cds-skills/payload/`. done when: no file under those paths mentions hooks, MCP, Engram, codegraph, profiles, Coordinator, registry, scratch or `node`.
- T2 | S1 S3 S4 S5 | odd-worker (parallel unit B) | pending | 10 agents `cds-*` under `cds-skills/payload/agents/`. done when: every agent has the S3 model, no codegraph/Engram tools, names prefixed `cds-`.
- T3 | S1 S2 S4 S5 | odd-worker (parallel unit C) | pending | 13 ported skills under `cds-skills/payload/skills/cds-*/`. done when: grep for `node `, `dist/`, `review_`, `mem_`, `Workflow`, `CLAUDE_PLUGIN`, `odd-claude` returns nothing; cross-references use `cds-` names.
- T4 | S4 S6 | odd-worker (after T1-T3) | pending | `install.sh`, `uninstall.sh`, test `cds-skills/test/install.test.sh`. Risk: item 5 (installer writes into other people's `~/.claude`, CLAUDE.md and settings.json) -> own commit + odd-verify. done when: test passes install, reinstall without duplicate block, preserved prior CLAUDE.md, uninstall, jq and no-jq paths, against a temp HOME with a local payload source (no network).
- T5 | S7 | odd-worker (with T4) | pending | `cds-skills/README.md`. done when: the curl command and model table match S3/S4.
- Route evidence: Writer trigger (a) parallelism: T1, T2, T3 are independent units with disjoint surfaces, each several files; launched together. T4/T5 depend on the payload layout.

## Log
- L1: user's original request: "Podemos trabajar en un subrepo dentro de este para una version lite de odd-lite llamado cds-skills (cluade development system) ya que tengo colegas que solo quiero algo simple para ellos por lo cual no solo es copiar si no portear. por medio de curl un script que solo le instale lo siguiente:\n- Los skills\n- Los Agentes\n- Claude.md y los rules\n- Outputstyle\n\nNo tendra rdd (de forma determinista) y general nada del codigo determinista deberia supirlo la skill ayudame con la proupuesta de esto, ademas de que los agentes solo van a seguir la linea base de perfil economico (listame como quedarian los modelos), la idea es que ellos no personalizen nada"
- L2 (2026-11-26): "si esta bien haiku y sonner pero todo medium"
- L3 (2026-11-26): "si dentro de aqui y el curl de aqui"
- L4 (2026-11-26): "Si vamos con este plan trabajalo en worktree para no pisr el trabajo del otro agente". Worktree created at `../odd-claude-cds-skills` from `8f5946b`; main's uncommitted installer changes (other agent) stay untouched.
