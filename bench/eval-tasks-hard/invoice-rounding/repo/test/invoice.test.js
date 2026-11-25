import test from "node:test";
import assert from "node:assert/strict";
import { lineTotal, invoiceTotal, taxFor, summarize } from "../src/index.js";

test("line total multiplies price and quantity", () => {
  assert.equal(lineTotal({ unitPrice: 2.5, quantity: 4 }), 10);
});

test("invoice total adds tax after discount", () => {
  const result = invoiceTotal({
    lines: [{ unitPrice: 10, quantity: 2 }, { unitPrice: 5, quantity: 1 }],
    discount: 5,
    taxRate: 0.2,
  });
  assert.deepEqual(result, { subtotal: 25, discount: 5, tax: 4, total: 24 });
});

test("tax is a rounded share of the amount", () => {
  assert.equal(taxFor(19.99, 0.21), 4.2);
});

test("summarize totals several invoices", () => {
  const invoices = [{ lines: [{ unitPrice: 10, quantity: 1 }] }, { lines: [{ unitPrice: 5, quantity: 1 }] }];
  assert.deepEqual(summarize(invoices), { count: 2, total: 15, average: 7.5 });
});
