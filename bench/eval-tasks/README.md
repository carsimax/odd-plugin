# Eval tasks

Real coding tasks for the harness eval runner (`bench/src/eval/`). Plain Node ESM JavaScript, zero dependencies, `node --test`.

## Layout

```
bench/eval-tasks/
  <id>/
    task.json   id, kind (bugfix|feature|refactor), size (small|medium), prompt, grade, timeout_s
    repo/       the codebase the agent works on (package.json, README, src/, test/ with visible tests)
    hidden/     acceptance tests the agent never sees (copied in only after the agent exits)
  _reference/<id>/   reference solution: files that overlay repo/ at the same relative paths
  selfcheck.mjs
```

`grade` runs from the workspace root after `hidden/` is copied to `<workspace>/hidden/` (for example `node --test hidden/`). Hidden tests import from `../src/...` and use only the public interface. They are deterministic: no network, no timing.

## No-peeking rule

The runner copies only `repo/` into the agent workspace, and `hidden/` only after the agent finishes. It never copies `_reference/`, and nothing in `repo/` may mention hidden tests or reference solutions. Prompts state the outcome, not the solution. Do not read `hidden/` or `_reference/` when working a task as the agent.

## Self-check

`node bench/eval-tasks/selfcheck.mjs [taskId ...]` copies each task to a `mktemp -d` directory and verifies:

1. shipped `repo/` passes its visible tests and FAILS the hidden tests;
2. `repo/` with the `_reference/<id>/` overlay passes visible and hidden tests.

It prints a table, removes its temp directories, and exits non-zero on any mismatch.

## Tasks

| id | kind | size |
|---|---|---|
| range-merge-bug | bugfix | small |
| csv-quoted-fields | feature | small |
| token-bucket-extract | refactor | small |
| inventory-orders-bug | bugfix | medium |
| config-layers | feature | medium |
| ledger-money | refactor | medium |
