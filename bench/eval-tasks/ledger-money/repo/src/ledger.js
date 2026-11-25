import { statementLine } from "./statement.js";

export class Ledger {
  constructor() {
    this.entries = [];
  }

  post({ date, memo, from, to, amount }) {
    if (!(amount > 0)) throw new Error("amount must be positive");
    this.entries.push({ date, memo, from, to, amount: Math.round(amount * 100) / 100 });
  }

  #delta(entry, account) {
    let d = 0;
    if (entry.to === account) d += entry.amount;
    if (entry.from === account) d -= entry.amount;
    return d;
  }

  balance(account) {
    let total = 0;
    for (const e of this.entries) total += this.#delta(e, account);
    return Math.round(total * 100) / 100;
  }

  statement(account) {
    let running = 0;
    const lines = [];
    for (const e of this.entries) {
      const delta = this.#delta(e, account);
      if (delta === 0) continue;
      running = Math.round((running + delta) * 100) / 100;
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
