# Efficiency report: odd-claude vs upstream oracle

## Run

- odd: 2.1.0 (~/Developer/03-PERSONAL/odd-claude/plugins/odd-claude/dist/mcp/review-server.js), commit a813872d27d8, node v26.12.1, darwin arm64 27.2.0, repeats: 10, started 2026-11-22T00:45:43.426Z
- oracle: 4.6.0 (~/.local/share/odd-claude-oracle/gentle-ai-4.6.0/bin/gentle-ai), commit binary-only, node v26.12.1, darwin arm64 27.2.0, repeats: 10, started 2026-11-22T00:45:57.501Z

Both subjects ran in the same bench invocation on this machine, each journey in fresh processes inside its own sandbox, repeated `repeats` times; latency uses the median of the repeats.
The oracle is 4.6.0; the journeys were ported from sources pinned at 08317b9 (version skew, see docs/bench.md).

## Summary

- journeys: 2; comparable: 2 of 2; divergent: 0; unsupported: 0; not comparable: 0; missing: 0
- outcome projections on comparable journeys: equal 2, different 0
- thresholds: counts exact (±0, 0%); human_surface_bytes ±0 or 10%; manual_tokens ±0 or 10%; latency: ratio of medians within ×1.25 (or 5 ms apart) is equal

Per metric over the comparable journeys (lower is better; totals sum journeys where both sides are observable):

| metric | equal | better | worse | not_comparable | odd total | oracle total |
| --- | --- | --- | --- | --- | --- | --- |
| human_prompts | 2 | 0 | 0 | 0 | 0 | 0 |
| manual_tokens | 2 | 0 | 0 | 0 | 0 | 0 |
| commands_to_completion | 1 | 1 | 0 | 0 | 6 | 8 |
| recovery_round_trips | 2 | 0 | 0 | 0 | 0 | 0 |
| model_runs | 2 | 0 | 0 | 0 | 0 | 0 |
| human_surface_bytes | 1 | 1 | 0 | 0 | 747 | 2266 |
| git_subprocesses | 0 | 2 | 0 | 0 | 27 | 31 |
| blocks | 2 | 0 | 0 | 0 | 0 | 0 |

Latency (whole-journey time, median of repeats): 2 journeys compared; equal 1, better 0, worse 1; median ratio 1.62 (odd / oracle, below 1 is faster); p95 per journey is in the tables below.

## Efficiency verdict

Is odd-claude at least as efficient as upstream on the comparable journeys, per dimension? (`less_efficient` as soon as one comparable journey is worse; latency by the overall median ratio.)

| dimension | verdict | equal | better | worse | note |
| --- | --- | --- | --- | --- | --- |
| human_prompts | at_least_as_efficient | 2 | 0 | 0 | 0 worse of 2 compared |
| manual_tokens | at_least_as_efficient | 2 | 0 | 0 | 0 worse of 2 compared |
| commands_to_completion | at_least_as_efficient | 1 | 1 | 0 | 0 worse of 2 compared |
| recovery_round_trips | at_least_as_efficient | 2 | 0 | 0 | 0 worse of 2 compared |
| model_runs | at_least_as_efficient | 2 | 0 | 0 | 0 worse of 2 compared |
| human_surface_bytes | at_least_as_efficient | 1 | 1 | 0 | 0 worse of 2 compared |
| git_subprocesses | at_least_as_efficient | 0 | 2 | 0 | 0 worse of 2 compared |
| blocks | at_least_as_efficient | 2 | 0 | 0 | 0 worse of 2 compared |
| latency | less_efficient | 1 | 0 | 1 | median ratio 1.62 against a limit of 1.25 |

Overall: odd-claude is less efficient than upstream in: latency. Read the caveats below before concluding anything.

Caveats (accounting conventions, see docs/bench.md):

- Human prompts: odd asks the human to approve a reviewer cost forecast before running reviewers; the oracle has no cost forecast, so its only human prompt is the consent answer. Odd therefore shows more prompts by design (a safety step, not friction a user of the oracle avoids by being smarter).
- Commands: every process is one command. Starting and inspecting a review cost two commands on the oracle (its status preflight, then the start); odd does it in one call.
- `git_subprocesses` counts only `git` invocations that go through the sandbox `PATH` shim (what each product spawns); a git call made by an absolute path or an in-process library is invisible, and setup git calls are never counted.
- `manual_tokens` is a proxy (bytes / 4 of declared human text); `human_surface_bytes` counts stdout and stderr, so it compares how verbose each product is, not how useful.
- Latency compares different surfaces (odd: MCP server, hooks and CLI on node; oracle: one native binary per command), so it is a same-machine cost comparison, not a quality one. The oracle is 4.6.0, not the pinned reference.
- Unsupported (0), divergent (0) and not comparable (0) journeys are excluded from every verdict above.

## Journeys

Comparable journeys: odd vs oracle per metric.

### stop-silent-with-rdd-off

Outcome projection: **equal**

| metric | odd | oracle | verdict |
| --- | --- | --- | --- |
| human_prompts | 0 | 0 | equal |
| manual_tokens | 0 | 0 | equal |
| commands_to_completion | 1 | 1 | equal |
| recovery_round_trips | 0 | 0 | equal |
| model_runs | 0 | 0 | equal |
| human_surface_bytes | 0 | 0 | equal |
| git_subprocesses | 0 | 3 | better |
| blocks | 0 | 0 | equal |
| latency (median of whole-journey time) | 80.3 ms | 40.3 ms | worse (ratio 1.99; p95 95.3 ms vs 48.4 ms) |

### rdd-mode-global-and-clone-scopes

Outcome projection: **equal**

| metric | odd | oracle | verdict |
| --- | --- | --- | --- |
| human_prompts | 0 | 0 | equal |
| manual_tokens | 0 | 0 | equal |
| commands_to_completion | 5 | 7 | better |
| recovery_round_trips | 0 | 0 | equal |
| model_runs | 0 | 0 | equal |
| human_surface_bytes | 747 | 2266 | better |
| git_subprocesses | 27 | 28 | better |
| blocks | 0 | 0 | equal |
| latency (median of whole-journey time) | 877.4 ms | 706.6 ms | equal (ratio 1.24; p95 1212.3 ms vs 2416.9 ms) |

## Not comparable journeys

Both products ran these, but a measurement says the numbers cannot be read as efficiency (for example the oracle's gate never decides, so its near-zero cost is no win for it). Never counted as wins or losses; the raw numbers are shown for information.

None.

## Unsupported journeys

The oracle cannot express these (marked, never faked); they are not wins or losses.

None.

## Declared divergences

Where the oracle legitimately behaves differently from the shared expectation. Declared findings, never counted as wins or losses; the raw numbers are shown for information.

None.

## How to read

- `equal | better | worse | not_comparable` are from odd's point of view; lower is better for every metric. `not_comparable` means a side is unobservable, unsupported, divergent or marked as not comparable.
- Counts are exact by default; bytes and tokens tolerate 10%; latency uses the ratio of medians with the tolerance above. Details, derivations and limits: docs/bench.md.
