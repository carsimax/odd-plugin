import { round } from "./round.js";

export function taxFor(amount, rate) {
  return round(amount * rate, 2);
}
