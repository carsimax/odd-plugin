import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.js";

const items = [{ sku: "pen", qty: 2 }];

test("placing an order emits order.created with the order", () => {
  const app = createApp({ stock: { pen: 10 } });
  const seen = [];
  app.bus.on("order.created", (order) => seen.push(order.id));
  const order = app.orders.place({ customer: "ann", items });
  assert.deepEqual(seen, [order.id]);
  assert.equal(order.status, "new");
});

test("ship and cancel change the status and emit their events", () => {
  const app = createApp();
  const seen = [];
  app.bus.on("order.*", (_, name) => seen.push(name));
  const { id } = app.orders.place({ customer: "ann", items });
  app.orders.ship(id);
  app.orders.cancel(id);
  assert.deepEqual(seen, ["order.created", "order.shipped", "order.cancelled"]);
  assert.equal(app.orders.get(id).status, "cancelled");
  assert.throws(() => app.orders.ship(99), /Unknown order: 99/);
});

test("inventory reserves on placement and restores on cancellation", () => {
  const app = createApp({ stock: { pen: 10 } });
  const { id } = app.orders.place({ customer: "ann", items });
  assert.equal(app.inventory.available("pen"), 8);
  app.orders.cancel(id);
  assert.equal(app.inventory.available("pen"), 10);
});

test("notifications queue messages", () => {
  const app = createApp();
  const { id } = app.orders.place({ customer: "ann", items });
  app.orders.ship(id);
  assert.deepEqual(app.notifications.outbox(), [
    { to: "ann", text: "Order #1 confirmed" },
    { to: "ann", text: "Order #1 is on its way" },
  ]);
});
