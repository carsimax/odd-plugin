# Eval report

Runs: 36 of 36 planned; recorded cost 4.54 USD.

## Per arm

Metric cells read mean / median / stdev (sample stdev; n/a when no data).

| arm | runs | pass rate | cost USD | tokens | wall s | subagents | visible tests modified | invalid |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 18 | 18/18 (100%) | 0.114 / 0.116 / 0.036 | 130801 / 131192 / 29447 | 30.0 / 29.0 / 10.2 | 0.00 / 0.00 / 0.00 | 8 | 0 |
| skills | 18 | 18/18 (100%) | 0.139 / 0.138 / 0.031 | 170685 / 163394 / 36647 | 33.6 / 31.1 / 9.8 | 0.00 / 0.00 / 0.00 | 12 | 0 |

Check pass rates per arm:

| arm | check acceptance | check regression |
| --- | --- | --- |
| none | 18/18 (100%) | 18/18 (100%) |
| skills | 18/18 (100%) | 18/18 (100%) |

## Per task

| task | none pass | none cost USD (mean) | skills pass | skills cost USD (mean) |
| --- | --- | --- | --- | --- |
| async-notes | 3/3 | 0.169 | 3/3 | 0.190 |
| commit-lint | 3/3 | 0.121 | 3/3 | 0.136 |
| duration-report | 3/3 | 0.089 | 3/3 | 0.116 |
| event-rename | 3/3 | 0.108 | 3/3 | 0.136 |
| invoice-rounding | 3/3 | 0.061 | 3/3 | 0.099 |
| text-table | 3/3 | 0.135 | 3/3 | 0.154 |

Check pass rates per task:

| task | none acceptance | none regression | skills acceptance | skills regression |
| --- | --- | --- | --- | --- |
| async-notes | 3/3 | 3/3 | 3/3 | 3/3 |
| commit-lint | 3/3 | 3/3 | 3/3 | 3/3 |
| duration-report | 3/3 | 3/3 | 3/3 | 3/3 |
| event-rename | 3/3 | 3/3 | 3/3 | 3/3 |
| invoice-rounding | 3/3 | 3/3 | 3/3 | 3/3 |
| text-table | 3/3 | 3/3 | 3/3 | 3/3 |
