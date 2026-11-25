// Ranges are inclusive [start, end] pairs of integers.
export function mergeRanges(ranges) {
  const sorted = ranges.map(([s, e]) => [s, e]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1) {
      last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

export function totalDays(ranges) {
  return mergeRanges(ranges).reduce((n, [s, e]) => n + (e - s + 1), 0);
}
