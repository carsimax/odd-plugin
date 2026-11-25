export interface Summary { n: number; mean: number | null; median: number | null; stdev: number | null }

/** Ignores null/non-finite values. Sample stdev (n-1); null when fewer than two values. */
export function summarize(values: readonly (number | null | undefined)[]): Summary {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return { n, mean: null, median: null, stdev: null };
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  const stdev = n < 2 ? null : Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { n, mean, median, stdev };
}
