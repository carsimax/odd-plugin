import { TableError } from "./errors.js";
import { displayWidth } from "./width.js";
import { padCell } from "./pad.js";

function cellText(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function cut(text, width) {
  return displayWidth(text) <= width ? text : text.slice(0, width - 3) + "...";
}

export function renderTable(columns, rows) {
  if (!Array.isArray(columns) || columns.length === 0) throw new TableError("columns must be a non-empty array");
  if (!Array.isArray(rows)) throw new TableError("rows must be an array");
  const keys = new Set();
  for (const col of columns) {
    if (!col.key) throw new TableError("column without a key");
    if (keys.has(col.key)) throw new TableError(`duplicate column ${col.key}`);
    keys.add(col.key);
    if (col.align && !["left", "right"].includes(col.align)) throw new TableError(`invalid align ${col.align}`);
  }
  if (rows.length === 0) return [columns.map((c) => c.title ?? c.key).join(" | ")].join("\n");
  const cols = columns.map((col) => {
    const raw = rows.map((row) => row[col.key]);
    const nonNull = raw.filter((v) => v !== null && v !== undefined);
    const align = col.align ?? (nonNull.length > 0 && nonNull.every((v) => typeof v === "number") ? "right" : "left");
    const texts = [col.title ?? col.key, ...raw.map(cellText)];
    const width = Math.min(col.maxWidth ?? Infinity, Math.max(...texts.map(displayWidth)));
    return { align, width, cells: texts.map((t) => cut(t, width)) };
  });
  const lineAt = (i) => cols.map((c) => padCell(c.cells[i], c.width, c.align)).join(" | ");
  const out = [lineAt(0), cols.map((c) => "-".repeat(c.width)).join("-+-")];
  for (let i = 1; i <= rows.length; i++) out.push(lineAt(i));
  return out.join("\n");
}
