import test from "node:test";
import assert from "node:assert/strict";
import { round, lineTotal, invoiceTotal, summarize } from "../../src/index.js";

test("half cents round up despite binary floating point", () => {
  assert.equal(round(1.005, 2), 1.01);
  assert.equal(round(1.255, 2), 1.26);
  assert.equal(round(0.145, 2), 0.15);
});

test("line totals with three-decimal prices", () => {
  assert.equal(lineTotal({ unitPrice: 1.005, quantity: 1 }), 1.01);
  assert.equal(lineTotal({ unitPrice: 0.145, quantity: 1 }), 0.15);
  assert.equal(lineTotal({ unitPrice: 0.335, quantity: 3 }), 1.01);
});

test("invoice totals use the corrected line totals", () => {
  const result = invoiceTotal({ lines: [{ unitPrice: 1.005, quantity: 1 }, { unitPrice: 1.255, quantity: 1 }] });
  assert.deepEqual(result, { subtotal: 2.27, discount: 0, tax: 0, total: 2.27 });
});

test("summaries add up corrected invoices", () => {
  const invoices = [{ lines: [{ unitPrice: 1.005, quantity: 1 }] }, { lines: [{ unitPrice: 0.145, quantity: 1 }] }];
  assert.deepEqual(summarize(invoices), { count: 2, total: 1.16, average: 0.58 });
});
