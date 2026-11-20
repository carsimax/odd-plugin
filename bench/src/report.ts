import { aggregateMetrics } from "./metrics.js";
import { RESULT_SCHEMA_ID, type BenchResult, type JourneyRow, type Subject } from "./schema.js";
import { release } from "node:os";

export function buildResult(subject: Subject, rows: JourneyRow[], bin: { binaryPath: string; binaryVersion: string; commit: string }): BenchResult {
  const counts = { passed: 0, failed: 0, unsupported: 0 };
  for (const r of rows) counts[r.status] += 1;
  const withMetrics = rows.flatMap((r) => (r.metrics ? [r.metrics] : []));
  return {
    schema: RESULT_SCHEMA_ID,
    meta: { subject, binary: { path: bin.binaryPath, version: bin.binaryVersion }, node: process.version, os: { platform: process.platform, arch: process.arch, release: release() }, commit: bin.commit, started_at: new Date().toISOString() },
    journeys: rows,
    aggregate: { counts, metrics: withMetrics.length > 0 ? aggregateMetrics(withMetrics) : null },
  };
}
