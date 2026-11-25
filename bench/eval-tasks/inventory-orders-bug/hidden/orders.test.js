import test from "node:test";
import assert from "node:assert/strict";
import { Inventory } from "../src/inventory.js";
import { OrderBook } from "../src/orders.js";
import { lowStock } from "../src/report.js";

function setup() {
  const inv = new Inventory();
  inv.add("bolt", 10);
  inv.add("nut", 5);
  inv.add("washer", 2);
  return { inv, book: new OrderBook(inv) };
}

test("a failed multi-line order leaves no stock reserved", () => {
  const { inv, book } = setup();
  assert.throws(
    () => book.place([{ sku: "bolt", qty: 4 }, { sku: "nut", qty: 1 }, { sku: "washer", qty: 3 }]),
    /insufficient stock for washer/,
  );
  assert.equal(inv.reserved("bolt"), 0);
  assert.equal(inv.reserved("nut"), 0);
  assert.equal(inv.available("bolt"), 10);
});

test("a failed order does not consume an order id", () => {
  const { book } = setup();
  assert.throws(() => book.place([{ sku: "washer", qty: 9 }]));
  assert.equal(book.place([{ sku: "bolt", qty: 1 }]), "o1");
});

test("a failed order does not disturb existing reservations", () => {
  const { inv, book } = setup();
  book.place([{ sku: "bolt", qty: 6 }]);
  assert.throws(() => book.place([{ sku: "bolt", qty: 3 }, { sku: "nut", qty: 6 }]));
  assert.equal(inv.reserved("bolt"), 6);
  assert.equal(inv.reserved("nut"), 0);
});

test("cancelling twice releases the reservation only once", () => {
  const { inv, book } = setup();
  const a = book.place([{ sku: "bolt", qty: 4 }]);
  book.place([{ sku: "bolt", qty: 3 }]);
  book.cancel(a);
  book.cancel(a);
  assert.equal(book.status(a), "cancelled");
  assert.equal(inv.reserved("bolt"), 3);
  assert.equal(inv.available("bolt"), 7);
});

test("cancelling a fulfilled order is refused and stock is untouched", () => {
  const { inv, book } = setup();
  const id = book.place([{ sku: "nut", qty: 2 }]);
  book.fulfill(id);
  assert.throws(() => book.cancel(id), /fulfilled/);
  assert.equal(book.status(id), "fulfilled");
  assert.equal(inv.onHand("nut"), 3);
  assert.equal(inv.reserved("nut"), 0);
});

test("a cancelled order cannot be fulfilled", () => {
  const { inv, book } = setup();
  const id = book.place([{ sku: "nut", qty: 2 }]);
  book.cancel(id);
  assert.throws(() => book.fulfill(id), /cancelled/);
  assert.equal(inv.onHand("nut"), 5);
});

test("preserved: unknown orders, reserve limits and lowStock", () => {
  const { inv, book } = setup();
  assert.throws(() => book.cancel("nope"), /unknown order nope/);
  const id = book.place([{ sku: "nut", qty: 4 }]);
  assert.throws(() => book.place([{ sku: "nut", qty: 2 }]), /insufficient stock for nut/);
  assert.deepEqual(lowStock(inv, 2), [{ sku: "nut", available: 1 }, { sku: "washer", available: 2 }]);
  book.fulfill(id);
  assert.equal(inv.onHand("nut"), 1);
});
