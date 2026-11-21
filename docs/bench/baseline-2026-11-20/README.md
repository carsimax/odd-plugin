# Baseline 2026-11-20: odd-claude vs upstream oracle

First full run of the efficiency bench (T5 of `odd/tasks/efficiency-bench.md`). Raw material for `../findings.md`.

## Command

```sh
npm run bench -- --subject both --repeat 3 --out <dir>
```

Exit 0, about 4 min 13 s. The report and `comparison.json` were re-rendered after T8 from the saved results, without rerunning (see "T8 re-render"). Both subjects ran in the same invocation on the same machine, each journey in fresh processes in its own sandbox.

## What it ran against

| fact | value |
| --- | --- |
| repeats (K) | 3 (friction must agree across repeats; latency is the median of 3 samples, p95 over the same 3) |
| journeys | 23 (comparable 10, divergent 5, unsupported 6, not comparable 2, missing 0; the 2 not comparable are the oracle gate-allow rows, see below) |
| odd | 2.0.0, `plugins/odd-claude/dist/mcp/review-server.js`, bench checkout commit `d0a30237455d` |
| plugin source | `plugins/odd-claude` as on main `56b5291`, i.e. before PR #15 (gate deadline fix). That fix only affects the gate's timing when git is slow, so it does not change these rows |
| oracle | upstream `gentle-ai` binary **4.6.0** (binary only, no commit); journeys were ported from sources pinned at 08317b9 (version skew, see `docs/bench.md`) |
| node | v26.12.1 |
| OS | darwin arm64, kernel release 27.2.0 |
| git | 2.56.0 (the sandbox shim counts the `git` calls each product spawns) |
| started | odd 2026-11-21T02:35:05Z, oracle 2026-11-21T02:37:27Z (UTC) |

These facts are recorded in each file's `meta` (`odd.json`, `oracle.json`); the git version was read separately.

## Files

| file | content | size |
| --- | --- | --- |
| `report.md` | the rendered comparison (summary, verdict table, per-journey tables, unsupported, divergences) | 14 KB |
| `comparison.json` | `odd-claude.bench-comparison/v1`, the data behind the report | 44 KB |
| `odd.json` | `odd-claude.bench-result/v1`, odd rows with every latency sample | 85 KB |
| `oracle.json` | `odd-claude.bench-result/v1`, oracle rows | 72 KB |

All are under the 200 KB bound, so they are kept whole. They contain the temp worktree path of the machine that ran the bench; the oracle binary path is written `~/...` (no username); nothing secret.

To rebuild the report from the saved results without running anything:

```sh
npm run bench -- --compare docs/bench/baseline-2026-11-20/odd.json docs/bench/baseline-2026-11-20/oracle.json --out <dir>
```

Reading of the numbers: `../findings.md`. Latency is a same-machine cost comparison of different surfaces (node hooks vs a native binary), not a quality one.

## T8 re-render

`oracle.json` was recorded before rows could carry `not_comparable`. Without rerunning anything, its two gate-allow rows (`gate-silent-with-rdd-off`, `gate-push-allowed-for-medium-risk-range`, where the 4.6.0 gate reports `delivery=unmanaged`) were annotated with the mark the bench now records itself, and the binary path was rewritten from an absolute home path to `~/.local/share/odd-claude-oracle/gentle-ai-4.6.0/bin/gentle-ai`. `report.md` and `comparison.json` were then rebuilt with `npm run bench -- --compare docs/bench/baseline-2026-11-20/odd.json docs/bench/baseline-2026-11-20/oracle.json --out docs/bench/baseline-2026-11-20`. Every measurement is as recorded; only those two rows leave the verdicts (comparable 12 -> 10).
