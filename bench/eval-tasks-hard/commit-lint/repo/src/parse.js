// Splits a raw commit message into lines. CRLF and CR count as line breaks, and one trailing line
// break at the end of the message is not a line of its own. The empty message has one empty line.
export function parseMessage(raw) {
  const normalized = String(raw).replace(/\r\n?/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return trimmed.split("\n");
}
