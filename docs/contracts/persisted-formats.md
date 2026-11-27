# Persisted formats (frozen contracts)

Phase 1 of `docs/roadmap-v10-python.md`: every format below is a contract the Python port must read (and, where it writes, reproduce). Fixtures were captured from the TypeScript v9 implementation by `test-fixtures/contracts/capture.mjs` and are asserted by `plugins/odd-claude/src/contract/persisted-formats.spec.ts` (part of `npm run test:contract`).

Capture command (from `plugins/odd-claude`; needs the build first, and writes only to `test-fixtures/contracts/`):

```
npm run build && npm run build:test && node ../../test-fixtures/contracts/capture.mjs
```

The script runs the resolver's entries (`impl.testkit.js`: hook runner, `coordinator`, `review-mode`, `status`, `stats`, `retro`, `tasks`, `installer`, the review server through the harness testkits) in a `mktemp -d` sandbox with its own `HOME`, data dir and git repos, with a fake `claude` first on `PATH`; the real `~/.claude`, `~/.odd-claude` and data dir are never touched, and it imports no product module. Normalization, everywhere except Review store: the sandbox path becomes `<SANDBOX>` and every ISO-8601 UTC timestamp becomes `<TIMESTAMP>`. A spec plants a fixture by substituting `<SANDBOX>` with its own sandbox and `<TIMESTAMP>` with a fixed instant. Session id is the fixed `sess-contract-0001` (not normalized).

In every section `<dataDir>` is the resolved data dir (see Data dir env). File names use `safeSegment(id)`: every character outside `[A-Za-z0-9_-]` becomes `_`, truncated to 128 characters, empty becomes `_`.

## Session state

- Path: `<dataDir>/sessions/<id>.json`; lock file `<id>.json.lock` during read-modify-write; written atomically (tmp file in the same dir, then rename); pruned after 7 days of mtime unless locked.
- Schema: envelope `{"version": 1, "sessionId": <string>, "data": <object>}`, 2-space JSON plus a trailing newline. `STATE_SCHEMA_VERSION = 1` (`src/lib/state.ts:10`). A file with another `version`, a non-object `data` or invalid JSON reads as `{}`; an update refuses to overwrite a file of another version (error `session state has schema version N; refusing to overwrite`).
- `data` is an open object; unknown keys must be preserved. Keys in the fixture: `startedAt` (ISO string), `source` (SessionStart source), `exploration` `{lookups, bytes, notified}`. Later events add others (for example `transcriptPath`, subagent records).
- Fixture: `test-fixtures/contracts/session-state/session.json`. Read through `status --json --session <id>` (its `session.state` equals `data`; a `version: 2` copy reads as `{}`).
- Capture: SessionStart then UserPromptSubmit through the hook runner with `ODD_CLAUDE_DATA` set (see the script).

## Plugin-wide state

- Path: `<dataDir>/<name>.json`, same envelope as Session state with `sessionId` set to the name. Names in v9: `delegation` (`{mode: "full"|"organic"}`), `review-mode` (`{mode: "on"|"off"}`), `profiles` (`{active, routing}`, or `{}` when cleared), `setup`, `codegraph-trust` (`{projects: string[]}`), `background-subagents` (`{policy}`).
- Schema: envelope `{"version": 1, "sessionId": <name>, "data": <object>}`; same read rules as Session state, no lock.
- Fixtures: `plugin-state/delegation.json`, `plugin-state/review-mode.json` (two of the names; the others share the envelope). Read through `coordinator` (prints `coordinator mode: on (stored)`) and `review-mode status --json` (`global: "on"`).
- Capture: `coordinator --action on --data-dir <dir>` and `review-mode enable --scope global --cwd <dir> --data-dir <dir>`.

## Agent status

- Path: `<dataDir>/status/<id>.json`, mode 0600, directory mode 0700 (a symlinked or non-directory `status` dir is refused); rewritten atomically at SessionStart, UserPromptSubmit, Stop and SessionEnd; a reader treats a file older than 30 s as stale; pruned after 7 days.
- Schema `odd-claude.agent-status/v1`: `{"schema", "session": <id>, "cwd": <string|null>, "state": "idle"|"working"|"ended", "updatedAt": <ISO>}`.
- Fixture: `agent-status/agent-status.json`. The TS product has no reader (external terminal tools read it), so the spec checks that a fresh sandbox run reproduces the fixture and the file mode.
- Capture: SessionStart then UserPromptSubmit through the hook runner (state `working`).

## Scratch

- Path: `<dataDir>/scratch/<id>/`; `scratch/` and `scratch/<id>/` are both mode 0700, created at SessionStart (idempotent) and removed at SessionEnd. A symlinked root or dir is refused; removal never follows links and only removes `<dataDir>/scratch/<id>`.
- Schema: a directory, no file format. The fixture is the captured listing, one line per directory: `<octal mode> d <path relative to dataDir>/`.
- Fixture: `scratch/listing.txt`. The spec compares it with a fresh SessionStart run.
- Capture: SessionStart through the hook runner, then `stat` of the two directories (the script).

## Logs

- Path: `<dataDir>/logs/hooks.log`, append-only text, created with its directory on first use. Logging never throws.
- Schema: one line per event, `<ISO timestamp> <message>\n`, newlines in the message replaced by a space. Hook failures use `<Event>: <error message>`; the hook still exits 0 with empty stdout (fail-open).
- Fixture: `logs/hooks.log`: `<TIMESTAMP> SessionStart: Cannot read properties of null (reading 'session_id')`. The message text is the JavaScript engine's; a port matches the line shape (timestamp, event name, colon, message), not the message.
- Capture: SessionStart with stdin `null` through the hook runner.

## Output schemas

