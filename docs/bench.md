# Efficiency bench (dev-only)

Offline, model-free bench that measures the *friction* of odd-claude journeys (not wall-clock quality, tokens or a composite score)
and compares them with the upstream oracle (the `gentle-ai` binary). It lives in `bench/` at the repository root, has its own `tsconfig`, builds to
`bench/dist/` (gitignored) and is **not** part of the plugin payload. It answers one question: is odd-claude as efficient as upstream?

## Prerequisites

- The plugin built and its dependencies installed: `cd plugins/odd-claude && npm ci` (the bench compiles with the plugin's `tsc` and drives
  `plugins/odd-claude/dist/`; run the plugin build first if `dist/` is stale).
- Node >= 20 and `git` on `PATH`. `npm run test:bench` passes the spec files to `node --test` as shell globs (`bench/dist/*.spec.js bench/dist/*/*.spec.js`): a quoted glob needs Node 21+, so the spec files must stay at most one directory deep under `bench/src`.
- For the oracle: the upstream `gentle-ai` binary. The default path is
  `~/.local/share/odd-claude-oracle/gentle-ai-4.6.0/bin/gentle-ai` (under the current user's home, from `os.homedir()`); point
  `ODD_BENCH_ORACLE_BIN` at another binary. The result records the path as `~/...` when it is under home. Without the binary,
  `--subject oracle|both` exits 2 (use `--subject odd`) and the oracle tests skip.
- No network, no model, no Claude login: the reviewer is a fake `claude` in the sandbox, and telemetry of the oracle is switched off
  (see Isolation).

## Run

```sh
npm run bench -- --out /tmp/odd-bench-results.json     # odd, all journeys; add --journey <id> to select
npm run bench -- --subject oracle --out /tmp/oracle.json   # the upstream binary
npm run bench -- --subject both --out /tmp/bench-out        # both, plus the comparison (see below)
npm run bench -- --subject both --repeat 5 --out /tmp/bench-out   # repeat every journey 5 times (default 3, 1..20)
npm run bench -- --compare /tmp/bench-out/odd.json /tmp/bench-out/oracle.json --out /tmp/again   # rebuild the report, runs nothing
npm run bench:hooks -- --runs 25 --out /tmp/hooks.json  # hook start-up breakdown per event (see docs/bench/hook-startup.md)
npm run test:bench                                      # unit tests of the bench itself
```

Outputs of `--subject both --out <dir>`: `odd.json`, `oracle.json` (`odd-claude.bench-result/v1`), `comparison.json`
(`odd-claude.bench-comparison/v1`) and `report.md`. With `--out <name>.json` the names are `<name>.odd.json`, `<name>.oracle.json`,
`<name>.comparison.json` and `<name>.report.md`. `--compare <odd.json> <oracle.json>` validates both files (odd first, oracle second),
rebuilds `comparison.json` and `report.md` into `--out` (without `--out` it prints the report to stdout) and exits 2 on an unreadable,
invalid or swapped input without writing anything. Exit codes: 0 ok, 1 a journey failed, 2 usage or missing input, 3 invalid result.
A full `both` run with the default 3 repeats takes several minutes; `--repeat 1` takes about two.

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
- Oracle journeys add the product's own switches (below) and run the binary only in that env; its state lands in `$HOME/.gentle-ai`
  and `<repo>/.git/gentle-ai` of the sandbox. The isolation test also runs oracle journeys and checks that the real `~/.claude`,
  the static entries of `~/.gentle-shell` (it is live: the host harness writes sessions there), `~/.gentle-ai` and the other
  product home dirs, and this repository's `.git/gentle-ai`, `odd-plugin`, `config` and `HEAD` did not change (stat only).
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
`git_subprocess`, `surface{bytes}`, `latency{op, ms}`, and `not_comparable{reason}` (not a friction event: it marks the row, see *Not comparable rows*). Model runs and git subprocesses are normally observed on the sandbox `PATH`
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

### The oracle subject (`bench/src/subjects/oracle.ts`)

Runs the same 23 journeys against the upstream binary (`ODD_BENCH_ORACLE_BIN`, default
`~/.local/share/odd-claude-oracle/gentle-ai-4.6.0/bin/gentle-ai`), one fresh process per command, and returns the same normalized facts
and metric events. The run metadata records the binary's own version (`meta.binary.version`, from `gentle-ai version`) and path; the
journeys were ported from sources pinned at 08317b9, so expect version skew (that is why unsupported rows and divergences exist).
If the binary is absent, `--subject oracle|both` exits 2 and the oracle tests skip with a message.

- **No telemetry, no network.** The product sends anonymous usage events unless a kill switch is set. The oracle env sets
  `DO_NOT_TRACK=1` (first in its precedence order) and `GENTLE_AI_TELEMETRY=0`, and points `GENTLE_AI_TELEMETRY_ENDPOINT` at a closed
  loopback port, so even a switch that failed could reach no server. The review commands do not contact the network otherwise
  (the update check belongs to install/update/sync, which the bench never runs). `oracle.spec.ts` asks the real binary (`telemetry
  status --json`) and sees it disabled by each switch alone.
- **Protocol.** Everything the agent does follows the product's own printed route: the selectorless `review status` preflight, the
  printed `review start` with `--consent=relay`, the consent question's own `granted|declined` invocation, `review status` for the next
  collect, `capture-result` per lens, `capture-refuter` and `capture-validation` for severe findings, `capture-correction-plan` before
  the edit, `review acknowledge-approved`, `review validate --gate`, `review stop-hook`, `review mode`.
- **Reviewers without a model.** The binary runs its reviewers itself through `claude` on `PATH`; in the sandbox that is the same fake
  `claude` as for odd, which also answers the upstream provider prompts (a lens result bound to the binding line and manifest, the
  refuter and the validator echoing their request hash) from the same verdict plan. Model runs are therefore *measured*, not reported.
- **Accounting.** Same conventions as odd: every process is a command (the oracle needs two for `inspect` and two for `start`: its
  status preflight then the start); the human prompt is the consent answer only (the oracle has no reviewer cost forecast to approve,
  where odd asks once more per reviewer batch); typed refusals, Stop reminders and gate denials are `in_band` blocks; the first success
  after a block is a recovery; `human_surface_bytes` counts stdout and stderr; git subprocesses are what the `PATH` shim sees.

**Mapping table** (`MAPPING` in `oracle.ts`, one commented row per upstream value; an unmapped value is an error, never a guess):

| Upstream | odd |
| --- | --- |
| assess `risk` passive / medium / high | low / medium / high |
| start `action` closed / consent_required / created / declined | closed / consent_required / consented / declined |
| closure `state` approved / correction_required / escalated | approved / correction_required / escalated |
| status `next_transition` execute review.start / review.acknowledge-approved / review.validate / collect / stop | start / acknowledge / validate / collect / stop |
| failure code `stale_target_identity`; stop reason `corrected_candidate_unavailable` | `binding_drift`; `unchanged_candidate` |
| gate `delivery` unmanaged / disabled/unmanaged | allow / allow (the gate never vetoes) |
| stop-hook `decision` block / empty | remind / silent |

An upstream refusal code without a row keeps its own name prefixed `oracle:` so it is visible.

**Unsupported** (6 of 23, marked `unsupported` with the product's reason, never faked): every journey that needs a delivery denial.
In 4.6.0 `review validate --gate` is non-deciding: for every candidate it reports `delivery=unmanaged` (`allowed=false`, ordinary
repository policy decides), so there is no deny to compare. The two journeys that only expect an allow run and pass, but their rows
are marked `not_comparable` (see below), and a test pins the evidence (the fixture odd denies comes back as an unmanaged allow for a
push and a pull request alike).

**Divergences** (`DIVERGENCES` in `oracle.ts`; the oracle's expected projection, so the oracle row passes and the difference shows
in the projections): a decline persists nothing (status offers the start again; odd offers nothing); no duplicate-start guard while a
correction is pending (a start for the changed candidate asks consent anew); reviewers read the frozen candidate trees, so drift after
consent does not refuse the run (odd refuses it as binding drift); and the product starts with RDD **on** and refuses every review
while it is off (`rdd_disabled`), so a journey that does not set the mode keeps the product default and its `inspect` reads `on`.
The oracle also resumes by capturing every lens then acknowledging (it never runs reviewers in one go), so `resume` is that sequence.

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

## Deadlines

`Journey.deadlineMs` (default 60 s) has two scopes. It is the budget of the **whole journey**: when it passes the journey fails with
"journey deadline exceeded", the in-flight step is cancelled (its running processes are killed and every later operation is refused, so
nothing is counted or spawned after the row is built). It is also the longest any **single** process or MCP operation may run (each one
is killed at that deadline and reported as timed out), so one hung operation cannot outlive the journey. A step that reports `ok:false`
without a block class fails the journey; one with a block class is a block. A hook or review-mode CLI of the odd subject that crashes, times
out, is killed or prints non-JSON fails the step: it is never read as `allow` or `silent`. A sandbox that cannot be created yields a failed
row (`sandbox setup failed: ...`) and its temp directory is removed; the run goes on with the next journey.

## Latency and repeats

Both subjects are measured in the same invocation, on the same machine, each operation in a fresh process (MCP server, hook or CLI
command for odd; one binary invocation per command for the oracle). Each journey is run `--repeat K` times (default 3), every repeat in
its own sandbox. The result records node, OS and binary versions and `repeats` in `meta`.

- Friction is deterministic, so every repeat must agree on it; a journey whose friction differs between repeats is marked `failed`
  ("unstable across repeats"), never averaged. A failure in any repeat fails the journey.
- Latency samples are pooled per operation (median and nearest-rank p95 of all samples). Operation names differ between subjects, so
  the comparable number is `journey.total`: one sample per repeat, the sum of that run's process times; its median is the median of
  K whole-journey times, and the p95 is shown next to it.
- Latency verdict: ratio of medians `odd / oracle`; `equal` when it is within `1/(1+t)..1+t` (default `t` = 0.25) or the medians are at
  most 5 ms apart, `better` below, `worse` above, `not_comparable` when the oracle median is 0 or the operation exists on one side only.
  The summary's *latency median ratio* is the median of the per-journey ratios. Latency is a same-machine cost comparison of different
  surfaces (node-hosted MCP and hooks against one native binary); it is noisy, so read the ratio, not single journeys.

## Reading `report.md`

Sections, in order: **Run** (versions, node, OS, repeats of both subjects), **Summary** (journeys comparable / divergent / unsupported / not comparable;
thresholds; per metric the verdict counts and totals over comparable journeys; latency), **Efficiency verdict**, **Journeys** (one table per
comparable journey: odd, oracle, verdict per metric plus whole-journey latency with p95), **Not comparable journeys**, **Unsupported journeys**, **Declared divergences**,
**How to read**.

- Verdicts are from odd's point of view and lower is better everywhere: `equal`, `better`, `worse`, `not_comparable` (a side is
  unobservable, unsupported, divergent or marked not comparable).
- Thresholds: counts (prompts, commands, blocks, recovery round trips, model runs, git subprocesses) are exact; `human_surface_bytes` and
  `manual_tokens` tolerate 10% (`|odd - oracle| <= max(absolute, relative * max(odd, oracle))`); `blocks` compare by total, `by_design`
  included. `compareResults` takes custom thresholds (`per_metric`: `{relative, absolute}`, i.e. ±N or a ratio).
- **Not comparable rows.** A journey row can carry `not_comparable` (a list of reasons; schema field, optional). The oracle subject
  sets it whenever its gate reports `delivery=unmanaged` (4.6.0: always): that gate never decides, so its near-zero cost (3 git calls,
  about 35 ms) says nothing about how cheaply a deciding gate protects, and counting it would make upstream look like the winner on
  git subprocesses and latency. Such a row gets `kind: not_comparable`, every metric verdict `not_comparable`, its own report section with the reason
  and the raw numbers, and is excluded from the per-metric counts, the totals, the latency summary and the efficiency verdict, exactly like
  a divergence. A mark on either side excludes the journey. Results recorded before the mark existed carry none; the committed baseline
  was annotated by hand (see `docs/bench/findings.md`, limits).
- Unsupported rows and declared divergences are listed apart and are **never** wins or losses: they are excluded from per-metric
  counts and totals, from the latency summary and from the efficiency verdict. A divergent journey keeps its raw numbers for information.
- **Efficiency verdict**: per dimension, `at_least_as_efficient` when no comparable journey is `worse`, `less_efficient` otherwise,
  `not_assessable` when nothing was compared; latency uses the overall median ratio against `1 + tolerance`. The overall line names the
  dimensions that are less efficient. Always read it with the caveats printed under it:
  - the oracle has no reviewer cost forecast, so it has fewer human prompts by design (and fewer `manual_tokens`): odd's extra prompt is a
    safety step the oracle simply does not have;
  - `start` and `inspect` cost two commands on the oracle (status preflight, then the action) and one on odd;
  - `git_subprocesses` is what each product spawns through the `PATH` shim, not git work done in-process or setup git calls.

## Metric definitions

See the table in *Metrics and derivations* above for what each dimension is and how it is derived. Everything is observed by the bench, never reported by the
subjects, except the events a subject declares for its steps (prompts, commands, blocks, recoveries, surface bytes); `model_runs` and
`git_subprocesses` come from the counting shims on the sandbox `PATH`. Every dimension carries its derivation (`measured`, `proxy`,
`unobservable`); an unobservable value is `null` and makes that verdict `not_comparable`.

## Known limits

- **Unsupported journeys** (6 of 23): every journey needing a delivery denial. Oracle 4.6.0's `review validate --gate` never denies
  (`delivery=unmanaged`), so there is nothing to compare; they are marked with that reason, not faked. The 2 allow-only gate journeys
  run but are `not_comparable` for the same reason.
- **Version skew**: the oracle is 4.6.0 while the journeys were ported from sources pinned at 08317b9. A behavior change between them shows
  up as a divergence or an unsupported row.
- **Declared divergences** (see the oracle subject above): a decline persists nothing; no duplicate-start guard during a pending correction;
  reviewers read frozen trees so drift after consent does not refuse the run; RDD defaults to on. Derived from the oracle's own expectation
  (`declaredDivergences` in `bench/src/cli.ts`) and stored on the oracle rows as `divergence`, so `--compare` sees them from saved results.
- Accounting conventions differ between the products' surfaces (see the caveats above); the verdicts compare friction under those
  conventions, not user-perceived quality. Reviewer outputs are synthesized, so model quality is out of scope.
- Journeys are small and offline; they corroborate efficiency of the review lifecycle and gate, not general agent behavior.

## Formats

- Result: `odd-claude.bench-result/v1` (`bench/src/schema.ts`): run metadata (`subject` odd|oracle, binary, node, OS, commit), per-journey rows
  (`id`, `status` passed|failed|unsupported, outcome projection, metrics) and an aggregate.
- Comparison: `odd-claude.bench-comparison/v1` (`bench/src/compare.ts`): per journey a `kind` (`comparable|divergent|unsupported|missing|not_comparable`), odd vs
  oracle per metric with `equal|better|worse|not_comparable`, latency per operation (`ratio`, medians, p95), the thresholds used and a summary.
  Projections are compared, never bytes or hashes. `report.md` is rendered from it by `bench/src/report.ts`.

## Baseline and findings

- First recorded baseline (K=3, odd 2.0.0 vs oracle 4.6.0): [`docs/bench/baseline-2026-11-20/`](bench/baseline-2026-11-20/README.md).
- What it says about S2 ("as efficient as upstream"), the cells that are worse and the proposed follow-ups: [`docs/bench/findings.md`](bench/findings.md).
