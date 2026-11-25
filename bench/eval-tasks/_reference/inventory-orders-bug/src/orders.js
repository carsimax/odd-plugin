export class OrderBook {
  constructor(inventory) {
    this.inventory = inventory;
    this.orders = new Map();
    this.nextId = 1;
  }

  place(lines) {
    const reserved = [];
    try {
      for (const { sku, qty } of lines) {
        this.inventory.reserve(sku, qty);
        reserved.push({ sku, qty });
      }
    } catch (err) {
      for (const { sku, qty } of reserved) this.inventory.release(sku, qty);
      throw err;
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
    if (order.status === "cancelled") return;
    if (order.status === "fulfilled") throw new Error(`order ${id} is fulfilled`);
    for (const { sku, qty } of order.lines) this.inventory.release(sku, qty);
    order.status = "cancelled";
  }

  status(id) {
    return this.#get(id).status;
  }
}
