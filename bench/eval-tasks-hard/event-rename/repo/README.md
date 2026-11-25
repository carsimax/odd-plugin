# shop-events

Order lifecycle with an in-process event bus. Several modules react to order events.

- `src/events.js`: `EventBus` (`on`, `emit`; `entity.*` subscribes to every event of an entity).
- `src/orders.js`: place, ship and cancel orders; emits the order events.
- `src/inventory.js`: reserves stock when an order is created and gives it back when cancelled.
- `src/notifications.js`: queues customer messages in an outbox.
- `src/analytics.js`: counts the tracked events.
- `src/webhooks.js`: records one delivery per subscribed URL; subscriptions live in `config/webhooks.json`.
- `src/index.js`: `createApp({ stock })` wires everything.

The events are listed in `docs/events.md`. Run the tests with `npm test`.
