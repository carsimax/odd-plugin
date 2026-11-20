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
invocations and forwards to the real git; `claude` is a fake that counts and prints canned text, so no model runs. Every MCP
operation and hook runs in a fresh process.

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
