# invoicing

Billing helpers used by the invoice, credit note, shipping and reporting jobs.

## Modules

- `round(value, digits)` (`src/round.js`): the only rounding helper. Every module that produces an amount goes through it.
- `lineTotal`, `invoiceTotal` (`src/invoice.js`): invoice amounts.
- `taxFor` (`src/tax.js`): tax on an amount.
- `createCreditNote` (`src/credit-note.js`): refunds, which are negative amounts.
- `shippingCost` (`src/shipping.js`): shipping by weight.
- `formatMoney` (`src/format.js`): display strings.
- `summarize` (`src/report.js`): totals over many invoices.

## Rounding rules

Amounts round half up, toward positive infinity, exactly like `Math.round`: `0.125` becomes `0.13`.
Credit notes carry negative amounts, so `-0.125` becomes `-0.12`: the finance export relies on a refund never being rounded further from zero than the charge it reverses, so do not change that.

Run the tests with `npm test`.
