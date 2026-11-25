# Eval report

Runs: 54 of 54 planned; recorded cost 19.79 USD.

## Per arm

Metric cells read mean / median / stdev (sample stdev; n/a when no data).

| arm | runs | pass rate | cost USD | tokens | wall s | subagents | visible tests modified | invalid |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 18 | 18/18 (100%) | 0.261 / 0.274 / 0.090 | 173043 / 186686 / 41911 | 57.8 / 60.0 / 32.0 | 0.00 / 0.00 / 0.00 | 12 | 0 |
| coord-on | 18 | 18/18 (100%) | 0.474 / 0.420 / 0.180 | 412805 / 328670 / 201288 | 91.1 / 79.9 / 44.6 | 1.06 / 1.00 / 0.24 | 15 | 0 |
| coord-off | 18 | 18/18 (100%) | 0.364 / 0.361 / 0.085 | 250696 / 257033 / 54953 | 88.6 / 63.2 / 118.3 | 0.00 / 0.00 / 0.00 | 11 | 0 |

## Per task

| task | none pass | none cost USD (mean) | coord-on pass | coord-on cost USD (mean) | coord-off pass | coord-off cost USD (mean) |
| --- | --- | --- | --- | --- | --- | --- |
| config-layers | 3/3 | 0.348 | 3/3 | 0.428 | 3/3 | 0.392 |
| csv-quoted-fields | 3/3 | 0.256 | 3/3 | 0.427 | 3/3 | 0.364 |
| inventory-orders-bug | 3/3 | 0.198 | 3/3 | 0.359 | 3/3 | 0.325 |
| ledger-money | 3/3 | 0.354 | 3/3 | 0.572 | 3/3 | 0.448 |
| range-merge-bug | 3/3 | 0.110 | 3/3 | 0.267 | 3/3 | 0.220 |
| token-bucket-extract | 3/3 | 0.302 | 3/3 | 0.792 | 3/3 | 0.435 |
