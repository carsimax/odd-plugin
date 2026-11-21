# Efficiency findings: is odd-claude as efficient as upstream?

Source: baseline `docs/bench/baseline-2026-11-20/` (K=3, odd 2.0.0 at plugin main 56b5291, oracle `gentle-ai` 4.6.0, darwin arm64, node v26.12.1). Question (S2, user, verbatim): "La idea de hacer los evals es que sea igual de eificiente que el uptream".

## Short answer

On the 12 journeys both sides can express, **odd is as efficient or better in 6 of 9 dimensions, and not in 3**:

- Better or equal: commands, recovery round trips, model runs, bytes shown, blocks, and overall latency (median ratio 0.90, odd faster).
- Worse: human prompts and manual tokens (one extra approval per review run), and git subprocesses in 2 journeys.
- Of those, the two git rows and the three slow-latency rows are **not a fair comparison** (the oracle's gate evaluates nothing, see below). Only the prompt cost is a real, by-design difference, and it is parity with the Pi harness odd ports.
- 11 of 23 journeys are excluded from every verdict (6 unsupported, 5 divergent). The result says nothing about them.

The verdict rule in `report.md` is strict (`less_efficient` as soon as one comparable journey is worse), so "less efficient in 3 dimensions" there is a headline of the rule, not of the magnitude. Totals over comparable journeys: git 1512 vs 3698, bytes 130868 vs 231454, commands 52 vs 72, model runs 17 vs 19.

## Verdict per dimension

| dimension | report verdict | equal / better / worse | totals odd vs oracle | honest reading |
| --- | --- | --- | --- | --- |
| human_prompts | less_efficient | 6 / 0 / 6 | 13 vs 6 | Real, by design: one cost-forecast approval per reviewer run. Parity with Pi, gap vs the 4.6.0 CLI |
| manual_tokens | less_efficient | 6 / 0 / 6 | 77 vs 36 | Same cause (proxy: bytes/4 of the human text) |
| commands_to_completion | at_least_as_efficient | 5 / 7 / 0 | 52 vs 72 | odd starts and inspects in one call; the oracle needs a status preflight |
| recovery_round_trips | at_least_as_efficient | 12 / 0 / 0 | 1 vs 1 | Identical |
| model_runs | at_least_as_efficient | 10 / 2 / 0 | 17 vs 19 | Equal on reviewers; odd saves one run in two correction journeys |
| human_surface_bytes | at_least_as_efficient | 2 / 10 / 0 | 130868 vs 231454 | odd is about 43% less verbose (verbosity, not usefulness) |
| git_subprocesses | less_efficient | 1 / 9 / 2 | 1512 vs 3698 | 9 better; the 2 worse are gate allow rows that are not comparable |
| blocks | at_least_as_efficient | 12 / 0 / 0 | 4 vs 4 | Identical |
| latency (median of ratios) | at_least_as_efficient | 4 / 5 / 3 | ratio 0.90 | Faster overall; 3 slow rows are short hook calls |

## Cells that are worse

### 1. human_prompts / manual_tokens (6 journeys)

Journeys: `medium-risk-one-lens-consent-capture-ack` 2 vs 1, `high-risk-four-lens-group` 2 vs 1, `explicit-lens-selection-narrows-review` 2 vs 1, `resume-after-consent` 2 vs 1, `correction-then-validator-approves` 3 vs 1, `correction-noop-refused` 2 vs 1. Tokens: 12 vs 6 (17 vs 6 for the correction journey). Every journey that does not run a reviewer is equal (0 vs 0).

Cause (evidence from the rows): the extra prompt appears exactly in the journeys that run reviewers. In odd the first capture of a slot or group returns a cost forecast and runs nothing; the human must approve it and the same binding is resubmitted with `reviewer_run_acknowledged: true` (bench: `bench/src/subjects/odd.ts:202-205`). The correction journey has two such approvals (the review and the validator batch), hence 3 prompts. The oracle 4.6.0 CLI runs its reviewers in process after the consent answer, with no forecast, so its only prompt is the consent.

Is it parity or a gap? **Parity with the Pi harness; a gap only against the 4.6.0 CLI.** Read-only evidence in `upstream/gentle-shell`:

- `contracts/review-provider-contract-mirror/v1.6.0/bundle/orchestration/pi.md:30-34` (section "Consent and forecast"): the first capture of a materialize slot or group "returns a `forecast` and runs nothing: relay it losslessly ... then resubmit the same exact binding with `reviewerRunAcknowledged: true`".
- `tests/review-host-relay-routing.test.ts:244-257, 510-527`: the Pi host relay returns `outcome: "reviewer-model-run-forecast"` with `cost_forecast { transport: "pi_host_relay", model_runs: 4, lenses }` before running four reviewers.

odd ports the Pi host relay, where reviewers are model runs billed to the user's session. The CLI has no equivalent step because it spawns reviewers itself. So the difference is a deliberate safety step inherited from the reference, not an odd regression. Whether it is the right friction for Claude Code is a product decision (proposal B below). Not verified: how often the Pi flow asks for it in practice; this bench only shows one forecast per run.

### 2. git_subprocesses worse in two gate rows

| journey | odd | oracle | latency odd / oracle |
| --- | --- | --- | --- |
| `gate-silent-with-rdd-off` | 6 | 3 | 205.4 ms / 35.0 ms (5.87x) |
| `gate-push-allowed-for-medium-risk-range` | 28 | 3 | 269.6 ms / 37.3 ms (7.23x) |
| `stop-silent-with-rdd-off` (latency only; git 3 vs 3) | 3 | 3 | 182.5 ms / 35.7 ms (5.11x) |

**Comparability: no.** Per L7 of the task doc, 4.6.0 `review validate --gate` is non-deciding: for every candidate it reports `delivery=unmanaged` and leaves the decision to the repository's policy. That is why 6 gate journeys that need a denial are `unsupported`. The two that "run" are allow-only, and the oracle's allow costs almost nothing because it evaluates nothing: 3 git calls, about 340-350 bytes of "unmanaged" text, 35-37 ms, whatever the range. The bench currently marks them `comparable` because both sides return "allow"; that is a bench flaw (proposal C), not evidence that odd is slower at the same work.

What odd does in that time:

- **RDD off (6 git calls).** Reading `gate.ts:759` `resolveRepository(dir)` spends 3 calls (`rev-parse --show-toplevel`, `--absolute-git-dir`, `--git-common-dir`, `snapshot.ts:311-333`). Then `gate.ts:791` `readReviewMode(root)` runs `locateCommonDir` (`mode.ts:169`), which calls `resolveRepository` again: 3 more. 3 + 3 = 6, matching the measurement. Nothing is cached between the two. The mode read itself is the cost.
- **Medium range (28 calls).** The same 6, then `evaluateRoot` probes HEAD, the branch, remote config and base refs, `merge-base`, `rev-list --count`, then `resolveRepository` a third time (`gate.ts:688`) and `assessCandidate` (diff statistics) to decide the range is not due. This is real evaluation: odd decides "medium is not due"; the oracle decides nothing.
- **Why the ratio is so high even for RDD off.** The Stop hook with RDD off does the same 3 git calls as the oracle and still takes 182.5 ms vs 35.7 ms. A bare `node -e 0` on this machine costs about 70 ms, so roughly 110 ms or more of each odd hook call is node start plus module loading (the hook entrypoint imports every handler, `hooks/run.ts:5-12`), not git. The gate with RDD off adds only about 23 ms over Stop for its 3 extra git calls. So a git fast path saves little wall time (see A); the dominant cost is process start, which is a different, unmeasured lever (proposal D).

Honest conclusion: in these two rows odd does more work than the oracle, but the oracle does not do the same work. The 6 vs 3 for RDD off is a real and cheap waste (double repository resolve). The 28 vs 3 for medium is mostly necessary work.

### 3. Latency overall

12 journeys compared: equal 4, better 5, worse 3, median ratio **0.90** (limit 1.25). p95 is over 3 samples, so it is a max in practice.

| | journey | odd | oracle | ratio |
| --- | --- | --- | --- | --- |
| best | `correction-then-validator-approves` | 3127.9 ms | 9781.4 ms | 0.32 |
| best | `correction-noop-refused` | 2524.9 ms | 7863.4 ms | 0.32 |
| best | `high-risk-four-lens-group` | 2730.5 ms | 4806.8 ms | 0.57 |
| best | `resume-after-consent` | 1503.7 ms | 2396.9 ms | 0.63 |
| best | `explicit-lens-selection-narrows-review` | 1945.7 ms | 2964.5 ms | 0.66 |
| near edge, equal | `rdd-mode-global-and-clone-scopes` | 642.8 ms | 524.7 ms | 1.23 |
| near edge, equal | `low-risk-closes-with-zero-lenses` | 993.2 ms | 883.6 ms | 1.12 |
| worst | `gate-push-allowed-for-medium-risk-range` | 269.6 ms | 37.3 ms | 7.23 |
| worst | `gate-silent-with-rdd-off` | 205.4 ms | 35.0 ms | 5.87 |
| worst | `stop-silent-with-rdd-off` | 182.5 ms | 35.7 ms | 5.11 |

Odd wins on the long journeys (many git calls and process starts on the oracle) and loses on one-shot hooks, where fixed process start dominates and the oracle is a native binary. In absolute terms the worst rows cost 150-230 ms more per hook call; a push gate or a Stop hook is paid once per command, not per journey. Different surfaces: this is a same-machine cost comparison, not a quality one.

## Gaps and proposals

None of these is implemented here. Each needs its own task (T6+ in `odd/tasks/efficiency-bench.md`).

| id | proposal | expected impact | effort | risk | changes behavior? |
| --- | --- | --- | --- | --- | --- |
| A | Gate fast path when global RDD is not on: skip git entirely | Removes 6 of 6 git calls and about 20-25 ms in the RDD-off gate (about 10% of 205 ms); also the 3 calls in the RDD-off Stop hook if applied there. Most users have RDD off (the default), so this is the common case | small (one early return plus tests) | low, if done as below | Decision: no. Only the allow reason label changes (`not_a_repository` -> `rdd_off`) where cwd is not a repository |
| B | Optional auto-approve of small reviewer forecasts | Would bring human prompts to parity with the CLI for small runs (1 lens) | medium | medium: removes a cost-consent step the reference deliberately has | **Yes. Product decision for the user; not recommended or decided here** |
| C | Bench: mark the oracle gate allow rows `not_comparable` when the oracle reports `unmanaged` | Removes 2 false "worse" git cells and 2 false latency "worse" cells from the verdict; the git verdict would become at_least_as_efficient | small (bench change) | low | No product change; changes verdict output |
| D | Measure and cut hook start-up (module load) | Targets the real cause of the 5-7x one-shot ratios: roughly 110 ms of 182 ms in Stop. Candidate: lazy-load handlers per event, or a bundle per hook | medium | medium (hook entry wiring, fail-safe behavior must hold) | No, if only load order changes |

### A. Exact proposal (verified by reading `gate.ts` and `mode.ts`, not by running it)

Effective mode is on only when `global === "on"` and the clone is neither `off` nor `unreadable` (`mode.ts` `resolveStatus`, `mode.ts:207-213`). A clone override can only disable, so **with global unset or off the result is off whatever the clone says, and no git call is needed to know it.**

1. Add to `mode.ts` an export that reads only the global switch (`readGlobal`, no git), e.g. `globalMayBeOn(opts): boolean` returning `readGlobal(opts) === "on"`. Do not change `readReviewMode`, so the `status` output (`cloneLocal`, `problems`) stays byte-identical.
2. In `checkDelivery` (`gate.ts`), after the `deliveries.length === 0` check and before the `groups` loop: if `!globalMayBeOn(opts)` return `{ allowed: true, reason: "rdd_off" }`. This skips `resolveRepository` (`gate.ts:759`) and `readReviewMode` (`gate.ts:791`).
3. Same early return in `hooks/stop.ts` before line 103 (global not on -> `undefined`).
4. Also remove the duplicate resolve for RDD on (cheap, independent): pass the already resolved `commonDir` to the mode read instead of resolving it again (6 -> 3 calls on the on path). Optional.
5. Tests: global unset and global off with a repository, a non-repository cwd and an untrusted repository all give allow with zero git calls (use the `git` test seam); global on keeps every existing result. Existing `gate.spec.ts` cases that expect `not_a_repository` with global unset (for example around `gate.spec.ts:888-965`) must be checked: either they set global on, or the label expectation changes to `rdd_off`. Decisions are unchanged (all allow).

Caveat to state in the task: A fixes the 6 vs 3 count (becomes 0 vs 3) but moves the 205 ms latency only slightly; it does not close the 5.9x ratio on its own (that is D).

## Limits of this baseline

- K=3 per journey; p95 is the max of 3 samples. One run on one machine; noise was visible (for example 350.9 ms vs a 269.6 ms median in the medium gate row).
- 11 of 23 journeys excluded from verdicts (6 unsupported because 4.6.0 has no deciding gate; 5 divergent by declared behavior). Notably, **gate denial efficiency is not measured at all** against the oracle.
- Oracle is 4.6.0, journeys were ported from 08317b9.
- Reviewer outputs are synthesized; model quality and real model cost are out of scope. `model_runs` counts runs, not tokens or money.
- `git_subprocesses` counts only calls through the sandbox `PATH` shim.
