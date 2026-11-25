import test from "node:test";
import assert from "node:assert/strict";
import { parseAmount, formatAmount } from "../src/money.js";
import { Ledger } from "../src/ledger.js";
import { trialBalance } from "../src/report.js";

test("parseAmount converts numbers and strings to integer cents", () => {
  assert.equal(parseAmount(12.5), 1250);
  assert.equal(parseAmount("12.34"), 1234);
  assert.equal(parseAmount(0.1), 10);
  assert.equal(parseAmount("7"), 700);
  assert.equal(parseAmount(0.29), 29);
});

test("parseAmount rejects garbage", () => {
  assert.throws(() => parseAmount("abc"), /invalid amount/);
  assert.throws(() => parseAmount(NaN), /invalid amount/);
});

test("formatAmount renders cents with two decimals and a leading minus", () => {
  assert.equal(formatAmount(1234), "12.34");
  assert.equal(formatAmount(5), "0.05");
  assert.equal(formatAmount(0), "0.00");
  assert.equal(formatAmount(-5), "-0.05");
  assert.equal(formatAmount(-120000), "-1200.00");
});

test("Ledger.balanceCents returns exact integer cents", () => {
  const l = new Ledger();
  for (let i = 0; i < 10; i++) l.post({ date: "2024-02-01", memo: "dime", from: "bank", to: "jar", amount: 0.1 });
  assert.equal(l.balanceCents("jar"), 100);
  assert.equal(l.balanceCents("bank"), -100);
  assert.equal(l.balanceCents("nobody"), 0);
  assert.ok(Number.isInteger(l.balanceCents("jar")));
});

test("preserved: balance, statement, accounts and validation", () => {
  const l = new Ledger();
  l.post({ date: "2024-01-02", memo: "deposit", from: "bank", to: "cash", amount: 12.5 });
  l.post({ date: "2024-01-03", memo: "coffee", from: "cash", to: "food", amount: 3.2 });
  l.post({ date: "2024-01-04", memo: "refund", from: "food", to: "cash", amount: 0.7 });
  assert.equal(l.balance("cash"), 10);
  assert.equal(l.balance("food"), 2.5);
  assert.deepEqual(l.accounts(), ["bank", "cash", "food"]);
  assert.deepEqual(l.statement("cash"), [
    "2024-01-02  deposit       +12.50  12.50",
    "2024-01-03  coffee        -3.20  9.30",
    "2024-01-04  refund        +0.70  10.00",
  ]);
  assert.deepEqual(l.statement("food"), [
    "2024-01-03  coffee        +3.20  3.20",
    "2024-01-04  refund        -0.70  2.50",
  ]);
  assert.throws(() => l.post({ date: "d", memo: "m", from: "a", to: "b", amount: -1 }), /amount must be positive/);
  assert.equal(l.accounts().length, 3);
});

test("preserved: trial balance lines and total", () => {
  const l = new Ledger();
  l.post({ date: "2024-01-02", memo: "deposit", from: "bank", to: "cash", amount: 12.5 });
  l.post({ date: "2024-01-03", memo: "coffee", from: "cash", to: "food", amount: 3.2 });
  assert.deepEqual(trialBalance(l), [
    "bank           -12.50",
    "cash             9.30",
    "food             3.20",
    "TOTAL            0.00",
  ]);
});
