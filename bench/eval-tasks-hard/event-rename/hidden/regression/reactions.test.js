import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../src/index.js";

const items = [{ sku: "pen", qty: 1 }];

test("analytics counts order.placed and the other tracked events", () => {
  const app = createApp();
  const { id } = app.orders.place({ customer: "ann", items });
  app.orders.place({ customer: "bob", items });
  app.orders.ship(id);
  assert.equal(app.analytics.count("order.placed"), 2);
  assert.equal(app.analytics.count("order.created"), 0);
  assert.deepEqual(app.analytics.snapshot(), { "order.placed": 2, "order.shipped": 1, "order.cancelled": 0 });
});

test("webhooks deliver order.placed to every subscribed url", () => {
  const app = createApp();
  const { id } = app.orders.place({ customer: "ann", items });
  app.orders.ship(id);
  app.orders.cancel(id);
  assert.deepEqual(app.webhooks.deliveries(), [
    { url: "https://hooks.example.com/orders", event: "order.placed", orderId: 1 },
    { url: "https://erp.example.com/inbound", event: "order.placed", orderId: 1 },
    { url: "https://hooks.example.com/orders", event: "order.shipped", orderId: 1 },
  ]);
});

test("no module still reacts to the old name", () => {
  const app = createApp({ stock: { pen: 5 } });
  assert.equal(app.bus.emit("order.created", { id: 9, customer: "x", items }), 0);
  assert.equal(app.inventory.available("pen"), 5);
  assert.deepEqual(app.webhooks.deliveries(), []);
});
