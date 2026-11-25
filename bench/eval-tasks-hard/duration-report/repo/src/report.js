import { formatDuration } from "./duration.js";
import { percentile } from "./stats.js";

export function renderReport(tasks) {
  if (tasks.length === 0) return "No tasks.";
  const width = Math.max(...tasks.map((t) => t.name.length));
  return tasks.map((t) => `${t.name.padEnd(width)}  ${formatDuration(t.durationMs)}`).join("\n");
}

export function renderSummary(tasks) {
  if (tasks.length === 0) return "No tasks.";
  const durations = tasks.map((t) => t.durationMs);
  const total = durations.reduce((a, b) => a + b, 0);
  const slowest = tasks.reduce((a, b) => (b.durationMs > a.durationMs ? b : a));
  return [
    `Tasks: ${tasks.length}`,
    `Total: ${formatDuration(total)}`,
    `Median: ${formatDuration(percentile(durations, 50))}`,
    `Slowest: ${slowest.name} (${formatDuration(slowest.durationMs)})`,
  ].join("\n");
}
