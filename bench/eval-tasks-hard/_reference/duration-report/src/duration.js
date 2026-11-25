const pad2 = (n) => String(n).padStart(2, "0");

// 45000 -> "45s"; 307000 -> "5m 07s"; 3723000 -> "62m 03s". Negative input counts as zero.
// With { hours: true }, an hour or more is shown as "1h 02m 03s". Alerts keep the minutes-only form.
export function formatDuration(ms, { hours = false } = {}) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  if (total < 60) return `${total}s`;
  if (hours && total >= 3600) {
    return `${Math.floor(total / 3600)}h ${pad2(Math.floor((total % 3600) / 60))}m ${pad2(total % 60)}s`;
  }
  return `${Math.floor(total / 60)}m ${pad2(total % 60)}s`;
}
