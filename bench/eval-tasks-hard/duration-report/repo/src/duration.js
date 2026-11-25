const pad2 = (n) => String(n).padStart(2, "0");

// 45000 -> "45s"; 307000 -> "5m 07s"; 3723000 -> "62m 03s". Negative input counts as zero.
export function formatDuration(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${pad2(total % 60)}s`;
}
