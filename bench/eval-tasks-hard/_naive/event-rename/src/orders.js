export function createOrders(bus) {
  const orders = new Map();
  let nextId = 1;

  function transition(id, status, event) {
    const order = orders.get(id);
    if (!order) throw new Error(`Unknown order: ${id}`);
    order.status = status;
    bus.emit(event, order);
    return order;
  }

  return {
    place({ customer, items }) {
      const order = { id: nextId++, customer, items, status: "new" };
      orders.set(order.id, order);
      bus.emit("order.placed", order);
      return order;
    },
    ship: (id) => transition(id, "shipped", "order.shipped"),
    cancel: (id) => transition(id, "cancelled", "order.cancelled"),
    get: (id) => orders.get(id) ?? null,
  };
}
