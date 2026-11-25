export function normalizeTask(record) {
  return { name: record.name, durationMs: Math.max(0, record.finishedAt - record.startedAt) };
}

export function normalizeAll(records) {
  return records.map(normalizeTask);
}
