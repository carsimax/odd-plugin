import { formatAmount } from "./money.js";

// delta and running are integer cents.
export function statementLine(entry, delta, running) {
  const sign = delta < 0 ? "-" : "+";
  return `${entry.date}  ${entry.memo.padEnd(12)}  ${sign}${formatAmount(Math.abs(delta))}  ${formatAmount(running)}`;
}
