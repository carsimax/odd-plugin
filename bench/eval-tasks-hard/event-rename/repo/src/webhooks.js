import { readFileSync } from "node:fs";

const subscriptions = JSON.parse(readFileSync(new URL("../config/webhooks.json", import.meta.url), "utf8"));

// Records (instead of sending) one delivery per subscribed URL.
export function createWebhooks(bus) {
  const deliveries = [];
  for (const [event, urls] of Object.entries(subscriptions)) {
    bus.on(event, (order) => {
      for (const url of urls) deliveries.push({ url, event, orderId: order.id });
    });
  }
  return { deliveries: () => deliveries.map((d) => ({ ...d })) };
}
