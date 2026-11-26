# Eval report

Runs: 54 of 54 planned; recorded cost 7.12 USD.

## Per arm

Metric cells read mean / median / stdev (sample stdev; n/a when no data).

| arm | runs | pass rate | cost USD | tokens | wall s | subagents | visible tests modified | invalid | runs with denials | mean denials |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 18 | 18/18 (100%) | 0.107 / 0.093 / 0.028 | 147182 / 142918 / 40951 | 22.0 / 19.9 / 9.2 | 0.00 / 0.00 / 0.00 | 10 | 0 | 0 | 0.00 |
| coord-off | 18 | 16/18 (89%) | 0.157 / 0.149 / 0.036 | 191324 / 192132 / 55770 | 25.1 / 25.3 / 9.4 | 0.00 / 0.00 / 0.00 | 12 | 0 | 0 | 0.00 |
| skills | 18 | 18/18 (100%) | 0.132 / 0.131 / 0.024 | 196872 / 202789 / 48720 | 25.7 / 25.9 / 8.6 | 0.00 / 0.00 / 0.00 | 12 | 0 | 0 | 0.00 |

Check pass rates per arm:

| arm | check acceptance | check regression |
| --- | --- | --- |
| none | 18/18 (100%) | 18/18 (100%) |
| coord-off | 18/18 (100%) | 16/18 (89%) |
| skills | 18/18 (100%) | 18/18 (100%) |

## Per task

| task | none pass | none cost USD (mean) | coord-off pass | coord-off cost USD (mean) | skills pass | skills cost USD (mean) |
| --- | --- | --- | --- | --- | --- | --- |
| async-notes | 3/3 | 0.142 | 3/3 | 0.215 | 3/3 | 0.157 |
| commit-lint | 3/3 | 0.115 | 3/3 | 0.165 | 3/3 | 0.136 |
| duration-report | 3/3 | 0.085 | 1/3 | 0.144 | 3/3 | 0.121 |
| event-rename | 3/3 | 0.082 | 3/3 | 0.118 | 3/3 | 0.094 |
| invoice-rounding | 3/3 | 0.083 | 3/3 | 0.131 | 3/3 | 0.123 |
| text-table | 3/3 | 0.135 | 3/3 | 0.170 | 3/3 | 0.158 |

Check pass rates per task:

| task | none acceptance | none regression | coord-off acceptance | coord-off regression | skills acceptance | skills regression |
| --- | --- | --- | --- | --- | --- | --- |
| async-notes | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| commit-lint | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| duration-report | 3/3 | 3/3 | 3/3 | 1/3 | 3/3 | 3/3 |
| event-rename | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| invoice-rounding | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| text-table | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
