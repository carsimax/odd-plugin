// Rounds half away from zero on the absolute value, trimming binary noise first.
export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return (Math.sign(value) * Math.round(Number((Math.abs(value) * factor).toPrecision(15)))) / factor;
}
