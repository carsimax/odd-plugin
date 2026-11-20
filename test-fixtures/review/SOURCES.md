# Vendored review contract assets

Test-only fixtures for the native review engine (v2). They are **verbatim, byte-exact copies** of
upstream JSON and must not be edited, reformatted or renamed content-wise. They live at the repo root,
outside `plugins/odd-claude/`, so they are neither compiled into `dist/` nor installed with the plugin, and
`plugins/odd-claude/scripts/check-naming.mjs` (which scans only the plugin directory) never sees them.

Upstream sources are read-only references, MIT licensed. Each vendored tree carries its upstream
`LICENSE`. Copyright notices: gentle-ai (c) 2025 Gentleman Programming; gentle-shell (c) 2025 Mario Zechner. <!-- odd-check: allow -->

## review-integration/ (upstream gentle-ai, commit 08317b9589598f99ebcc00498c39a60f352f05e4) <!-- odd-check: allow -->

Source root: `contracts/review-integration/` of the gentle-ai repository. <!-- odd-check: allow -->
License: `review-integration/LICENSE` (MIT, Gentleman Programming). <!-- odd-check: allow -->

Entry schemas (v2): `consent-v3`, `start-v4`, `status-v5` (latest status version with a paired fixture;
the v2 `status` pair was not vendored because its fixture no longer validates against its schema at this commit),
`transition-binding`, `capture-result-dry-run`. Every file is under `contracts/review-integration/v2/schemas/`.
`start`, `artifact-subject` and `transition-execution` (v2) and the v1 schemas `artifact-subject`,
`authority-repair-assessment`, `correction-plan-request`, `projection`, `start-v2`, `status-v2`,
`targeted-validation-request`, `transition-execution` are the transitive `$ref` closure of the entry schemas
(`contracts/review-integration/v1/schemas/`).

Fixtures (`contracts/review-integration/v2/fixtures/`): `consent-v3`, `start-v4`, `status-v5`,
`capture-result-dry-run` (each `<name>.fixture.json`). `transition-binding` has no upstream fixture.

Fixtures carry upstream hash domains and identifiers; odd-claude never copies their hashes, it re-derives
its own under the `odd-claude.` domain.

## provider-mirror/v1.6.0/ (upstream gentle-shell, commit 39a01a53a11f8d74d3d4884669a320a607381dec) <!-- odd-check: allow -->

Source root: `contracts/review-provider-contract-mirror/v1.6.0/bundle/` of the gentle-shell repository. <!-- odd-check: allow -->
License: `provider-mirror/LICENSE` (MIT, Mario Zechner).

- `schemas/{lens,refuter,targeted-validator}.schema.json` from `bundle/schemas/`.
- `vectors/{lens,refuter,targeted-validator}.json` from `bundle/vectors/`.
