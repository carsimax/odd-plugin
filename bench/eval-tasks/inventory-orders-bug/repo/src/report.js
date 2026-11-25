export function lowStock(inventory, threshold) {
  return inventory
    .skus()
    .filter((sku) => inventory.available(sku) <= threshold)
    .map((sku) => ({ sku, available: inventory.available(sku) }));
}
