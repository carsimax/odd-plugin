import test from "node:test";
import assert from "node:assert/strict";
import { round, shippingCost, taxFor, invoiceTotal } from "../../src/index.js";

test("positive rounding outside the buggy cases is unchanged", () => {
  assert.equal(round(0.125, 2), 0.13);
  assert.equal(round(2.5, 0), 3);
  assert.equal(round(1234.5678, 1), 1234.6);
  assert.equal(round(10, 2), 10);
});

test("shipping and tax keep their values", () => {
  assert.equal(shippingCost(0), 4.5);
  assert.equal(shippingCost(2), 6.9);
  assert.equal(taxFor(19.99, 0.21), 4.2);
});

test("a discount larger than the subtotal yields a negative taxable amount that rounds half up", () => {
  const result = invoiceTotal({ lines: [{ unitPrice: 1, quantity: 1 }], discount: 1.25, taxRate: 0.5 });
  assert.deepEqual(result, { subtotal: 1, discount: 1.25, tax: -0.12, total: -0.37 });
});
