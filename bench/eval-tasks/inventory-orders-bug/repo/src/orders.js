export class OrderBook {
  constructor(inventory) {
    this.inventory = inventory;
    this.orders = new Map();
    this.nextId = 1;
  }

  place(lines) {
    for (const { sku, qty } of lines) {
      this.inventory.reserve(sku, qty);
    }
    const id = `o${this.nextId++}`;
    this.orders.set(id, { lines: lines.map((l) => ({ ...l })), status: "placed" });
    return id;
  }

  #get(id) {
    const order = this.orders.get(id);
    if (!order) throw new Error(`unknown order ${id}`);
    return order;
  }

  fulfill(id) {
    const order = this.#get(id);
    if (order.status !== "placed") throw new Error(`order ${id} is ${order.status}`);
    for (const { sku, qty } of order.lines) this.inventory.consume(sku, qty);
    order.status = "fulfilled";
  }

  cancel(id) {
    const order = this.#get(id);
    for (const { sku, qty } of order.lines) this.inventory.release(sku, qty);
    order.status = "cancelled";
  }

  status(id) {
    return this.#get(id).status;
  }
}
