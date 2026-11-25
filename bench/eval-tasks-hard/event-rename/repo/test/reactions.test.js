import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.js";

const items = [{ sku: "pen", qty: 1 }];

test("analytics counts the tracked events", () => {
  const app = createApp();
  const { id } = app.orders.place({ customer: "ann", items });
  app.orders.place({ customer: "bob", items });
  app.orders.ship(id);
  assert.equal(app.analytics.count("order.created"), 2);
  assert.deepEqual(app.analytics.snapshot(), { "order.created": 2, "order.shipped": 1, "order.cancelled": 0 });
  assert.equal(app.analytics.count("nothing"), 0);
});

test("webhooks record a delivery per subscribed url", () => {
  const app = createApp();
  const { id } = app.orders.place({ customer: "ann", items });
  app.orders.ship(id);
  app.orders.cancel(id);
  assert.deepEqual(app.webhooks.deliveries(), [
    { url: "https://hooks.example.com/orders", event: "order.created", orderId: 1 },
    { url: "https://erp.example.com/inbound", event: "order.created", orderId: 1 },
    { url: "https://hooks.example.com/orders", event: "order.shipped", orderId: 1 },
  ]);
});
