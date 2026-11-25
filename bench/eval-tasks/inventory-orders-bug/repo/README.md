# inventory

A small warehouse model.

- `Inventory` (`src/inventory.js`): stock per SKU. `add`, `onHand`, `reserved`, `available`, `reserve`, `release`, `consume`.
- `OrderBook` (`src/orders.js`): `place(lines)` reserves stock for `[{ sku, qty }]` lines and returns an order id; `fulfill(id)` ships it (stock leaves the warehouse); `cancel(id)` gives the reservation back; `status(id)` is `"placed"`, `"fulfilled"` or `"cancelled"`.
- `lowStock(inventory, threshold)` (`src/report.js`): SKUs whose available stock is at or below the threshold, sorted by SKU.

Run the tests with `npm test`.
