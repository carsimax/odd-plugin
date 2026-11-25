import { round } from "./round.js";

// A credit note reverses (part of) an invoice: every amount is negative.
export function createCreditNote({ invoiceId, lines, taxRate = 0 }) {
  const items = lines.map((line) => ({
    description: line.description,
    amount: round(-(line.unitPrice * line.quantity), 2),
  }));
  const net = round(items.reduce((sum, item) => sum + item.amount, 0), 2);
  const tax = round(net * taxRate, 2);
  return { invoiceId, items, net, tax, total: round(net + tax, 2) };
}
