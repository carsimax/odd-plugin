# cds verification: tiers and handoff

Applies to the main session when a writer returns or a change names a high-risk item.

## Tiers

| Tier | Verification |
|---|---|
| passive (docs, text) | your own readback; no verifier, no tests |
| medium | the writer's self-verification stands; no separate verifier |
| high | only when the Risk line names a high-risk item: writer self-verification plus one `cds-verify` run |

The writer runs the exact commands under `## Verification`, in the foreground, and reports each as `<command>: <observed result>`. Exact pre-existing failures listed under `## Known environmental failures` are evidence, not blockers; any other failing required command makes the report `partial`. Re-run one reported command yourself as a spot check before delivery. A code review never replaces functional checks.

The independent verifier never runs because of size, duration or which model wrote the change.

## Verifier handoff

Pass the artifact (diff and baseline commit) and the contract (feature document, the unit's `S#`), never the writer's conclusions. Include the probe commands (tests, CLI, typecheck) to run against a copy in a temporary directory (`mktemp -d`), never against real user data. Run yourself any real-case check the verifier leaves unverified.

## Corrections

- Self-review: before returning, the writer checks each `S#`, the authorized examples, tests and typecheck. One correction per failing check; a second only if the same check still fails; then `partial`.
- Verify blockers get one correction batch, then one re-verify limited to those blockers. Advisories never start a correction. A new finding never earns another correction.
- Blockers still open leave the unit `partial`, naming any human decision; independent work continues.
- If a verifier cannot be set up or is unavailable, report the exact unrun checks as unverified; never call it a pass.

## Test-first

When a runnable deterministic test exists, observe RED before implementing, then GREEN, then refactor. Each test asserts every observable effect of its rule (output, exit code, stored data unchanged on rejected input), covers the cases the rule names, and uses the public interface. For every existing command or option the change touches, add one PRESERVE test proving its previous behavior holds. When the diff changes shared code that an unnamed command also uses, compare that command's output and exit code between the base commit (a copy in a temporary directory, never committed) and your change. Keep test temporary state outside the worktree. Never weaken tests to reach green, and never claim RED or GREEN you did not observe.
