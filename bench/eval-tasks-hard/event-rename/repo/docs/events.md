# Events

| event | payload | emitted when |
|---|---|---|
| `order.created` | the order | `orders.place()` succeeds |
| `order.shipped` | the order | `orders.ship(id)` |
| `order.cancelled` | the order | `orders.cancel(id)` |

Handlers receive `(payload, eventName)`. Subscribe to `order.*` for all of them.
Webhook subscriptions are configured per event name in `config/webhooks.json`.
