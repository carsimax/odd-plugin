# Hard eval tasks (round 2)

Six tasks for the harness eval runner (`bench/src/eval/`), built to avoid the ceiling effect of the pilot set in `bench/eval-tasks/` (`docs/eval/pilot-2026-11-25.md`). Plain Node ESM JavaScript, zero dependencies, `node --test`. Use them with `--tasks-dir bench/eval-tasks-hard`.

## Layout

```
bench/eval-tasks-hard/
  <id>/
    task.json   id, kind (bugfix|feature|refactor), size ("large"), difficulty, prompt, grade, checks, timeout_s
    repo/       the codebase the agent works on (package.json, README, src/, test/ with visible tests, sometimes docs/ and config/)
    hidden/     never shown to the agent, copied in only after it exits
      acceptance/   the requested behavior
      regression/   behavior the request did not ask to change, or the exact details of a spec the prompt points to
      support/      (async-notes only) a test double shared by both suites
  _reference/<id>/  correct solution: files that overlay repo/ at the same relative paths (tests and docs included)
  _naive/<id>/      plausible solution that satisfies the literal request and falls into the trap
  selfcheck.mjs
  README.md         this file; outside every repo/, so the agent never sees it
```

`task.json` `checks` is `{ "acceptance": "node --test hidden/acceptance/", "regression": "node --test hidden/regression/" }`; `grade` runs both directories. Hidden tests import `../../src/...` and use the public interface only. They are deterministic: no network, no timing.

## No-peeking rule

The runner copies only `repo/` into the agent workspace, and `hidden/` only after the agent finishes. It never copies `_reference/`, `_naive/` or this README, and nothing in a `repo/` may mention hidden tests, references or traps. Prompts state the outcome, never the trap. Do not read `hidden/`, `_reference/` or `_naive/` when working a task as the agent.

## Self-check

`node bench/eval-tasks-hard/selfcheck.mjs [taskId ...]` copies each task to a `mktemp -d` directory and proves, per task:

1. shipped `repo/`: visible tests PASS, acceptance FAIL;
2. `repo/` + `_reference/<id>/`: visible, acceptance, regression and the `grade` command all PASS;
3. `repo/` + `_naive/<id>/`: acceptance PASS and regression FAIL (a naive overlay that cannot pass acceptance means the task is too contrived).

It prints one line per task, then the regression tests the naive overlay fails, removes its temp directories and exits non-zero on any violation.

## Tasks

| id | kind | difficulty |
|---|---|---|
| invoice-rounding | bugfix | regression-trap |
| duration-report | feature | regression-trap |
| text-table | feature | precise-spec |
| commit-lint | feature | precise-spec |
| async-notes | refactor | multi-step |
| event-rename | refactor | multi-step |

### invoice-rounding (regression-trap, bugfix)

Task: half-cent amounts round down (`round(1.005, 2)` gives `1`) because of binary floating point.
Trap: `round()` is shared by invoices, tax, shipping and credit notes. `repo/README.md` documents that negative amounts (credit notes) round half toward +Infinity (`-0.125` becomes `-0.12`). The tempting fix, rounding the absolute value and restoring the sign, passes every positive case and flips negative halves. The correct fix keeps `Math.round` semantics (trim the product to 15 significant digits first).
Acceptance: positive half cents in `round`, `lineTotal`, `invoiceTotal`, `summarize`. Regression: negative halves, credit notes (amounts and tax), a discount that makes the taxable amount negative, and unchanged positive/shipping/tax values.
Naive: sign-symmetric `round()` in `src/round.js`.

### duration-report (regression-trap, feature)

Task: show durations of an hour or more as `1h 02m 03s` in the report and summary.
Trap: the report, summary and slow-task alerts all call `formatDuration`. `repo/README.md` says alert lines are scraped by a pager rule and must keep the minutes-only format (`took 62m 03s`). Changing `formatDuration` globally changes alerts too. The correct change is opt-in (an option, or a second function) used only by the report and summary.
Acceptance: hours in report, summary and the CLI `report`/`summary` commands. Regression: alert text for tasks over an hour (library and CLI `alerts`), the pager regexes, and sub-hour output everywhere.
Naive: `formatDuration` itself gains the hours form.

### text-table (precise-spec, feature)

Task: implement `renderTable` per `docs/SPEC.md` (the prompt points to the spec; helpers already exist).
Trap: the spec has many exact details a hurried implementation skips. Acceptance checks the main layout (header, separator, alignment, widths, titles, missing keys; trailing spaces are trimmed before comparing). Regression is the separate sub-score for the spec details: trailing spaces removed, `(no rows)`, truncation with `…` and the `maxWidth` rules, cell text rules (null, yes/no, UTC dates, `⏎`, tabs), code point widths, default alignment corner cases, and every `TableError` message and check order.
Naive: renders the gist with `...` truncation, no trailing trim, a header on empty input, no cell text rules, and loose error messages.

### commit-lint (precise-spec, feature)

Task: implement `lintCommit` per `docs/SPEC.md`.
Trap: eight rules with exact messages, a fixed ordering (line, then rule order), exemptions (single URL lines, `#` comments from line 2) and subtle conditions (subject rules only when the format matches, period check ignores trailing whitespace, code point lengths). Acceptance checks only which rule fires on which line; regression checks the exact objects, messages, ordering and exemptions.
Naive: all eight rules, but `header-length` and `body-line-length` messages lack the numbers, header length counts UTF-16 units, no URL or comment exemption, trailing-whitespace and period details differ, blank-header handling differs.

### async-notes (multi-step, refactor)

Task: make the Store interface async (`get`, `set`, `has`, `delete`, `keys` return promises) and update every user of it.
Trap: the services, commands and CLI are obvious (they call `store.get(...)`). `src/batch.js` is not: `applyOps` dispatches by string, `store[op.type](...op.args)`, so a search for `store.get` finds nothing, and it keeps returning an array of promises. The `import` command depends on it, so it silently treats every note as already imported.
Acceptance: the Store returns promises; notes, tags, stats and CLI commands work on a store that is really asynchronous (`hidden/support/slow-store.js`). Regression: `applyOps` results and errors, and the `import` command, on both `MemoryStore` and the slow store.
Naive: everything migrated except `src/batch.js`.

### event-rename (multi-step, refactor)

Task: rename the event `order.created` to `order.placed` everywhere.
Trap: a search and replace of `order.created` over `src/` renames the emitter and the listeners in inventory and notifications. Two sites do not contain the literal: `src/analytics.js` builds names from `entity` and `verb` (`"created"` in a table) and `config/webhooks.json` is a string-keyed subscription config read at load time. Both stop reacting, silently.
Acceptance: the bus emits `order.placed` (and not `order.created`), the wildcard, inventory and notifications. Regression: analytics counts and snapshot, webhook deliveries, and nothing reacts to the old name.
Naive: `order.created` replaced in `src/` only (orders, inventory, notifications).