- Path: stdout of the read-only CLIs with `--json` (not stored on disk): `stats`, `retro`, `tasks`.
- Schemas: `odd-claude.stats/v1` `{schema, session, transcript: {turns, input, output, cacheRead, cacheWrite, spanMs, truncated, bytesRead, models: [{model, turns, tokens}]}, subagents: [], exploration: {lookups, bytes}}` (plus `note` when the transcript is missing or unreadable); `odd-claude.retro/v1` `{schema, lines, firstLine, bytesRead, truncated, prompts: {count, lines}, tools, errors: {count, items}, rereads, reedits, repeatedCommands, agents, compactions}` (or `{schema, note}`); `odd-claude.tasks-lint/v1` `{schema, files, findings: [{file, line, rule, message}]}` (or `{schema, note}`). 2-space JSON, always exit 0.
- Fixtures: `output-schemas/{stats,retro,tasks-lint}.json`, with their inputs `transcript.jsonl` and `feature.md`. The spec runs the CLIs on those inputs in a sandbox and compares.
- Capture: `stats --json --session <id> --data-dir <dir>`, `retro --json --transcript <file>`, `tasks --json --cwd <git repo with odd/tasks/feature.md>`.

## Review store

- Path: `<git commonDir>/odd-plugin/review-transactions/v2/<lineage>/` where lineage matches `review-[0-9a-f]{16}`; directories mode 0700, files mode 0600; writes are atomic (`.atomic-*` temps) under revision compare-and-set; dead lock directories and abandoned empty lineages are reclaimed by later mutations.
- Schema: `review-state.json` (schema `odd-claude.review-state/v2`, canonical JSON on one line, newline-terminated): `lineage_id, target_identity, projection, base_tree, candidate_tree, risk_level, selected_lenses, state, original_changed_lines, correction_attempts, correction_budget, correction_budget_policy, admitted_role_results, findings, fix_finding_ids, burned, created_at, updated_at, revision`, plus `approved_revision, approved_ack_token_hash, ledger_hash, evidence_hash, burn_receipt` once approved. `revision` is the domain hash of the record without it. States: reviewing, correction_required, validating, approved, escalated, invalidated. `review-receipt.json` (schema `odd-claude.review-receipt/v1`, written when burned): `lineage_id, target_identity, projection, base_tree, candidate_tree, approved_revision, burned_at, selected_lenses, risk_level, ledger_hash, evidence_hash, burn_receipt, receipt_hash`; a target is consumed only when the state is burned and a valid matching receipt exists.
- Fixtures: `review-store/review-state.json`, `review-store/review-receipt.json`: one medium-risk lineage taken to approved and burned. Copied verbatim, not normalized (the hashes cover the values). The spec plants them in a sandbox repo, checks revision and receipt hashes, calls `review_status` on the live server and asserts the files stay byte-identical. The frozen `reviewing` state used by `crash.spec.ts` is `store.testkit.ts` `LIVE_LINEAGE`, kept in step with the store by `src/review/live-lineage-fixture.spec.ts`.
- Capture: the MCP review server through the harness (`approveThroughCapture`, `acknowledge`) on a sandbox git repo with a fake reviewer.

## Installer

- Path: `<oddHome>/manifest.json` and `<oddHome>/settings-state.json`, `<oddHome>/backups/`; `<oddHome>` is `$ODD_CLAUDE_HOME` or `~/.odd-claude`. Files are written atomically; `manifest.json` mode 0644, `settings-state.json` mode 0600, `backups/` mode 0700. Backups are `backups/settings.<YYYYMMDDTHHMMSSmmmZ>.json` copies of the Claude `settings.json` (and per-timestamp directories for managed files). The installer lock is `<oddHome>/.lock`.
- Schema `manifest.json`: `{"version": 1, "oddVersion", "installedAt", "files": {<path relative to the Claude dir>: <sha256 hex>}, "blocks": {<CLAUDE.md block id>: <sha256 hex>}, "models": {"profile", "roles": {<agent>: <model>}}}`. `blocks` is optional (absent in manifests from before managed blocks). An unreadable or wrong-version manifest is an error, never guessed. `settings-state.json`: `{"version": 1, "settings": {<JSON-path key>: {"path": [...], "previous": {"present": bool, "value"?}, "written": <value>}}, "extras": {...}}`; other modules add top-level keys (for example the 6 h `update` cache and MCP records) and every writer must preserve the rest.
- Fixtures: `installer/manifest.json`, `installer/settings-state.json` (`<SANDBOX>` in the status line command, `<TIMESTAMP>` for `installedAt`). Read through `installer uninstall --dry-run --json` (`ok: true`; a `version: 2` manifest gives `ok: false`, exit 1).
- Capture: `installer install --source plugins/odd-claude --yes --no-deps --json` with the sandbox `HOME` and the fake `claude` on `PATH`.

## Data dir env

- Resolution (`dataDirFromEnv`, `src/lib/state.ts`): the first non-empty of `ODD_CLAUDE_DATA`, `CLAUDE_PLUGIN_DATA` (legacy); otherwise `${ODD_CLAUDE_HOME:-$HOME/.odd-claude}/data`. An empty value counts as unset. A relative resolved path is an error (`data dir must be an absolute path`). The installer uses the same rule (`resolveInstallPaths`), and `--data-dir <dir>` on a CLI sets `ODD_CLAUDE_DATA`.
- Schema: a table of environment inputs to the resolved data dir, rows `{note, env, dataDir}` (`HOME` is the sandbox home, so the default row is `<SANDBOX>/home/.odd-claude/data`).
- Fixture: `data-dir-env/table.json` (7 rows). The spec runs `status --json` with each row's environment and compares `dataDir`.
- Capture: `status --json` per row (the script).
