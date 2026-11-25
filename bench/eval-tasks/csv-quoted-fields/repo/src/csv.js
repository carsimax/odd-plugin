export function parseCsv(text) {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(","));
}

export function parseCsvWithHeader(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows.map((row) => Object.fromEntries(header.map((key, i) => [key, row[i] ?? ""])));
}
