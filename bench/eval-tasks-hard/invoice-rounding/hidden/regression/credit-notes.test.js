import test from "node:test";
import assert from "node:assert/strict";
import { round, createCreditNote, formatMoney } from "../../src/index.js";

test("negative halves round toward positive infinity", () => {
  assert.equal(round(-0.125, 2), -0.12);
  assert.equal(round(-2.5, 0), -2);
  assert.equal(round(-1.005, 2), -1);
});

test("negative amounts that are not halves round to the nearest cent", () => {
  assert.equal(round(-1.239, 2), -1.24);
  assert.equal(round(-1.231, 2), -1.23);
});

test("a credit note never rounds further from zero than the charge it reverses", () => {
  const note = createCreditNote({ invoiceId: "A-9", lines: [{ description: "Fee", unitPrice: 0.125, quantity: 1 }] });
  assert.deepEqual(note, { invoiceId: "A-9", items: [{ description: "Fee", amount: -0.12 }], net: -0.12, tax: 0, total: -0.12 });
});

test("credit note tax follows the same rule", () => {
  const note = createCreditNote({ invoiceId: "A-10", lines: [{ description: "Fee", unitPrice: 2.5, quantity: 1 }], taxRate: 0.05 });
  assert.deepEqual(note, { invoiceId: "A-10", items: [{ description: "Fee", amount: -2.5 }], net: -2.5, tax: -0.12, total: -2.62 });
});

test("credit notes still display as negative money", () => {
  assert.equal(formatMoney(round(-0.125, 2)), "-$0.12");
});
