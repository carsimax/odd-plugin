# Efficiency bench (dev-only)

Offline, model-free bench that measures the *friction* of odd-claude journeys (not wall-clock quality, tokens or a composite score)
and, later, compares them with the upstream oracle. It lives in `bench/` at the repository root, has its own `tsconfig`, builds to
`bench/dist/` (gitignored) and is **not** part of the plugin payload. Full documentation arrives in T4; this is a stub.

## Run

```sh
npm run bench -- --out /tmp/odd-bench-results.json     # all journeys; add --journey <id> to select
npm run test:bench                                      # unit tests of the bench itself
```

Each journey gets its own sandbox (temp `HOME`, temp git repo, optional bare origin). A `git` shim on the sandbox `PATH` counts
invocations and forwards to the real git; `claude` is a fake that counts its runs and synthesizes reviewer verdicts, so no model
runs. Every MCP operation, hook and CLI command runs in a fresh process.

## Isolation

The bench never touches the real Claude installation or the real repository:

- The child environment is built from scratch (`bench/src/sandbox.ts`): nothing is inherited except the tail of `PATH` (to find
  `node` and `git`) and `TMPDIR`. No `ANTHROPIC_*`, `CLAUDE_*`, `AWS_*` or any other parent variable reaches a child.
- `HOME`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and `GIT_CONFIG_GLOBAL`
  all point inside the sandbox root; the review-mode CLI is also given `--data-dir <sandbox data dir>`.
- The sandbox `bin/` (the `git` counting shim and the fake `claude`) is first on `PATH`, so the reviewer runner can only reach the fake.
- The sandbox lives under the session `TMPDIR` and is removed when its journey ends.
- `bench/src/journeys/journeys.spec.ts` checks it: it snapshots (stat only, never reading content) the real `~/.claude/plugins/data`,
  `~/.claude/settings*.json` and this repository's `odd-plugin/` and `config` before and after running journeys and asserts
  nothing changed, that the state did land inside the sandbox, and that no sandbox or reviewer scratch directory is left in `TMPDIR`.

## Journeys

A journey is **data** (`JourneyDef` in `bench/src/journey.ts`): a fixture, a list of abstract steps, and the normalized facts each
step must produce. A **subject** executes the steps and normalizes what it saw, so the same definitions run against odd today and
against the upstream `gentle-ai` binary (the oracle) in T3; only normalized projections are compared, never bytes or hashes.

Step vocabulary (`StepSpec`): `assess`, `inspect`, `status`, `start{consent: relay|granted|declined, lenses, target}`,
`answerConsent{answer}`, `captureAll{verdict: approve|findings}`, `resume`, `correct{edit: fix|noop|drift}`, `commit`, `acknowledge`,
`gateCheck{command: push|prOpen}`, `stopHook{session}`, `modeSet{mode: on|off, scope: global|clone}`. `target` is `workspace`
(default) or `committed` (the committed range ahead of origin). What a gate check must decide is the step's expected facts
(`outcome: allow|deny`, `gate`, `reason`).

Normalized facts (`NormalizedFacts`): `outcome`, `risk`, `state`, `lenses`, `next`, `gate`, `reason`, `mode`, `lineages`; only the
ones a step declares are part of its projection. The projection of a journey is `{steps: [{step, ...facts}]}`, in order.

Metric events a subject reports per step (`MetricEvent`): `human_prompt{text}`, `command`, `block{class}`, `recovery`, `model_run`,
`git_subprocess`, `surface{bytes}`, `latency{op, ms}`. Model runs and git subprocesses are normally observed on the sandbox `PATH`
(the odd subject reports none of those two); a subject that cannot be observed that way reports them as events. Setup (fixture,
RDD mode) is never counted.

### The odd subject (`bench/src/subjects/odd.ts`)

Drives the real surface, one fresh process per operation: the review MCP server (`dist/mcp/review-server.js`), the PreToolUse and
Stop hooks (`dist/hooks/run.js <event>`) and the review-mode CLI (`dist/cli/review-mode.js`). Reviewer verdicts come from the fake
`claude`, which reads the prompt's own echo line and the sandbox verdict plan (`$HOME/odd-bench-verdicts.json`): no findings by
default, one severe finding in the `risk` lens for `captureAll{findings}`, a validator that passes unless the plan says otherwise.

Friction as odd reports it: the human prompts are the consent answer and the approval of each reviewer cost forecast (the tool
contract says never to run reviewers before the user saw it); every process is one command; a gate denial, a Stop reminder and a
typed refusal are `in_band` blocks (each names the route forward), and the first success after a block is a recovery.

Delivery commands (a push, opening a pull request) are presented to the gate hook **as text only**: they are assembled from
fragments and never executed by a shell or git, and no push ever happens (origin is a local bare repository).

### Catalog

`bench/src/journeys/{lifecycle,correction,gate}.ts`: 23 journeys, each with the closest upstream id as `refId` when there is one
(`ref_id` in the result row; traceability only, the vocabularies differ).

| Group | Journeys |
| --- | --- |
| Lifecycle by risk | low closes with 0 lenses; medium 1 lens consent, capture, acknowledge; high 4-lens group; explicit lens selection; consent declined; consent never answered implicitly; resume after consent |
| Correction and drift | correction then validator approves; correction no-op refused; duplicate START guard; binding drift mid-run; binding drift after the consent question |
| Gate (RDD on) | push denied unreviewed high risk; allowed after receipt; allowed when declined; allowed for a medium-risk range; PR open denied and allowed after receipt; a workspace review does not authorize the committed range |
| Gate off, Stop, mode | gate silent with RDD off; Stop reminds once per session and candidate; Stop silent with RDD off; RDD mode global and clone scopes |

To add a journey, add a `JourneyDef` to one of those files (`bench/src/journeys/index.ts` collects them) and run
`npm run test:bench`: `journeys.spec.ts` runs every definition against odd.

## Metrics and derivations

| Metric | Derivation | How it is obtained for odd |
| --- | --- | --- |
| `human_prompts` | measured | steps whose actor is `human` |
| `manual_tokens` | proxy | ceil(bytes / 4) of text on human steps |
| `commands_to_completion` | measured | agent steps (MCP tool call, hook, CLI command) |
| `blocks` | measured | blocked steps by class: `self_recovered`, `in_band`, `out_of_band`, `by_design`, `dead_end` (`by_design` still counts in the total) |
| `recovery_round_trips` | measured | successful steps right after a blocked step |
| `model_runs` | measured | fake `claude` invocations |
| `human_surface_bytes` | measured | UTF-8 bytes of MCP tool text, hook stdout and text relayed by human steps |
| `git_subprocesses` | measured | `git` shim invocations |
| `latency` (odd-only) | measured | per operation `{samples, median_ms, p95_ms}`, nearest-rank p95 |

`unobservable` dimensions carry `value: null`, never a fabricated 0.

## Formats

- Result: `odd-claude.bench-result/v1` (`bench/src/schema.ts`): run metadata (`subject` odd|oracle, binary, node, OS, commit), per-journey rows
  (`id`, `status` passed|failed|unsupported, outcome projection, metrics) and an aggregate.
- Comparison: `odd-claude.bench-comparison/v1` (`bench/src/compare.ts`): odd vs oracle per journey per metric,
  `equal|better|worse|not_comparable`; two values are equal when `|odd - oracle| <= max(absolute, relative * max(odd, oracle))`
  (default relative 0.1). Lower is better. Projections are compared, never bytes or hashes.
