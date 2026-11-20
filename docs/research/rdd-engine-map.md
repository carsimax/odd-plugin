# RDD engine map (reference for the odd-claude v2 implementers)

Status: research, 2026-11-19. Read-only reference: `upstream/gentle-ai` (Go, commit 08317b9, gitignored) and `upstream/gentle-shell` (Pi/TS). Nothing here is copied code: odd-claude writes the engine new in TypeScript with odd names (`odd/tasks/v2-rdd.md`). Paths are relative to the clone root and the `path:line` evidence was spot-checked against 08317b9 (see "Verification of this map").

Note: a first version of this map was discarded because it used a forbidden source. This one only uses `upstream/gentle-ai` and `upstream/gentle-shell`.

## 1. State machine (compact v2)

- States: `reviewing` → `approved` (then acknowledge burns the authority), or `reviewing` → `correction_required` → `validating` → `approved` | `escalated`. Evidence: `internal/reviewtransaction/compact.go:21-22` (`StateCorrectionRequired`, `StateValidating`), full state enum `internal/reviewtransaction/transaction.go:36-47`.
- Max one correction: `MaxCompactCorrectionAttempts = 1` (`compact.go:23`). The historical value 3 (`historicalCompactCorrectionAttempts`) only matters for legacy states: out of scope for v2 core.
- Schema id of the persisted state: `gentle-ai.review-state/v2` (`compact.go:15`); odd-claude uses `odd-claude.review-state/v2`.
- Four lenses: `review-risk`, `review-resilience`, `review-readability`, `review-reliability` (`supportedLenses`, `transaction.go:30`).
- Up to 6 admitted role results per transaction (4 lens reviewers plus validation/correction roles).

## 2. Lifecycle (operator-visible verbs)

1. `assess` (read-only; reports `reviewDue`).
2. `inspect`.
3. `start`: freezes the snapshot, the policy and the lenses.
4. Consent v3: `contracts/review-integration/v2/schemas/consent-v3.schema.json`; risk `medium|high`; exactly 2 choices.
5. `status` returns `next_transition` (`execute` | `collect`) with an opaque binding: `internal/cli/review_status_contract.go`, `internal/cli/review_next_transition.go`. The caller must echo the binding; a stale one is `binding-drift`.
6. `capture` of a reviewer result: `internal/reviewtransaction/compact_reviewer_capture.go` (note: package `reviewtransaction`, not `cli`).
7. Correction (at most once), then validation.
8. `acknowledge-approved` burns a 256-bit `approved_ack_token` (random reader at `internal/reviewtransaction/compact_burn.go:48`); after the burn the approval cannot authorize anything again.

## 3. Storage

- Layout: `<git-common-dir>/gentle-ai/review-transactions/v2/<lineage>/{review-state.json,review-receipt.json}`, plus `v2/LOCK` and `REVIEW-MAINTENANCE.lock`. odd plugin: `<git-common-dir>/odd-plugin/review-transactions/v2/...` (own namespace; never read or write the gentle-ai tree). Not `odd-claude/`: the external `odd-claude` CLI already uses `<git-common-dir>/odd-claude/review-transactions/v2` (see odd/tasks/v2-rdd.md L5).
- Locks (Go): `flock` `LOCK_EX|LOCK_NB` (`internal/reviewtransaction/store_lock_unix.go:16`). Start lock: 2 s timeout, 25 ms polling (`compact_store.go:39-40`). Maintenance lock shared/exclusive: 2 s, 10 ms polling (`store_lock.go:25`, `:276`). Typed errors: `AuthorityLockTimeoutError`, `AuthorityLockCancelledError` (`store_lock.go:86-103`).
- Node has no `flock`: use a directory lock (`mkdir` is atomic) holding an owner token file, bounded wait with the same budgets, and never break a lock whose owner is not provably dead.
- Atomic write: temp file + `fsync` + `rename` + directory `fsync` (`internal/reviewtransaction/store.go:927` `writeAtomic`). Compare-and-swap on the state revision, not on mtime.

## 4. Integrity (hashes and canonical JSON)

- SHA-256 domain hashes: `"gentle-ai.<domain>/v<N>\x00" + payload`. Domains seen in `internal/reviewtransaction/*.go`: `review-state/v2`, `review-snapshot/v1..v4`, `paths/v1` (`snapshot.go`-adjacent, `:1680`), `intended-untracked/v1` (`:113`), `lens-result/v1` (`:380`), `review-artifact-subject/v2`, `review-admitted-result/v1|v2`, `review-changed-path-manifest/v1`, `review-transport/v2`, `review-capture-phase/v1`. odd-claude uses `odd-claude.<domain>/v<N>\x00`.
- Go canonical form is struct field order; the Pi port canonicalizes with sorted keys (`upstream/gentle-shell/lib/review-canonical.ts:43-45`, `domainHashV1`). Decision for odd-claude: ONE canonical JSON (sorted keys), pinned by test vectors (U1). Never hash `JSON.stringify` output of an unsorted object.

