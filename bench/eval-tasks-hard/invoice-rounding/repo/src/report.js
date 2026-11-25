import { round } from "./round.js";
import { invoiceTotal } from "./invoice.js";

export function summarize(invoices) {
  const totals = invoices.map((invoice) => invoiceTotal(invoice).total);
  const sum = round(totals.reduce((a, b) => a + b, 0), 2);
  return { count: invoices.length, total: sum, average: invoices.length === 0 ? 0 : round(sum / invoices.length, 2) };
}
