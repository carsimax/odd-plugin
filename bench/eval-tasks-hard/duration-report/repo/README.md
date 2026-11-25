# build-report

Turns build task records into a text report, a summary and slow-task alerts.

## Modules

- `formatDuration(ms)` (`src/duration.js`): `45s`, `5m 07s`.
- `normalizeTask(record)` (`src/tasks.js`): `{ name, startedAt, finishedAt }` (epoch ms) to `{ name, durationMs }`.
- `renderReport(tasks)`, `renderSummary(tasks)` (`src/report.js`): the build report.
- `slowTaskAlerts(tasks, budgetMs)` (`src/alerts.js`): one `ALERT ...` line per task over budget.
- `run(argv, records)` (`src/cli.js`): `report`, `summary` and `alerts [--budget-seconds N]` commands.
- `percentile(values, p)` (`src/stats.js`): used by the summary.

## Alerts

Alert lines are scraped by the on-call pager, whose rules match `took \d+m \d{2}s` and `budget \d+m \d{2}s`. The wording and the minutes-only duration format of alert lines must stay stable.

Run the tests with `npm test`.
