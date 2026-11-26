import { ARMS } from "./isolation.js";
import type { EvalOutcome, RunRecord } from "./runner.js";
import { summarize, type Summary } from "./stats.js";

const f = (v: number | null, d = 2): string => (v === null ? "n/a" : v.toFixed(d));
const cell = (s: Summary, d = 2, scale = 1): string => (s.n === 0 ? "n/a" : `${f(s.mean === null ? null : s.mean / scale, d)} / ${f(s.median === null ? null : s.median / scale, d)} / ${f(s.stdev === null ? null : s.stdev / scale, d)}`);

/** report.md: per arm and per task aggregation of the run records. Metric cells read `mean / median / stdev`. */
export function renderReport(records0: readonly RunRecord[], outcome?: Pick<EvalOutcome, "planned" | "stopped" | "spent_usd">): string {
  let records = records0;
  const all = records0;
  const invalid = all.filter((r) => r.status === "invalid");
  records = all.filter((r) => r.status !== "invalid");
  const arms = ARMS.filter((a) => all.some((r) => r.arm === a));
  const lines: string[] = ["# Eval report", ""];
  lines.push(`Runs: ${all.length}${outcome ? ` of ${outcome.planned} planned; recorded cost ${outcome.spent_usd.toFixed(2)} USD` : ""}${invalid.length ? `; ${invalid.length} invalid (excluded from the stats)` : ""}.`);
  if (outcome?.stopped) lines.push("", `Stopped by the budget guard: ${outcome.stopped.reason}; ${outcome.stopped.skipped} runs not started.`);
  lines.push("", "## Per arm", "", "Metric cells read mean / median / stdev (sample stdev; n/a when no data).", "",
    "| arm | runs | pass rate | cost USD | tokens | wall s | subagents | visible tests modified | invalid | runs with denials | mean denials |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const arm of arms) {
    const rs = records.filter((r) => r.arm === arm);
    const graded = rs.filter((r) => r.passed !== null), pass = graded.filter((r) => r.passed).length;
    lines.push(`| ${arm} | ${rs.length} | ${pass}/${graded.length}${graded.length ? ` (${((100 * pass) / graded.length).toFixed(0)}%)` : ""} | ${cell(summarize(rs.map((r) => r.cost_usd)), 3)} | ${cell(summarize(rs.map((r) => r.tokens?.total ?? null)), 0)} | ${cell(summarize(rs.map((r) => r.wall_ms)), 1, 1000)} | ${cell(summarize(rs.map((r) => r.subagents)), 2)} | ${rs.filter((r) => r.visible_tests_modified).length} | ${invalid.filter((r) => r.arm === arm).length} | ${rs.filter((r) => (r.permission_denials ?? 0) > 0).length} | ${f(summarize(rs.map((r) => r.permission_denials ?? null)).mean)} |`);
  }
  const names = [...new Set(records.flatMap((r) => Object.keys(r.checks ?? {})))].sort();
  const rate = (rs: readonly RunRecord[], n: string): string => {
    const g = rs.filter((r) => r.checks && n in r.checks), ok = g.filter((r) => r.checks?.[n]).length;
    return `${ok}/${g.length}${g.length ? ` (${((100 * ok) / g.length).toFixed(0)}%)` : ""}`;
  };
  if (names.length) {
    lines.push("", "Check pass rates per arm:", "", `| arm | ${names.map((n) => `check ${n}`).join(" | ")} |`, `| --- | ${names.map(() => "---").join(" | ")} |`);
    for (const arm of arms) lines.push(`| ${arm} | ${names.map((n) => rate(records.filter((r) => r.arm === arm), n)).join(" | ")} |`);
  }
  const tasks = [...new Set(records.map((r) => r.task))].sort();
  lines.push("", "## Per task", "", `| task | ${arms.map((a) => `${a} pass | ${a} cost USD (mean)`).join(" | ")} |`, `| --- | ${arms.map(() => "--- | ---").join(" | ")} |`);
  for (const t of tasks) {
    const cols = arms.map((a) => {
      const rs = records.filter((r) => r.task === t && r.arm === a), graded = rs.filter((r) => r.passed !== null);
      return `${graded.filter((r) => r.passed).length}/${graded.length} | ${f(summarize(rs.map((r) => r.cost_usd)).mean, 3)}`;
    });
    lines.push(`| ${t} | ${cols.join(" | ")} |`);
  }
  if (names.length) {
    lines.push("", "Check pass rates per task:", "", `| task | ${arms.flatMap((a) => names.map((n) => `${a} ${n}`)).join(" | ")} |`, `| --- | ${arms.flatMap((a) => names.map(() => "---")).join(" | ")} |`);
    for (const t of tasks) lines.push(`| ${t} | ${arms.flatMap((a) => names.map((n) => (rate(records.filter((r) => r.task === t && r.arm === a), n).replace(/ \(.*/, "")))).join(" | ")} |`);
  }
  if (invalid.length) {
    lines.push("", "## Invalid runs (excluded from the stats above)", "", ...arms.map((a) => `- ${a}: ${invalid.filter((r) => r.arm === a).length}`), "", ...invalid.map((r) => `- ${r.run_id}: invalid${r.error ? ` (${r.error})` : ""}`));
  }
  const bad = records.filter((r) => r.status !== "ok");
  if (bad.length) lines.push("", "## Runs with problems", "", ...bad.map((r) => `- ${r.run_id}: ${r.status}${r.error ? ` (${r.error})` : ""}`));
  return lines.join("\n") + "\n";
}
