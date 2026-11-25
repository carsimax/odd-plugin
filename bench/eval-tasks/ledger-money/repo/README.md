# ledger

A double-entry-style ledger.

- `Ledger` (`src/ledger.js`): `post({ date, memo, from, to, amount })`, `balance(account)`, `statement(account)`, `accounts()`.
- `statementLine(entry, delta, running)` (`src/statement.js`): formats one statement line.
- `trialBalance(ledger)` (`src/report.js`): one line per account plus a total.

Amounts are positive numbers with at most two decimals. Run the tests with `npm test`.
