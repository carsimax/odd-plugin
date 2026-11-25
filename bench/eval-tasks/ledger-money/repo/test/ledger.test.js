import test from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/ledger.js";
import { trialBalance } from "../src/report.js";

function sample() {
  const l = new Ledger();
  l.post({ date: "2024-01-02", memo: "deposit", from: "bank", to: "cash", amount: 12.5 });
  l.post({ date: "2024-01-03", memo: "coffee", from: "cash", to: "food", amount: 3.2 });
  return l;
}

test("balances follow postings", () => {
  const l = sample();
  assert.equal(l.balance("cash"), 9.3);
  assert.equal(l.balance("bank"), -12.5);
});

test("statement shows deltas and running balance", () => {
  assert.deepEqual(sample().statement("cash"), [
    "2024-01-02  deposit       +12.50  12.50",
    "2024-01-03  coffee        -3.20  9.30",
  ]);
});

test("trial balance totals to zero", () => {
  assert.equal(trialBalance(sample()).at(-1), "TOTAL            0.00");
});

test("rejects non-positive amounts", () => {
  assert.throws(() => sample().post({ date: "d", memo: "m", from: "a", to: "b", amount: 0 }), /amount must be positive/);
});
