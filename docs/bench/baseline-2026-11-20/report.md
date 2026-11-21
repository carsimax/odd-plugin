# Efficiency report: odd-claude vs upstream oracle

## Run

- odd: 2.0.0 (/private/var/folders/3f/3v9dql657451v90kmmjx7nwr0000gn/T/gpm4LcQ3/odd-bench/plugins/odd-claude/dist/mcp/review-server.js), commit d0a30237455d, node v26.12.1, darwin arm64 27.2.0, repeats: 3, started 2026-11-21T02:35:05.208Z
- oracle: 4.6.0 (/Users/carsimax/.local/share/odd-claude-oracle/gentle-ai-4.6.0/bin/gentle-ai), commit binary-only, node v26.12.1, darwin arm64 27.2.0, repeats: 3, started 2026-11-21T02:37:27.190Z

Both subjects ran in the same bench invocation on this machine, each journey in fresh processes inside its own sandbox, repeated `repeats` times; latency uses the median of the repeats.
The oracle is 4.6.0; the journeys were ported from sources pinned at 08317b9 (version skew, see docs/bench.md).

## Summary

- journeys: 23; comparable: 12 of 23; divergent: 5; unsupported: 6; missing: 0
- outcome projections on comparable journeys: equal 12, different 0
- thresholds: counts exact (±0, 0%); human_surface_bytes ±0 or 10%; manual_tokens ±0 or 10%; latency: ratio of medians within ×1.25 (or 5 ms apart) is equal

Per metric over the comparable journeys (lower is better; totals sum journeys where both sides are observable):

| metric | equal | better | worse | not_comparable | odd total | oracle total |
| --- | --- | --- | --- | --- | --- | --- |
| human_prompts | 6 | 0 | 6 | 0 | 13 | 6 |
| manual_tokens | 6 | 0 | 6 | 0 | 77 | 36 |
| commands_to_completion | 5 | 7 | 0 | 0 | 52 | 72 |
| recovery_round_trips | 12 | 0 | 0 | 0 | 1 | 1 |
| model_runs | 10 | 2 | 0 | 0 | 17 | 19 |
| human_surface_bytes | 2 | 10 | 0 | 0 | 130868 | 231454 |
| git_subprocesses | 1 | 9 | 2 | 0 | 1512 | 3698 |
| blocks | 12 | 0 | 0 | 0 | 4 | 4 |

Latency (whole-journey time, median of repeats): 12 journeys compared; equal 4, better 5, worse 3; median ratio 0.90 (odd / oracle, below 1 is faster); p95 per journey is in the tables below.

## Efficiency verdict

Is odd-claude at least as efficient as upstream on the comparable journeys, per dimension? (`less_efficient` as soon as one comparable journey is worse; latency by the overall median ratio.)

| dimension | verdict | equal | better | worse | note |
| --- | --- | --- | --- | --- | --- |
| human_prompts | less_efficient | 6 | 0 | 6 | 6 worse of 12 compared |
| manual_tokens | less_efficient | 6 | 0 | 6 | 6 worse of 12 compared |
| commands_to_completion | at_least_as_efficient | 5 | 7 | 0 | 0 worse of 12 compared |
| recovery_round_trips | at_least_as_efficient | 12 | 0 | 0 | 0 worse of 12 compared |
| model_runs | at_least_as_efficient | 10 | 2 | 0 | 0 worse of 12 compared |
| human_surface_bytes | at_least_as_efficient | 2 | 10 | 0 | 0 worse of 12 compared |
| git_subprocesses | less_efficient | 1 | 9 | 2 | 2 worse of 12 compared |
| blocks | at_least_as_efficient | 12 | 0 | 0 | 0 worse of 12 compared |
| latency | at_least_as_efficient | 4 | 5 | 3 | median ratio 0.90 against a limit of 1.25 |

Overall: odd-claude is less efficient than upstream in: human_prompts, manual_tokens, git_subprocesses. Read the caveats below before concluding anything.

Caveats (accounting conventions, see docs/bench.md):

- Human prompts: odd asks the human to approve a reviewer cost forecast before running reviewers; the oracle has no cost forecast, so its only human prompt is the consent answer. Odd therefore shows more prompts by design (a safety step, not friction a user of the oracle avoids by being smarter).
- Commands: every process is one command. Starting and inspecting a review cost two commands on the oracle (its status preflight, then the start); odd does it in one call.
- `git_subprocesses` counts only `git` invocations that go through the sandbox `PATH` shim (what each product spawns); a git call made by an absolute path or an in-process library is invisible, and setup git calls are never counted.
- `manual_tokens` is a proxy (bytes / 4 of declared human text); `human_surface_bytes` counts stdout and stderr, so it compares how verbose each product is, not how useful.
- Latency compares different surfaces (odd: MCP server, hooks and CLI on node; oracle: one native binary per command), so it is a same-machine cost comparison, not a quality one. The oracle is 4.6.0, not the pinned reference.
- Unsupported (6) and divergent (5) journeys are excluded from every verdict above.

## Journeys

Comparable journeys: odd vs oracle per metric.

