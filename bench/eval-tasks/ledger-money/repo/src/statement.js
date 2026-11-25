export function statementLine(entry, delta, running) {
  const sign = delta < 0 ? "-" : "+";
  return `${entry.date}  ${entry.memo.padEnd(12)}  ${sign}${Math.abs(delta).toFixed(2)}  ${running.toFixed(2)}`;
}
