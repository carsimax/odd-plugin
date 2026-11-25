import test from "node:test";
import assert from "node:assert/strict";
import { Inventory } from "../src/inventory.js";
import { OrderBook } from "../src/orders.js";
import { lowStock } from "../src/report.js";

function setup() {
  const inv = new Inventory();
  inv.add("bolt", 10);
  inv.add("nut", 5);
  return { inv, book: new OrderBook(inv) };
}

test("placing an order reserves stock", () => {
  const { inv, book } = setup();
  const id = book.place([{ sku: "bolt", qty: 4 }]);
  assert.equal(book.status(id), "placed");
  assert.equal(inv.available("bolt"), 6);
});

test("fulfilling consumes stock", () => {
  const { inv, book } = setup();
  const id = book.place([{ sku: "bolt", qty: 4 }]);
  book.fulfill(id);
  assert.equal(inv.onHand("bolt"), 6);
  assert.equal(inv.reserved("bolt"), 0);
});

test("cancelling gives the reservation back", () => {
  const { inv, book } = setup();
  const id = book.place([{ sku: "nut", qty: 5 }]);
  book.cancel(id);
  assert.equal(inv.available("nut"), 5);
});

test("lowStock lists skus at or below the threshold", () => {
  const { inv, book } = setup();
  book.place([{ sku: "nut", qty: 4 }]);
  assert.deepEqual(lowStock(inv, 1), [{ sku: "nut", available: 1 }]);
});