## 5. Reviewer runner

- A `claude` child process in an empty temp cwd, prompt via stdin. Fixed args (`internal/reviewerprovider/claude_adapter.go:39-42`): `--print --output-format text --tools "" --permission-mode dontAsk --no-session-persistence --setting-sources "" --system-prompt "<isolated reviewer>"`; optional `--model` (`:69`) and `--effort` (`:73`).
- NOT `--bare`: it breaks subscription auth (comment block at `:29-34`).
- The child gets no tools, no hooks, no plugins, no session; its output is text only and must be decoded and admitted by the engine.

## 6. Stop hook

`internal/cli/review_stop_hook.go`:

- `SessionStart` records the baseline (candidate identity at session start).
- `Stop`: if `stop_hook_active` is true → silent (`:48`). If RDD is on, a review is due and `status` offers `review.start` → print `{"decision":"block","reason":…}` (`:21`, `:54`). Once per candidate identity (no repeat nag).
- odd-claude: only the settle reminder may block, only with RDD on (decision S3).

## 7. Delivery gate

`upstream/gentle-shell/lib/review-delivery-preflight.ts:38` `checkReviewDeliveryPreflight(cwd, toolName, command, cli, …)`:

- Recognizes `git push` and `gh pr`.
- A mixed chain (candidate-changing command + delivery command) is denied.
- RDD off → allow. Unknown mode → deny.
- Runs `assess` on the base diff with the selected `baseRef`; `reviewDue` and no declined consent → deny.
- 10 s budget for the whole check.
- Policy note: the Go facade treats gates as informational; Pi enforces. odd-claude follows Pi (user decision 2026-11-19). Bound to PreToolUse `Bash`.

## 8. Contract surface

- Facade verbs: `internal/cli/review_facade.go:739-792` (`start`, `status`, `repair`, `validate`, …); accepted flags and their counting at `:2875` (`contract`, `agent`, `target`, `projection`, `lineage`, `base-ref`, `committed-only`, `workspace-overlay`, `consent`, `locale`, `request-context`, `escalate-item`, `escalate-reason`, `lenses`, `lenses-reason`).
- Stop reason codes: split into terminal vs recoverable; carry the full list from the v2 `failure.schema.json` and the status contract when U10 starts.
- Run outcomes: `not-due`, `consent-required`, `input-required`, `selection-required`, `stopped`, `handoff`, `forecast`, `binding-drift`, `transition-limit`, `blocked`, `closed`.
- Schemas: `contracts/review-integration/v2/schemas/` (assess, start-v4, status-v4..v9, consent-v3, admitted-result, artifact-subject, transition-binding, gate-result, failure, review-acknowledged, capture-result-dry-run, capabilities-v2.x, …) and `contracts/review-integration/v1`.

## 9. Test assets to reuse as vectors (read-only, copy into odd fixtures with odd names)

- gentle-ai: `contracts/review-integration/v1` and `v2` (`fixtures/`, `schemas/`); `internal/reviewtransaction/testdata/` (`issue2995/` with `PROVENANCE.md` and released approved/escalated `review-state.json`, `gate-boundary-matrix.golden`, `shadow-differential-matrix.golden`, `v1.49.0-ordinary-4r`); `bench/testdata/` (`issue2879`, `issue2995`, `journeys.manifest`, `managed-assets`, `observations.json`).
- gentle-shell: `contracts/review-provider-contract-mirror/v1.6.0/` (`bundle/` with `manifest.json`, `orchestration`, `routing`, `schemas`, `vectors`; `generated/` baselines `provider-capabilities.baseline.json`, `provider-roles.baseline.json`) and `provider-contract.lock.json`.
- Fixtures carry gentle-ai hash domains: re-derive expected hashes under the `odd-claude.` domain instead of copying them.

## Verification of this map

Spot-checked on 08317b9: `compact.go:21-23`, `transaction.go:36-47`, `store.go:927`, `store_lock.go:25,276`, `compact_store.go:39-40`, `claude_adapter.go:29-42,69,73`, `review_stop_hook.go:21,48,54`, `review_facade.go:739-745,2875`, `review-delivery-preflight.ts:38`, `review-canonical.ts:43-45`, the contract and test directories. Correction found: `compact_burn.go` and `compact_reviewer_capture.go` live in `internal/reviewtransaction/`, not `internal/cli/`. Not independently re-read: the 6-result cap, the reason-code lists and the `review-changed-path-manifest/v1`, `review-transport/v2`, `review-capture-phase/v1` domains (taken from the verified summary).