### low-risk-closes-with-zero-lenses

Outcome projection: **equal**

| metric | odd | oracle | verdict |
| --- | --- | --- | --- |
| human_prompts | 0 | 0 | equal |
| manual_tokens | 0 | 0 | equal |
| commands_to_completion | 3 | 4 | better |
| recovery_round_trips | 0 | 0 | equal |
| model_runs | 0 | 0 | equal |
| human_surface_bytes | 2667 | 8037 | better |
| git_subprocesses | 44 | 94 | better |
| blocks | 0 | 0 | equal |
| latency (median of whole-journey time) | 993.2 ms | 883.6 ms | equal (ratio 1.12; p95 1298 ms vs 925.4 ms) |

### medium-risk-one-lens-consent-capture-ack

Outcome projection: **equal**

| metric | odd | oracle | verdict |
| --- | --- | --- | --- |
| human_prompts | 2 | 1 | worse |
| manual_tokens | 12 | 6 | worse |
| commands_to_completion | 7 | 7 | equal |
| recovery_round_trips | 0 | 0 | equal |
| model_runs | 1 | 1 | equal |
| human_surface_bytes | 12568 | 20520 | better |
| git_subprocesses | 177 | 290 | better |
| blocks | 0 | 0 | equal |
| latency (median of whole-journey time) | 2481.5 ms | 2552.1 ms | equal (ratio 0.97; p95 2951 ms vs 2560.3 ms) |

### high-risk-four-lens-group

Outcome projection: **equal**

| metric | odd | oracle | verdict |
| --- | --- | --- | --- |
| human_prompts | 2 | 1 | worse |
| manual_tokens | 12 | 6 | worse |
| commands_to_completion | 7 | 10 | better |
| recovery_round_trips | 0 | 0 | equal |
| model_runs | 4 | 4 | equal |
| human_surface_bytes | 40871 | 48019 | better |
| git_subprocesses | 233 | 547 | better |
| blocks | 0 | 0 | equal |
| latency (median of whole-journey time) | 2730.5 ms | 4806.8 ms | better (ratio 0.57; p95 2750.1 ms vs 4833.4 ms) |

### explicit-lens-selection-narrows-review

Outcome projection: **equal**

| metric | odd | oracle | verdict |
| --- | --- | --- | --- |
| human_prompts | 2 | 1 | worse |
| manual_tokens | 12 | 6 | worse |
| commands_to_completion | 5 | 6 | better |
| recovery_round_trips | 0 | 0 | equal |
| model_runs | 2 | 2 | equal |
| human_surface_bytes | 15080 | 24762 | better |
| git_subprocesses | 178 | 331 | better |
| blocks | 0 | 0 | equal |
| latency (median of whole-journey time) | 1945.7 ms | 2964.5 ms | better (ratio 0.66; p95 1991.3 ms vs 3255.1 ms) |

### resume-after-consent

Outcome projection: **equal**

| metric | odd | oracle | verdict |
| --- | --- | --- | --- |
| human_prompts | 2 | 1 | worse |
| manual_tokens | 12 | 6 | worse |
| commands_to_completion | 4 | 6 | better |
| recovery_round_trips | 0 | 0 | equal |
| model_runs | 1 | 1 | equal |
| human_surface_bytes | 5225 | 20175 | better |
| git_subprocesses | 130 | 267 | better |
| blocks | 0 | 0 | equal |
| latency (median of whole-journey time) | 1503.7 ms | 2396.9 ms | better (ratio 0.63; p95 1526.6 ms vs 2412.4 ms) |

### correction-then-validator-approves

Outcome projection: **equal**

| metric | odd | oracle | verdict |
| --- | --- | --- | --- |
| human_prompts | 3 | 1 | worse |
| manual_tokens | 17 | 6 | worse |
| commands_to_completion | 8 | 14 | better |
| recovery_round_trips | 0 | 0 | equal |
| model_runs | 5 | 6 | better |
| human_surface_bytes | 25846 | 60418 | better |
| git_subprocesses | 303 | 1128 | better |
| blocks | 0 | 0 | equal |
| latency (median of whole-journey time) | 3127.9 ms | 9781.4 ms | better (ratio 0.32; p95 3156.1 ms vs 9847.1 ms) |

### correction-noop-refused

Outcome projection: **equal**

| metric | odd | oracle | verdict |
| --- | --- | --- | --- |
| human_prompts | 2 | 1 | worse |
| manual_tokens | 12 | 6 | worse |
| commands_to_completion | 6 | 11 | better |
| recovery_round_trips | 0 | 0 | equal |
| model_runs | 4 | 5 | better |
| human_surface_bytes | 23490 | 41999 | better |
| git_subprocesses | 239 | 804 | better |
| blocks | 1 | 1 | equal |
| latency (median of whole-journey time) | 2524.9 ms | 7863.4 ms | better (ratio 0.32; p95 2552.7 ms vs 8601 ms) |

### gate-silent-with-rdd-off

Outcome projection: **equal**

