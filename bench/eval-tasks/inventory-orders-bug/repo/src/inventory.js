export class Inventory {
  constructor() {
    this.stock = new Map();
    this.held = new Map();
  }

  add(sku, qty) {
    this.stock.set(sku, this.onHand(sku) + qty);
  }

  onHand(sku) {
    return this.stock.get(sku) ?? 0;
  }

  reserved(sku) {
    return this.held.get(sku) ?? 0;
  }

  available(sku) {
    return this.onHand(sku) - this.reserved(sku);
  }

  skus() {
    return [...this.stock.keys()].sort();
  }

  reserve(sku, qty) {
    if (qty > this.available(sku)) throw new Error(`insufficient stock for ${sku}`);
    this.held.set(sku, this.reserved(sku) + qty);
  }

  release(sku, qty) {
    this.held.set(sku, this.reserved(sku) - qty);
  }

  consume(sku, qty) {
    this.held.set(sku, this.reserved(sku) - qty);
    this.stock.set(sku, this.onHand(sku) - qty);
  }
}
