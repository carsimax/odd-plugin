export function trialBalance(ledger) {
  const lines = [];
  let total = 0;
  for (const account of ledger.accounts()) {
    const b = ledger.balance(account);
    total = Math.round((total + b) * 100) / 100;
    lines.push(`${account.padEnd(10)} ${b.toFixed(2).padStart(10)}`);
  }
  lines.push(`${"TOTAL".padEnd(10)} ${total.toFixed(2).padStart(10)}`);
  return lines;
}
