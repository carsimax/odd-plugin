# Applicable Test-First Development

Test-first is a policy, not a switch: there is no mode to enable.

For behavior changes with applicable runnable deterministic tests and a clear expected outcome, use it by default:

1. RED: add the smallest behavior-level test before implementation; run it and capture the intended observed failure. A test file merely existing is not proof of applicability or RED.
2. GREEN: implement the minimum behavior and run the focused test to observe it passing.
3. TRIANGULATE: exercise relevant alternate or negative cases that protect the contract; no arbitrary case counts.
4. REFACTOR: improve clarity without changing behavior and rerun the focused checks.

Each test asserts every observable effect of the rule it covers (output, exit code, persisted data), covers the cases the rule itself names, and goes through the public interface. For every existing command or option the change touches, add one test proving its previous behavior still holds (PRESERVE). When you add or change a command, option or message, update the help text and docs.

For passive documentation, non-testable changes, an unavailable runner, or no meaningful RED, record why test-first is inapplicable and run proportionate ordinary verification instead. Never fabricate RED or GREEN, and never skip applicable checks. A missing runner is an evidence limitation to report, not a reason to ask for a mode toggle.
