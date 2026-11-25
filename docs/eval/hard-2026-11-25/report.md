# Eval report

Runs: 54 of 54 planned; recorded cost 18.98 USD.

## Per arm

Metric cells read mean / median / stdev (sample stdev; n/a when no data).

| arm | runs | pass rate | cost USD | tokens | wall s | subagents | visible tests modified | invalid |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 18 | 16/18 (89%) | 0.240 / 0.246 / 0.114 | 147961 / 171156 / 68947 | 66.7 / 44.9 / 53.5 | 0.00 / 0.00 / 0.00 | 11 | 0 |
| coord-on | 18 | 17/18 (94%) | 0.434 / 0.404 / 0.143 | 386722 / 376891 / 141276 | 103.3 / 81.0 / 54.9 | 1.00 / 1.00 / 0.34 | 11 | 0 |
| coord-off | 18 | 16/18 (89%) | 0.381 / 0.383 / 0.120 | 266782 / 273343 / 97329 | 99.0 / 78.8 / 69.7 | 0.00 / 0.00 / 0.00 | 11 | 0 |

Check pass rates per arm:

| arm | check acceptance | check regression |
| --- | --- | --- |
| none | 16/18 (89%) | 16/18 (89%) |
| coord-on | 17/18 (94%) | 17/18 (94%) |
| coord-off | 16/18 (89%) | 16/18 (89%) |

## Per task

| task | none pass | none cost USD (mean) | coord-on pass | coord-on cost USD (mean) | coord-off pass | coord-off cost USD (mean) |
| --- | --- | --- | --- | --- | --- | --- |
| async-notes | 3/3 | 0.408 | 3/3 | 0.607 | 3/3 | 0.531 |
| commit-lint | 3/3 | 0.227 | 3/3 | 0.396 | 3/3 | 0.369 |
| duration-report | 3/3 | 0.235 | 3/3 | 0.388 | 3/3 | 0.415 |
| event-rename | 3/3 | 0.248 | 3/3 | 0.452 | 2/3 | 0.332 |
| invoice-rounding | 2/3 | 0.126 | 2/3 | 0.229 | 2/3 | 0.228 |
| text-table | 2/3 | 0.198 | 3/3 | 0.530 | 3/3 | 0.410 |

Check pass rates per task:

| task | none acceptance | none regression | coord-on acceptance | coord-on regression | coord-off acceptance | coord-off regression |
| --- | --- | --- | --- | --- | --- | --- |
| async-notes | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| commit-lint | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| duration-report | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| event-rename | 3/3 | 3/3 | 3/3 | 3/3 | 2/3 | 2/3 |
| invoice-rounding | 2/3 | 2/3 | 2/3 | 2/3 | 2/3 | 2/3 |
| text-table | 2/3 | 2/3 | 3/3 | 3/3 | 3/3 | 3/3 |

## Runs with problems

- event-rename.coord-off.2: error (claude exited 1: )
- invoice-rounding.none.2: error (claude exited 1: )
- invoice-rounding.coord-on.2: error (claude exited 1: )
- invoice-rounding.coord-off.2: error (claude exited 1: )
- text-table.none.2: error (claude exited 1: )
