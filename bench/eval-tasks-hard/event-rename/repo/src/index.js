import { EventBus } from "./events.js";
import { createOrders } from "./orders.js";
import { createInventory } from "./inventory.js";
import { createNotifications } from "./notifications.js";
import { createAnalytics } from "./analytics.js";
import { createWebhooks } from "./webhooks.js";

export { EventBus } from "./events.js";

export function createApp({ stock = {} } = {}) {
  const bus = new EventBus();
  return {
    bus,
    orders: createOrders(bus),
    inventory: createInventory(bus, stock),
    notifications: createNotifications(bus),
    analytics: createAnalytics(bus),
    webhooks: createWebhooks(bus),
  };
}
