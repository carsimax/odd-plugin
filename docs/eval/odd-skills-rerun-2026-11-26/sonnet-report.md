# Eval report

Runs: 36 of 36 planned; recorded cost 4.25 USD.

## Per arm

Metric cells read mean / median / stdev (sample stdev; n/a when no data).

| arm | runs | pass rate | cost USD | tokens | wall s | subagents | visible tests modified | invalid | runs with denials | mean denials |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 18 | 17/18 (94%) | 0.105 / 0.100 / 0.027 | 142604 / 114948 / 68182 | 21.2 / 22.4 / 7.2 | 0.00 / 0.00 / 0.00 | 10 | 0 | 0 | 0.00 |
| skills | 18 | 15/18 (83%) | 0.131 / 0.131 / 0.026 | 198040 / 216313 / 63298 | 26.4 / 26.4 / 8.9 | 0.00 / 0.00 / 0.00 | 12 | 0 | 0 | 0.00 |

Check pass rates per arm:

| arm | check acceptance | check regression |
| --- | --- | --- |
| none | 18/18 (100%) | 17/18 (94%) |
| skills | 18/18 (100%) | 15/18 (83%) |

## Per task

| task | none pass | none cost USD (mean) | skills pass | skills cost USD (mean) |
| --- | --- | --- | --- | --- |
| async-notes | 3/3 | 0.149 | 3/3 | 0.164 |
| commit-lint | 3/3 | 0.108 | 3/3 | 0.128 |
| duration-report | 2/3 | 0.083 | 0/3 | 0.112 |
| event-rename | 3/3 | 0.081 | 3/3 | 0.094 |
| invoice-rounding | 3/3 | 0.087 | 3/3 | 0.131 |
| text-table | 3/3 | 0.123 | 3/3 | 0.158 |

Check pass rates per task:

| task | none acceptance | none regression | skills acceptance | skills regression |
| --- | --- | --- | --- | --- |
| async-notes | 3/3 | 3/3 | 3/3 | 3/3 |
| commit-lint | 3/3 | 3/3 | 3/3 | 3/3 |
| duration-report | 3/3 | 2/3 | 3/3 | 0/3 |
| event-rename | 3/3 | 3/3 | 3/3 | 3/3 |
| invoice-rounding | 3/3 | 3/3 | 3/3 | 3/3 |
| text-table | 3/3 | 3/3 | 3/3 | 3/3 |
