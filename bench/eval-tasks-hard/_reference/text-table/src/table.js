import { TableError } from "./errors.js";
import { displayWidth } from "./width.js";
import { padCell } from "./pad.js";

const ALIGNS = ["left", "right"];

function validate(columns, rows) {
  if (!Array.isArray(columns) || columns.length === 0) throw new TableError("columns must be a non-empty array");
  const seen = new Set();
  columns.forEach((col, i) => {
    if (col === null || typeof col !== "object" || typeof col.key !== "string" || col.key === "") {
      throw new TableError(`column ${i + 1} has no key`);
    }
    if (seen.has(col.key)) throw new TableError(`duplicate column key "${col.key}"`);
    seen.add(col.key);
    if (col.align !== undefined && !ALIGNS.includes(col.align)) {
      throw new TableError(`unknown align "${col.align}" for column "${col.key}"`);
    }
    if (col.maxWidth !== undefined && !(Number.isInteger(col.maxWidth) && col.maxWidth >= 2)) {
      throw new TableError(`maxWidth for column "${col.key}" must be an integer of at least 2`);
    }
  });
  if (!Array.isArray(rows)) throw new TableError("rows must be an array");
  rows.forEach((row, i) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw new TableError(`row ${i + 1} is not an object`);
  });
}

function cellText(value) {
  let text;
  if (value === null || value === undefined) text = "";
  else if (typeof value === "boolean") text = value ? "yes" : "no";
  else if (value instanceof Date) text = value.toISOString().slice(0, 10);
  else text = String(value);
  return text.replace(/\r\n|\n|\r/g, "⏎").replace(/\t/g, " ");
}

function cut(text, width) {
  if (displayWidth(text) <= width) return text;
  return Array.from(text).slice(0, width - 1).join("") + "…";
}

export function renderTable(columns, rows) {
  validate(columns, rows);
  if (rows.length === 0) return "(no rows)";
  const cols = columns.map((col) => {
    const raw = rows.map((row) => row[col.key]);
    const nonNull = raw.filter((v) => v !== null && v !== undefined);
    const align = col.align ?? (nonNull.length > 0 && nonNull.every((v) => typeof v === "number") ? "right" : "left");
    const cap = col.maxWidth ?? Infinity;
    const title = col.title ?? col.key;
    const texts = [title, ...raw.map(cellText)];
    const width = Math.min(cap, Math.max(...texts.map(displayWidth)));
    return { align, width, cells: texts.map((t) => cut(t, width)) };
  });
  const lineAt = (i) => cols.map((c) => padCell(c.cells[i], c.width, c.align)).join(" | ").trimEnd();
  const separator = cols.map((c) => "-".repeat(c.width)).join("-+-");
  const out = [lineAt(0), separator];
  for (let i = 1; i <= rows.length; i++) out.push(lineAt(i));
  return out.join("\n");
}
