import { normalizeAll } from "./tasks.js";
import { renderReport, renderSummary } from "./report.js";
import { slowTaskAlerts } from "./alerts.js";

export function run(argv, records) {
  const [command, ...rest] = argv;
  const tasks = normalizeAll(records);
  if (command === "report") return renderReport(tasks);
  if (command === "summary") return renderSummary(tasks);
  if (command === "alerts") {
    const flag = rest.find((a) => a.startsWith("--budget-seconds="));
    const seconds = flag ? Number(flag.split("=")[1]) : 600;
    const lines = slowTaskAlerts(tasks, seconds * 1000);
    return lines.length === 0 ? "No alerts." : lines.join("\n");
  }
  throw new Error(`Unknown command: ${command}`);
}
