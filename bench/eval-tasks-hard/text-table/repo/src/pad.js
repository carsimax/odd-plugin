import { displayWidth } from "./width.js";

// Pads `text` with spaces up to `width` cells. `align` is "left" (default) or "right".
export function padCell(text, width, align = "left") {
  const gap = Math.max(0, width - displayWidth(text));
  return align === "right" ? " ".repeat(gap) + text : text + " ".repeat(gap);
}
