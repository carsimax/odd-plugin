// Rounds `value` to `digits` decimals, half up (toward +Infinity), like Math.round.
export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