| metric | odd | oracle | verdict |
| --- | --- | --- | --- |
| human_prompts | 0 | 0 | equal |
| manual_tokens | 0 | 0 | equal |
| commands_to_completion | 1 | 1 | equal |
| recovery_round_trips | 0 | 0 | equal |
| model_runs | 0 | 0 | equal |
| human_surface_bytes | 0 | 349 | better |
| git_subprocesses | 6 | 3 | worse |
| blocks | 0 | 0 | equal |
| latency (median of whole-journey time) | 205.4 ms | 35 ms | worse (ratio 5.87; p95 209.7 ms vs 35.2 ms) |

### gate-push-allowed-for-medium-risk-range

Outcome projection: **equal**

| metric | odd | oracle | verdict |
| --- | --- | --- | --- |
| human_prompts | 0 | 0 | equal |
| manual_tokens | 0 | 0 | equal |
| commands_to_completion | 1 | 1 | equal |
| recovery_round_trips | 0 | 0 | equal |
| model_runs | 0 | 0 | equal |
| human_surface_bytes | 0 | 340 | better |
| git_subprocesses | 28 | 3 | worse |
| blocks | 0 | 0 | equal |
| latency (median of whole-journey time) | 269.6 ms | 37.3 ms | worse (ratio 7.23; p95 350.9 ms vs 39.1 ms) |

### stop-reminds-once-per-session-and-candidate

Outcome projection: **equal**

| metric | odd | oracle | verdict |
| --- | --- | --- | --- |
| human_prompts | 0 | 0 | equal |
| manual_tokens | 0 | 0 | equal |
| commands_to_completion | 4 | 4 | equal |
| recovery_round_trips | 1 | 1 | equal |
| model_runs | 0 | 0 | equal |
| human_surface_bytes | 4374 | 4569 | equal |
| git_subprocesses | 144 | 200 | better |
| blocks | 3 | 3 | equal |
| latency (median of whole-journey time) | 1326.8 ms | 1622.4 ms | equal (ratio 0.82; p95 1331.1 ms vs 1717.8 ms) |

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
| git_subprocesses | 3 | 3 | equal |
| blocks | 0 | 0 | equal |
| latency (median of whole-journey time) | 182.5 ms | 35.7 ms | worse (ratio 5.11; p95 185.8 ms vs 35.8 ms) |

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
| latency (median of whole-journey time) | 642.8 ms | 524.7 ms | equal (ratio 1.23; p95 653.8 ms vs 536.5 ms) |

## Unsupported journeys

The oracle cannot express these (marked, never faked); they are not wins or losses.

| journey | reason |
| --- | --- |
| gate-push-denied-unreviewed-high-risk | 4.6.0 `review validate --gate` is non-deciding: for every candidate it reports delivery=unmanaged (allowed=false, repository policy decides), so the product has no delivery denial to compare |
| gate-push-allowed-after-receipt | 4.6.0 `review validate --gate` is non-deciding: for every candidate it reports delivery=unmanaged (allowed=false, repository policy decides), so the product has no delivery denial to compare |
| gate-push-allowed-when-declined | 4.6.0 `review validate --gate` is non-deciding: for every candidate it reports delivery=unmanaged (allowed=false, repository policy decides), so the product has no delivery denial to compare |
| gate-pr-open-denied-unreviewed | 4.6.0 `review validate --gate` is non-deciding: for every candidate it reports delivery=unmanaged (allowed=false, repository policy decides), so the product has no delivery denial to compare |
| gate-pr-open-allowed-after-receipt | 4.6.0 `review validate --gate` is non-deciding: for every candidate it reports delivery=unmanaged (allowed=false, repository policy decides), so the product has no delivery denial to compare |
| workspace-review-does-not-authorize-committed-range | 4.6.0 `review validate --gate` is non-deciding: for every candidate it reports delivery=unmanaged (allowed=false, repository policy decides), so the product has no delivery denial to compare |

## Declared divergences

Where the oracle legitimately behaves differently from the shared expectation. Declared findings, never counted as wins or losses; the raw numbers are shown for information.

| journey | divergence | human_prompts odd/oracle | commands odd/oracle |
| --- | --- | --- | --- |
| consent-declined-creates-no-review | step 4: a decline persists nothing; product default RDD mode is on (odd: off) | 1 / 1 | 4 / 6 |
| consent-never-answered-implicitly | product default RDD mode is on (odd: off) | 0 / 0 | 4 / 7 |
| duplicate-start-guard-during-correction | step 4: no duplicate-start guard; product default RDD mode is on (odd: off) | 2 / 1 | 7 / 12 |
| binding-drift-mid-run | step 3: frozen candidate review ignores later drift | 1 / 1 | 3 / 6 |
| binding-drift-after-consent-question | product default RDD mode is on (odd: off) | 1 / 1 | 3 / 5 |

## How to read

- `equal | better | worse | not_comparable` are from odd's point of view; lower is better for every metric. `not_comparable` means a side is unobservable, unsupported or divergent.
- Counts are exact by default; bytes and tokens tolerate 10%; latency uses the ratio of medians with the tolerance above. Details, derivations and limits: docs/bench.md.
