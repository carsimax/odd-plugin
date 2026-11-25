import { formatDuration } from "./duration.js";
import { percentile } from "./stats.js";

const fmt = (ms) => formatDuration(ms, { hours: true });

export function renderReport(tasks) {
  if (tasks.length === 0) return "No tasks.";
  const width = Math.max(...tasks.map((t) => t.name.length));
  return tasks.map((t) => `${t.name.padEnd(width)}  ${fmt(t.durationMs)}`).join("\n");
}

export function renderSummary(tasks) {
  if (tasks.length === 0) return "No tasks.";
  const durations = tasks.map((t) => t.durationMs);
  const total = durations.reduce((a, b) => a + b, 0);
  const slowest = tasks.reduce((a, b) => (b.durationMs > a.durationMs ? b : a));
  return [
    `Tasks: ${tasks.length}`,
    `Total: ${fmt(total)}`,
    `Median: ${fmt(percentile(durations, 50))}`,
    `Slowest: ${slowest.name} (${fmt(slowest.durationMs)})`,
  ].join("\n");
}
