# Baseline 2026-11-21: odd-claude 2.1.0 vs upstream oracle

Re-run of the efficiency bench after the 2.1.0 changes (RDD-off fast path and hook start-up work). Raw material for the "2.1.0 re-run (2026-11-21)" section of `../findings.md`. The previous run is `../baseline-2026-11-20/`.

## Command

```sh
npm run bench -- --subject both --repeat 3 --out <dir>
```

Both subjects ran in the same invocation on the same machine, each journey in fresh processes in its own sandbox.

## What it ran against

| fact | value |
| --- | --- |
| repeats (K) | 3 |
| journeys | 23 (comparable 10) |
| odd | 2.1.0 at main `a813872` (commit `a813872d27d8`) |
| oracle | upstream `gentle-ai` binary **4.6.0** (binary only); journeys ported from sources pinned at 08317b9 |
| node | v26.12.1 |
| OS | darwin arm64, kernel release 27.2.0 |
| started (UTC) | odd 2026-11-22T00:31:02Z, oracle 2026-11-22T00:33:13Z (the directory name uses the local date) |

## Files

| file | content |
| --- | --- |
| `report.md` | the rendered comparison |
| `comparison.json` | `odd-claude.bench-comparison/v1` |
| `odd.json` | `odd-claude.bench-result/v1`, odd rows with every latency sample |
| `oracle.json` | `odd-claude.bench-result/v1`, oracle rows |
| `confirm-k10.report.md` | confirmation run, K=10, only `rdd-mode-global-and-clone-scopes` and `stop-silent-with-rdd-off` |

Files are kept byte for byte as the bench wrote them. Paths in them are already written `~/...` (no username, no temp directory), the same convention as the 2026-11-20 baseline; no placeholder substitution was needed.

## Confirmation run (K=10)

`rdd-mode-global-and-clone-scopes`: 877.4 ms vs 706.6 ms, ratio 1.24, equal (it was 1.30 at K=3). `stop-silent-with-rdd-off`: 80.3 ms vs 40.3 ms, ratio 1.99, the node start floor (see `../hook-startup.md`).

To rebuild the report from the saved results:

```sh
npm run bench -- --compare docs/bench/baseline-2026-11-21/odd.json docs/bench/baseline-2026-11-21/oracle.json --out <dir>
```
