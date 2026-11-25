import { round } from "./round.js";
import { taxFor } from "./tax.js";

export function lineTotal(line) {
  return round(line.unitPrice * line.quantity, 2);
}

export function subtotal(lines) {
  return round(lines.reduce((sum, line) => sum + lineTotal(line), 0), 2);
}

export function invoiceTotal(invoice) {
  const base = subtotal(invoice.lines);
  const discount = invoice.discount ?? 0;
  const taxable = round(base - discount, 2);
  const tax = taxFor(taxable, invoice.taxRate ?? 0);
  return { subtotal: base, discount, tax, total: round(taxable + tax, 2) };
}
