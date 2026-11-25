// Rounds `value` to `digits` decimals, half up (toward +Infinity), like Math.round.
// The product is trimmed to 15 significant digits first so binary noise (1.005 * 100 = 100.49999999999999)
// does not push an exact decimal half below the half. Math.round keeps the negative-number semantics.
export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number((value * factor).toPrecision(15))) / factor;
}
