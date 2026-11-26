# Eval report

Runs: 36 of 36 planned; recorded cost 11.81 USD.

## Per arm

Metric cells read mean / median / stdev (sample stdev; n/a when no data).

| arm | runs | pass rate | cost USD | tokens | wall s | subagents | visible tests modified | invalid |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 18 | 18/18 (100%) | 0.277 / 0.248 / 0.076 | 168342 / 173723 / 38505 | 50.8 / 41.9 / 17.8 | 0.00 / 0.00 / 0.00 | 12 | 0 |
| skills | 18 | 17/18 (94%) | 0.379 / 0.307 / 0.274 | 288785 / 227644 / 214410 | 67.0 / 49.0 / 61.4 | 0.06 / 0.00 / 0.24 | 11 | 0 |

Check pass rates per arm:

| arm | check acceptance | check regression |
| --- | --- | --- |
| none | 18/18 (100%) | 18/18 (100%) |
| skills | 17/18 (94%) | 17/18 (94%) |

## Per task

| task | none pass | none cost USD (mean) | skills pass | skills cost USD (mean) |
| --- | --- | --- | --- | --- |
| async-notes | 3/3 | 0.420 | 2/3 | 0.737 |
| commit-lint | 3/3 | 0.226 | 3/3 | 0.274 |
| duration-report | 3/3 | 0.250 | 3/3 | 0.299 |
| event-rename | 3/3 | 0.245 | 3/3 | 0.329 |
| invoice-rounding | 3/3 | 0.210 | 3/3 | 0.278 |
| text-table | 3/3 | 0.310 | 3/3 | 0.360 |

Check pass rates per task:

| task | none acceptance | none regression | skills acceptance | skills regression |
| --- | --- | --- | --- | --- |
| async-notes | 3/3 | 3/3 | 2/3 | 2/3 |
| commit-lint | 3/3 | 3/3 | 3/3 | 3/3 |
| duration-report | 3/3 | 3/3 | 3/3 | 3/3 |
| event-rename | 3/3 | 3/3 | 3/3 | 3/3 |
| invoice-rounding | 3/3 | 3/3 | 3/3 | 3/3 |
| text-table | 3/3 | 3/3 | 3/3 | 3/3 |
