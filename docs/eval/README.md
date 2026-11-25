# Harness eval (dev-only)

Outcome measurement of odd-claude with real Claude sessions: a runner on `claude -p` that runs coding tasks on fixture repos, grades the end state with hidden tests and records cost, tokens (subagents included), wall time, subagent launches and pass/fail per arm. It is dev tooling: not in the plugin payload, and it spends real money.

Source: `bench/src/eval/` (compiled to the gitignored `bench/dist/eval/` by `npm run build:bench`). Specs use a fake `claude` and never call a model: `npm run test:bench`.

## Usage

```
npm run eval -- [--tasks a,b] [--arms none,coord-on,coord-off] [--trials 3] [--max-budget-usd 2] [--max-turns 60] [--total-budget-usd 70] [--out <dir>] [--dry-run]
```

- `--dry-run` prints the plan (tasks x arms x trials, in execution order) and the worst-case cost; nothing runs.
- Other options: `--tasks-dir` (default `bench/eval-tasks`), `--model` (default `opus`), `--claude-bin` (default `claude`), `--keep-workspaces`, `--skip-auth-check`.
- Credentials: a real run refuses to start unless the environment carries one (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or a Bedrock/Vertex/Foundry switch), because runs use a private `CLAUDE_CONFIG_DIR` where your stored login does not exist (see Isolation).
- `--out` defaults to a fresh temp dir; the output path is printed first.

## Task format

`bench/eval-tasks/<id>/task.json` (`id`, `kind` bugfix|feature|refactor, `size` small|medium, `prompt`, `grade`, `timeout_s`, optional `allowed_tools`), `repo/` (shipped to the agent) and `hidden/` (never shown).

Per run: `repo/` is copied into a fresh temp workspace, `git init` + one commit; `claude` runs there. Afterwards the task's `hidden/` directory is copied to `<workspace>/hidden/` (so `node --test hidden/` and imports like `../src/...` resolve) and `grade` runs with `sh -c` in the workspace root; exit 0 = pass. `timeout_s` bounds the claude session (killed with SIGKILL; no shell `timeout`, which macOS lacks); grading gets `min(timeout_s, 300)` s.

## Arms

| arm | plugin | delegation state |
| --- | --- | --- |
| `none` | none (no `--plugin-dir`) | n/a |
| `coord-on` | `--plugin-dir <staged copy of plugins/odd-claude>` | `{"mode":"full"}` |
| `coord-off` | `--plugin-dir <staged copy of plugins/odd-claude>` | `{"mode":"organic"}` |

Caveat: the eval runs odd-claude WITHOUT its engram dependency, so memory is absent in every arm. `plugins/odd-claude/.claude-plugin/plugin.json` declares `"dependencies": ["engram@engram"]`, which is not installed in the isolated `CLAUDE_CONFIG_DIR`, and Claude Code then disables the whole plugin. Once per `runEval` the runner copies the plugin to a fresh temp dir, removes the `dependencies` key from the copy's manifest, passes that copy as `--plugin-dir` and deletes it when the eval ends (also on error). The repository's `plugin.json` is never modified. Each record carries `plugin_staged`.

Every run: `claude -p --output-format stream-json --verbose --model opus --permission-mode dontAsk --allowedTools "Agent,Read,Edit,Write,Glob,Grep,Bash(node *),Bash(npm *),Bash(git *)" --max-turns N --max-budget-usd B --no-session-persistence --setting-sources "" [--plugin-dir <staged copy> --settings '{"outputStyle":"odd-claude:odd"}'] <prompt>`. The plugin flags apply to `coord-on` / `coord-off` only (`--settings` is needed because `--setting-sources ""` leaves the output style at `default`). Never `--bare` (it skips plugin hooks) and never a permission-bypass flag.

## Isolation

Goal: a run never reads or writes your real `~/.claude`, plugin data, settings or the installed odd-claude state.

Mechanism (per run, all under one fresh `mktemp -d` root, removed afterwards):

