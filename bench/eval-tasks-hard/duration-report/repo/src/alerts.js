import { formatDuration } from "./duration.js";

export function slowTaskAlerts(tasks, budgetMs) {
  return tasks
    .filter((t) => t.durationMs > budgetMs)
    .map((t) => `ALERT ${t.name} took ${formatDuration(t.durationMs)} (budget ${formatDuration(budgetMs)})`);
}
