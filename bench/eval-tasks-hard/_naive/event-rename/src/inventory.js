export function createInventory(bus, stock = {}) {
  const levels = { ...stock };

  bus.on("order.placed", (order) => {
    for (const { sku, qty } of order.items) levels[sku] = (levels[sku] ?? 0) - qty;
  });
  bus.on("order.cancelled", (order) => {
    for (const { sku, qty } of order.items) levels[sku] = (levels[sku] ?? 0) + qty;
  });

  return { available: (sku) => levels[sku] ?? 0 };
}