- The child environment is built from scratch: `HOME`, `XDG_*`, `GIT_CONFIG_GLOBAL` and `CLAUDE_CONFIG_DIR` point inside the run root. Inherited from the parent only: `PATH`, `TMPDIR`, credentials/provider variables (`ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_*`, `AWS_*`, `GOOGLE_*` and similar), proxy and CA variables. `CLAUDE_CONFIG_DIR`, `CLAUDE_PLUGIN_*` and `CLAUDE_CODE_PLUGIN_DIRS` are never inherited.
- `--setting-sources ""` loads no user, project or local settings file.
- Plugin data: Claude Code documents `${CLAUDE_PLUGIN_DATA}` as `~/.claude/plugins/data/<id>/`, where `<id>` is the plugin id with every character outside letters, digits, `_`, `-` replaced by `-` (plugins reference, "Path variables and persistent data"), and `CLAUDE_CONFIG_DIR` as the override of the config directory under which "all settings, session history, and plugins are stored" (environment variables reference). A `--plugin-dir` plugin has the id `<manifest name>@inline` (plugins loading page), so odd-claude's data dir is `<CLAUDE_CONFIG_DIR>/plugins/data/odd-claude-inline/`. For `coord-on` / `coord-off` the runner writes `delegation.json` there in the plugin state format of `plugins/odd-claude/src/lib/state.ts` (`{"version":1,"sessionId":"delegation","data":{"mode":"full"|"organic"}}`). The runner also sets `CLAUDE_PLUGIN_DATA` to the same private dir in the child environment, in case the variable is honored.
- Auth: with `CLAUDE_CONFIG_DIR` set, credentials (`.credentials.json`, and on macOS the Keychain entry) are keyed to that directory, so a fresh dir has no login. The runner does not copy your credentials; pass a credential through the environment (see Usage).
- Observed evidence: the stream-json output of a coordinator run includes the plugin's session context; the runner records `observed_delegation` (`full`/`organic`, parsed from "Delegation mode: ...") in every record, so a run whose plugin did not read the seeded state shows a mismatch (default without state is `full`, so check `coord-off`).

Docs: https://code.claude.com/docs/en/plugins-reference.md, https://code.claude.com/docs/en/plugins/components.md, https://code.claude.com/docs/en/plugins/loading.md, https://code.claude.com/docs/en/env-vars.md, https://code.claude.com/docs/en/authentication.md, https://code.claude.com/docs/en/cli-reference.md.

Unproven (verify in the smoke run by hashing `~/.claude` before and after, and checking `observed_delegation` in the records):

1. That a `--plugin-dir` plugin's data dir really resolves to `<CLAUDE_CONFIG_DIR>/plugins/data/odd-claude-inline/` (the docs give the `~/.claude` form and the `@inline` id separately; their combination is inferred).
2. That nothing outside `CLAUDE_CONFIG_DIR` and `HOME` stores state (for example the macOS Keychain for a Console login without an API key, which the docs say lives outside the config dir).
3. That AWS/GCP profile files under the real `$HOME` are not needed: `HOME` is private, so provider auth must come from environment variables.
4. Hook processes and subagents inherit the private environment (expected, not tested without a real run).

## Budget guard

Before each run: if accumulated cost + the per-run cap (`--max-budget-usd`) would exceed `--total-budget-usd` (default 70), the runner stops and reports how many runs were not started. A finished run is charged its `total_cost_usd`; a run whose cost is unknown (no `result` message) is charged its full cap. Order is trial-major (trial, task, arm), so a stop leaves balanced coverage.

## Output

`<out>/runs.jsonl`: one record per run, appended as each run ends. Schema `odd-claude.eval-run/v1`: `schema`, `run_id` (`task.arm.trial`), `task`, `kind`, `size`, `arm`, `trial`, `model`, `started_at`, `status` (`ok`|`error`|`timeout`|`invalid`), `error`, `exit_code`, `timed_out`, `wall_ms` (measured by the runner), `cost_usd` (`total_cost_usd`), `tokens` (`input`, `output`, `cache_read`, `cache_creation`, `total`, summed over `modelUsage`, so subagents are included), `tokens_by_model`, `num_turns`, `duration_ms`, `subagents` (distinct top-level `tool_use` blocks named `Agent`/`Task`), `is_error`, `result_subtype`, `result_found`, `observed_delegation`, `observed_plugins` (`plugins[].source` of the stream `system`/`init` message), `observed_output_style`, `plugin_staged`, `passed` (hidden tests), `grade_exit_code`, `visible_tests_modified` (a shipped test file changed or was removed; new tests do not count). Any field the stream lacks is `null`; parsing never throws.

`invalid` (proof check, only for a run that would be `ok`; it is still graded and its cost recorded): a plugin arm whose `observed_plugins` lacks `odd-claude@inline`, whose `observed_output_style` is not `odd-claude:odd`, or whose `observed_delegation` differs from the arm's mode (`coord-on` = `full`, `coord-off` = `organic`); or arm `none` whose `observed_plugins` contains `odd-claude@inline`. `error` names the mismatch. `report.md` excludes invalid runs from pass rate and cost stats and lists them (count per arm, plus an `invalid` column).

`<out>/streams/<run_id>.jsonl`: the raw stdout of each run, kept for later analysis without re-running.

`<out>/report.md`: per arm (runs, pass rate, mean / median / sample stdev of cost, tokens, wall seconds, subagents, visible-test modifications) and per task (pass count and mean cost per arm), plus a list of runs with problems and the budget-stop notice, if any.
