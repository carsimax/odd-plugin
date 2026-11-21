# Hook start-up latency (T9, proposal D)

Question: how much of a hook call is node start, how much is loading the hook's module graph, and how much is the handler? Measured with
`npm run bench:hooks` (dev-only: `bench/src/hookstart.ts`, driver `bench/src/hookphase.ts`), machine darwin arm64, node v26.12.1.
Method: per case the median of fresh processes (a warm-up round first, then N rounds interleaved across cases so machine drift hits every case alike),
offline (own HOME and data dir, no git repository, no model, RDD off everywhere). Columns:

- `node -e 0`: a bare node process, same machine and round.
- `total`: wall time of the real call `node dist/hooks/run.js <event>` with the hook JSON on stdin.
- `node boot`: `performance.now()` when a driver process starts running (node bootstrap, no hook code yet).
- `module load`: importing the hook's module graph, plus (lazy build) the dynamic import of the handler on first dispatch.
- `handler (warm)`: the same event dispatched a second time in the same process (modules already loaded): the handler alone.
- `modules` / `review modules`: files the process loaded (via `module.registerHooks`) / those under `dist/review/`.

```sh
npm run bench:hooks -- --runs 25 --out /tmp/hooks.json                      # the current build
npm run bench:hooks -- --runs 25 --run-js /path/to/other/dist/hooks/run.js  # another build (e.g. a `git archive` of a past commit)
```

## Finding (it corrects the estimate in `findings.md`)

`findings.md` guessed that "roughly 110 ms or more" of a 182 ms Stop call was node start plus module loading. Measured here, module loading was
about **10 ms** and the handler under **2 ms**; a bare `node -e 0` is **~70 ms** (68-78 ms between rounds) and is the floor of every hook call. The rest of
the 182 ms in the bench was process-spawn and pipe overhead of that harness, not module graph cost. So the lever of proposal D is real but small:
the most it can remove is the ~10 ms above the node floor.

## Before (HEAD 9718374: `run.js` imports every handler eagerly), median of 25

| case | node -e 0 | total | over node | node boot | module load | handler (warm) | modules | review modules |
|---|---|---|---|---|---|---|---|---|
| PreToolUse (Bash, not a delivery) | 73.5 | 81.7 | 8.2 | 11.1 | 9.8 | 0.0 | 45 | 13 |
| PreToolUse (delivery, RDD off) | 73.5 | 81.1 | 7.6 | 11.3 | 9.8 | 0.0 | 45 | 13 |
| Stop (RDD off) | 73.5 | 82.0 | 8.5 | 10.9 | 9.9 | 0.3 | 45 | 13 |
| PostToolUse | 73.5 | 82.2 | 8.7 | 11.0 | 9.5 | 0.8 | 45 | 13 |
| SessionStart | 73.5 | 85.0 | 11.5 | 11.3 | 12.5 | 1.5 | 45 | 13 |
| UserPromptSubmit | 73.5 | 89.0 | 15.5 | 11.5 | 10.8 | 1.4 | 45 | 13 |

## After (lazy dispatch: `run.js` is a thin entry; `lazy.js` imports only the event's handler), median of 25

| case | node -e 0 | total | over node | node boot | module load | handler (warm) | modules | review modules |
|---|---|---|---|---|---|---|---|---|
| PreToolUse (Bash, not a delivery) | 69.9 | 73.8 | 3.9 | 11.1 | 3.2 | 0.0 | 6 | 3 |
| PreToolUse (delivery, RDD off) | 69.9 | 73.2 | 3.3 | 10.5 | 3.2 | 0.0 | 6 | 3 |
| Stop (RDD off) | 69.9 | 74.7 | 4.8 | 11.7 | 3.9 | 0.3 | 7 | 3 |
| PostToolUse | 69.9 | 75.0 | 5.1 | 10.9 | 3.3 | 0.6 | 9 | 0 |
| SessionStart | 69.9 | 81.9 | 12.0 | 11.5 | 7.7 | 1.5 | 22 | 0 |
| UserPromptSubmit | 69.9 | 80.5 | 10.6 | 11.1 | 4.3 | 1.2 | 13 | 0 |

"Over node" is `total - node -e 0` of the same round. The two tables were taken back to back, but the `node -e 0` floor moved by ~4 ms between them
(machine noise), so compare the "over node" and "module load" columns rather than the absolute totals. Module load fell from ~10 ms to 3-4 ms for
PreToolUse, Stop, PostToolUse (SessionStart 12.5 to 7.7, UserPromptSubmit 10.8 to 4.3); modules loaded fell from 45 to 6-22. The remaining 3 review modules
for PreToolUse and Stop are `mode`, `snapshot` and `canonical`, which the global RDD switch check needs.

## What changed (behavior identical)

- `dist/hooks/run.js` is still the entry that `hooks.json` runs; when run as the entry it dispatches through `lazy.js`, which dynamically imports only the handler of the
  event. When `run.js` is imported (tests, tools) it still exposes the same eager `defaultHandlers` and `runHook`, loaded from `handlers.js`.
- PreToolUse and Stop first check the global RDD switch (`isGlobalModeOn`, the T6 guard: a clone override can only disable). Not on: the gate allows and Stop stays silent,
  so the gate, the settle engine and `risk`/`status`/`start`/`consent`/`ack` are never loaded. On: the full handler runs unchanged.
- `hooks.json` (commands and timeouts) is untouched. The hook output is byte-identical (`lazy.spec.ts` compares `runHook` and `runHookLazy` for every event, global RDD off and on).
- The contract "a cheap event does not load the review engine nor another event's handler" is pinned by `lazy-load.spec.ts`, which spawns the real entry under a
  module-load probe (`node:module` `registerHooks`; the test skips on a Node without it).

## What stays (not worth chasing)

The ~70 ms node start is outside the plugin's control (hooks.json runs `node`). SessionStart and UserPromptSubmit still load 22 and 13 modules because their handlers use them
(context, persona, integrations, stats, ...); cutting that further would mean bundling or restructuring those libraries for under 10 ms and was not justified by the data.
