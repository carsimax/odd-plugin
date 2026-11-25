import { formatAmount } from "./money.js";

export function trialBalance(ledger) {
  const lines = [];
  let total = 0;
  for (const account of ledger.accounts()) {
    const cents = ledger.balanceCents(account);
    total += cents;
    lines.push(`${account.padEnd(10)} ${formatAmount(cents).padStart(10)}`);
  }
  lines.push(`${"TOTAL".padEnd(10)} ${formatAmount(total).padStart(10)}`);
  return lines;
}
