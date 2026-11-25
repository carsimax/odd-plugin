import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../src/index.js";

const items = [{ sku: "pen", qty: 2 }];

test("placing an order emits order.placed with the order and no order.created", () => {
  const app = createApp({ stock: { pen: 10 } });
  const placed = [];
  const created = [];
  app.bus.on("order.placed", (order, name) => placed.push([order.id, name]));
  app.bus.on("order.created", (order) => created.push(order.id));
  const order = app.orders.place({ customer: "ann", items });
  assert.deepEqual(placed, [[order.id, "order.placed"]]);
  assert.deepEqual(created, []);
});

test("the entity wildcard sees the new name and the unchanged ones", () => {
  const app = createApp();
  const seen = [];
  app.bus.on("order.*", (_, name) => seen.push(name));
  const { id } = app.orders.place({ customer: "ann", items });
  app.orders.ship(id);
  app.orders.cancel(id);
  assert.deepEqual(seen, ["order.placed", "order.shipped", "order.cancelled"]);
});

test("inventory reserves on placement and restores on cancellation", () => {
  const app = createApp({ stock: { pen: 10 } });
  const { id } = app.orders.place({ customer: "ann", items });
  assert.equal(app.inventory.available("pen"), 8);
  app.orders.cancel(id);
  assert.equal(app.inventory.available("pen"), 10);
});

test("notifications queue the same messages", () => {
  const app = createApp();
  const { id } = app.orders.place({ customer: "ann", items });
  app.orders.ship(id);
  assert.deepEqual(app.notifications.outbox(), [
    { to: "ann", text: "Order #1 confirmed" },
    { to: "ann", text: "Order #1 is on its way" },
  ]);
});
