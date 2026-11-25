export function createNotifications(bus) {
  const outbox = [];

  bus.on("order.placed", (order) => outbox.push({ to: order.customer, text: `Order #${order.id} confirmed` }));
  bus.on("order.shipped", (order) => outbox.push({ to: order.customer, text: `Order #${order.id} is on its way` }));

  return { outbox: () => outbox.map((m) => ({ ...m })) };
}
