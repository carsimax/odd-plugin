# Baseline 2026-11-20: odd-claude vs upstream oracle

First full run of the efficiency bench (T5 of `odd/tasks/efficiency-bench.md`). Raw material for `../findings.md`.

## Command

```sh
npm run bench -- --subject both --repeat 3 --out <dir>
```

Exit 0, about 4 min 13 s. Both subjects ran in the same invocation on the same machine, each journey in fresh processes in its own sandbox.

## What it ran against

| fact | value |
| --- | --- |
| repeats (K) | 3 (friction must agree across repeats; latency is the median of 3 samples, p95 over the same 3) |
| journeys | 23 (comparable 12, divergent 5, unsupported 6, missing 0) |
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

All are under the 200 KB bound, so they are kept whole. They contain absolute paths of the machine that ran the bench (home of the oracle binary, the temp worktree); nothing secret.

To rebuild the report from the saved results without running anything:

```sh
npm run bench -- --compare docs/bench/baseline-2026-11-20/odd.json docs/bench/baseline-2026-11-20/oracle.json --out <dir>
```

Reading of the numbers: `../findings.md`. Latency is a same-machine cost comparison of different surfaces (node hooks vs a native binary), not a quality one.
