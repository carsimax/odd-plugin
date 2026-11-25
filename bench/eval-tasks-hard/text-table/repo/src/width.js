// Width of a string in terminal cells, counted in Unicode code points.
export function displayWidth(text) {
  return Array.from(String(text)).length;
}
