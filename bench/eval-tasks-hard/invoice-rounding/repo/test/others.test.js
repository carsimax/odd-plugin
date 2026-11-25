import test from "node:test";
import assert from "node:assert/strict";
import { createCreditNote, shippingCost, formatMoney } from "../src/index.js";

test("credit note reverses a charge", () => {
  const note = createCreditNote({ invoiceId: "A-1", lines: [{ description: "Widget", unitPrice: 10, quantity: 2 }], taxRate: 0.1 });
  assert.deepEqual(note, {
    invoiceId: "A-1",
    items: [{ description: "Widget", amount: -20 }],
    net: -20,
    tax: -2,
    total: -22,
  });
});

test("shipping cost grows with weight", () => {
  assert.equal(shippingCost(2), 6.9);
});

test("formatMoney groups thousands and signs negatives", () => {
  assert.equal(formatMoney(1234.5), "$1,234.50");
  assert.equal(formatMoney(-9), "-$9.00");
});
