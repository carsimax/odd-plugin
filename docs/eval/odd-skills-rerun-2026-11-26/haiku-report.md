# Eval report

Runs: 32 of 36 planned; recorded cost 27.30 USD.

Stopped by the budget guard: accumulated 27.30 USD + per-run cap 3 USD would exceed the total budget 30 USD; 4 runs not started.

## Per arm

Metric cells read mean / median / stdev (sample stdev; n/a when no data).

| arm | runs | pass rate | cost USD | tokens | wall s | subagents | visible tests modified | invalid | runs with denials | mean denials |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 16 | 12/16 (75%) | 0.011 / 0.011 / 0.004 | 220087 / 224595 / 42849 | 271.3 / 46.4 / 414.4 | 0.00 / 0.00 / 0.00 | 8 | 0 | 0 | 0.00 |
| skills | 16 | 11/16 (69%) | 0.015 / 0.012 / 0.006 | 452732 / 348823 / 252148 | 410.5 / 61.7 / 576.7 | 0.00 / 0.00 / 0.00 | 8 | 0 | 0 | 0.00 |

Check pass rates per arm:

| arm | check acceptance | check regression |
| --- | --- | --- |
| none | 12/16 (75%) | 13/16 (81%) |
| skills | 11/16 (69%) | 12/16 (75%) |

## Per task

| task | none pass | none cost USD (mean) | skills pass | skills cost USD (mean) |
| --- | --- | --- | --- | --- |
| async-notes | 2/3 | 0.013 | 2/3 | 0.023 |
| commit-lint | 2/3 | 0.014 | 2/3 | 0.017 |
| duration-report | 2/3 | 0.008 | 2/3 | 0.011 |
| event-rename | 2/3 | 0.008 | 2/3 | 0.011 |
| invoice-rounding | 2/2 | 0.008 | 2/2 | 0.010 |
| text-table | 2/2 | 0.018 | 1/2 | 0.023 |

Check pass rates per task:

| task | none acceptance | none regression | skills acceptance | skills regression |
| --- | --- | --- | --- | --- |
| async-notes | 2/3 | 2/3 | 2/3 | 2/3 |
| commit-lint | 2/3 | 2/3 | 2/3 | 2/3 |
| duration-report | 2/3 | 3/3 | 2/3 | 3/3 |
| event-rename | 2/3 | 2/3 | 2/3 | 2/3 |
| invoice-rounding | 2/2 | 2/2 | 2/2 | 2/2 |
| text-table | 2/2 | 2/2 | 1/2 | 1/2 |

## Runs with problems

- text-table.skills.2: timeout
- async-notes.none.3: timeout
- async-notes.skills.3: timeout
- commit-lint.none.3: timeout
- commit-lint.skills.3: timeout
- duration-report.none.3: timeout
- duration-report.skills.3: timeout
- event-rename.none.3: timeout
- event-rename.skills.3: timeout
