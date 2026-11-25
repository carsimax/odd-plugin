# odd-skills

A proof of concept that delivers the ODD workflow of odd-claude without the plugin runtime: a tiny always-loaded coordinator `CLAUDE.md`, on-demand skills that launch the subagents they need, agent definitions with pinned models, and one deterministic guard hook. Markdown and POSIX shell only: no Node at runtime, no MCP servers, no RDD.

Why: the hard-task eval (`docs/eval/hard-2026-11-25.md`) found the plugin's always-loaded context cost +50-80% without a measured gain. Here the always-loaded part is about 2.4 KB and everything else loads on demand.

## Layout

```
odd-skills/
  CLAUDE.md              coordinator (<= 2.5 KB): protocol, safety, skill index
  skills/<name>/SKILL.md on-demand skills (+ references/); `odd` is the workflow skill
  agents/<name>.md       10 subagents with `model:` pinned
  hooks/guard.sh         PreToolUse (Bash) guard
  tests/guard.test.sh    guard tests: sh odd-skills/tests/guard.test.sh
  install.sh             installer (written separately)
```

## Install into an isolated profile

```
./odd-skills/install.sh --target /tmp/odd-profile
CLAUDE_CONFIG_DIR=/tmp/odd-profile claude
```

Installer interface:

- `install.sh --target <config-dir> [--uninstall] [--dry-run]`; `--target` is required (no default).
- It refuses `~/.claude` unless `--i-know-this-is-my-real-config` is also passed.
- Install: backs up every file it changes into `<target>/.odd-skills-backup/<timestamp>/`; copies skills to `<target>/skills/`, agents to `<target>/agents/`, the guard to `<target>/odd-skills/hooks/`; adds the coordinator to `<target>/CLAUDE.md` between `<!-- odd-skills:begin -->` and `<!-- odd-skills:end -->` (other content is kept); merges the `PreToolUse` Bash hook into `<target>/settings.json` without dropping keys (needs `jq` when a merge is needed); writes a manifest. Re-install is idempotent.
- `--uninstall` removes exactly the manifest's paths, the marked block and the hook entry.
- It never touches files outside `<target>`.

## Models per agent

| Agent | Model |
|---|---|
| odd-explore | haiku |
| odd-worker | sonnet |
| odd-verify | opus |
| odd-jd-fix | sonnet |
| odd-jd-judge-a | opus |
| odd-jd-judge-b | sonnet |
| odd-review-readability | sonnet |
| odd-review-reliability | sonnet |
| odd-review-resilience | sonnet |
| odd-review-risk | opus |

The `odd` skill also passes `model` and `effort` on every Agent call (explore haiku/low, worker sonnet/medium, verify opus/high).

## Guard hook

`hooks/guard.sh` reads the PreToolUse JSON on stdin (`tool_name`, `cwd`, `tool_input.command`; see https://code.claude.com/docs/en/hooks.md) and exits 2 with a remediation message for: `git push --force`/`-f`/`--force-with-lease`, `git reset --hard`, `--no-verify`, `git branch -D`, `git clean -f`, and `rm -rf` on `/`, `~`, `$HOME`, paths with `..` or absolute paths outside the project. Everything else exits 0. It uses `jq` when present and a `sed` fallback otherwise; it fails open on unparsable input. Commands wrapped in `bash -c "..."` are not inspected: it is a guard rail, not a sandbox.

## Dropped versus the plugin

- RDD and the review MCP (the `4r-review` skill launches the four `odd-review-*` agents directly instead), peers, the status/doctor/stats CLIs, session-context hooks (SessionStart, UserPromptSubmit, Stop and friends), persona and profiles commands, background-subagents, coordinator, scratch, setup and skill-registry skills.
- Cards became `skills/odd/references/*.md`, read only when their situation arises.
- Memory (Engram) is optional: used only when its tools are connected.
