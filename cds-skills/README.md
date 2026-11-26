# cds-skills: a lite ODD setup for Claude Code

`cds` (Claude Development System) is a small, fixed bundle of skills, agents, rules and an output style that gives teammates the Organic Driven Development workflow without any customization. It is a port of odd-claude: everything is plain instructions, and nothing installed runs code (no hooks, no MCP servers, no scripts).

## Quick path

```bash
curl -fsSL https://raw.githubusercontent.com/carsimax/odd-plugin/main/cds-skills/install.sh | bash
```

1. Run the command above.
2. Restart Claude Code (or open a new session).
3. Check that the `cds` output style is active (`/output-style`).

Pin a version with a git ref (tag, branch or commit):

```bash
curl -fsSL https://raw.githubusercontent.com/carsimax/odd-plugin/main/cds-skills/install.sh | CDS_REF=<tag> bash
```

The installer needs `bash`, `curl`, `tar` and coreutils. `jq` is optional. The repository must be public: plain `curl` sends no GitHub credentials.

## What it writes

Target is `~/.claude`, or `$CLAUDE_CONFIG_DIR` when set.

| Path | Content |
|------|---------|
| `skills/cds*` | 13 skills |
| `agents/cds-*.md` | 10 agents |
| `rules/cds-*.md` | 3 rules (delegation, verification, tracking) |
| `output-styles/cds.md` | the `cds` output style |
| `CLAUDE.md` | the cds instructions between `<!-- cds:start -->` and `<!-- cds:end -->`; your own content outside the markers is kept |
| `CLAUDE.md.cds-backup-<timestamp>` | backup made before every change to `CLAUDE.md` |
| `settings.json` | `"outputStyle": "cds"`, other keys untouched (only with `jq`) |
| `cds-skills/manifest.txt`, `cds-skills/uninstall.sh` | what was installed, and the uninstaller |

- Reinstalling replaces the block (never duplicates it) and removes cds files that are no longer shipped.
- Without `jq`, `settings.json` is not edited. Run `/output-style cds` inside Claude Code instead.
- If `settings.json` is not valid JSON, the install stops before changing anything.

## Uninstall

```bash
bash ~/.claude/cds-skills/uninstall.sh
```

It removes only the files listed in the manifest, the marker block in `CLAUDE.md` (after a backup), and `outputStyle` when it equals `cds`. Running it twice is safe.

## Models

Fixed economy line, no overrides. Haiku carries no `effort` setting.

| Agent | Model | Effort |
|-------|-------|--------|
| cds-explore | haiku | none |
| cds-worker | sonnet | medium |
| cds-verify | haiku | none |
| cds-jd-fix | sonnet | medium |
| cds-jd-judge-a | sonnet | medium |
| cds-jd-judge-b | sonnet | medium |
| cds-review-risk, cds-review-resilience, cds-review-readability, cds-review-reliability | haiku | none |

Native agents (Explore, Plan, general-purpose) are asked to run with `model: sonnet`.

## Skills

`cds` (the workflow), `cds-systematic-debugging`, `cds-receiving-review`, `cds-branch-pr`, `cds-chained-pr`, `cds-work-unit-commits`, `cds-comment-writer`, `cds-issue-creation`, `cds-cognitive-doc-design`, `cds-ui-design`, `cds-tui-design`, `cds-4r-review`, `cds-judgment-day`.

## Not included, on purpose

Compared with odd-claude, cds has no hooks, no MCP servers (review, Engram, codegraph), no workflow scripts, no installer CLI, no profiles or Coordinator mode toggle, no skill registry, and no setup, doctor, status, stats, retro or scratch skills. Delegation is fixed to the organic mode.
