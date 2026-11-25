import { round } from "./round.js";

const BASE = 4.5;
const PER_KG = 1.2;

export function shippingCost(weightKg) {
  return round(BASE + PER_KG * weightKg, 2);
}
