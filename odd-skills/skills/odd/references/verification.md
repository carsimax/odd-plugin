# Verification

Load when the Verification trigger fires or a writer returns.

| Tier | Verification |
|---|---|
| passive (docs) | structural readback by the parent; no tests |
| medium | writer self-verification stands; no separate verifier |
| high | a `Risk: item N` naming a high-risk item: self-verification plus one `odd-verify` run |

The parent's spot check (re-run one reported command) is required in every tier. The change's own focused test and suite run in the session that made it. A code review never replaces functional checks (tests, builds, browser checks for UI), and review outcomes never authorize delivery.

## Protocol

1. Self-review in the writer's own session before returning: spec sections by reference, authorized examples, tests, typecheck; fix and continue.
2. Independent verify per high-risk unit, once, after final self-review, in parallel when several finish together. Parent-written code over several deliveries: one verify at the feature's end.
3. Seam check: after parallel units, the parent runs one full-suite command.
4. Verify handoff: pass the artifact (diff, baseline commit) and the contract (whole feature document, assigned unit, linked `S#`, affected interactions), never the writer's conclusions; keep contradicting evidence; include the writer's reported commands; give probe command forms and require probes on isolated state in a fresh `mktemp -d` copy. For a user-reported failure pass verbatim its failing command, error text, versions and configuration. Run yourself any real-case check the verifier left unverified. Future or unrelated requirements are out of scope.
5. One correction: blockers get one correction batch fixing all of them, then one re-verify limited to those blockers. Advisories never start a correction. A second correction only if the same blocker still fails; a new finding never earns one. Leftover blockers leave the unit `partial`.

## Setup failure and missing proof

A failed verifier setup is a preparation failure: the verifier gets one self-fix; if still failing, name the blocker and the unrun checks as unverified and stop; relaunch once with a corrected command at most. When required proof is unobtainable, close as `status: partial` naming the missing proof; never PASS. Do not add auxiliary gates without an acceptance criterion, concrete threat or authoritative contract behind them.

## Completion gate

| Claim | Requires | Not enough |
|---|---|---|
| tests pass | full run output, zero failures | a run before the last edit |
| build ok | build exit code 0 | clean lint or typecheck |
| bug fixed | original failing case now passing | code changed |
| requirement met | each `S#` checked against its example | tests passing |
| delegated work done | the diff and one re-run command | the worker's summary |
| regression test valid | seen failing without the fix, then passing | green on first run |
