import { parseAmount } from "./money.js";
import { statementLine } from "./statement.js";

export class Ledger {
  constructor() {
    this.entries = [];
  }

  post({ date, memo, from, to, amount }) {
    if (!(amount > 0)) throw new Error("amount must be positive");
    this.entries.push({ date, memo, from, to, cents: parseAmount(amount) });
  }

  #delta(entry, account) {
    let d = 0;
    if (entry.to === account) d += entry.cents;
    if (entry.from === account) d -= entry.cents;
    return d;
  }

  balanceCents(account) {
    let total = 0;
    for (const e of this.entries) total += this.#delta(e, account);
    return total;
  }

  balance(account) {
    return this.balanceCents(account) / 100;
  }

  statement(account) {
    let running = 0;
    const lines = [];
    for (const e of this.entries) {
      const delta = this.#delta(e, account);
      if (delta === 0) continue;
      running += delta;
      lines.push(statementLine(e, delta, running));
    }
    return lines;
  }

  accounts() {
    const set = new Set();
    for (const e of this.entries) {
      set.add(e.from);
      set.add(e.to);
    }
    return [...set].sort();
  }
}
