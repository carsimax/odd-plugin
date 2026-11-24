// Bounded transcript reading shared by stats and retro: only the tail is read, lines are capped, text is cleaned.
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

/** Only the tail of a transcript is read: a long session never costs more than this. */
export const STATS_TAIL_BYTES = 8 * 1024 * 1024;
/** A single line above this is skipped unparsed (a huge tool result, not a usage record). */
export const STATS_MAX_LINE_BYTES = 2 * 1024 * 1024;

/** Strips escape sequences, control and bidi characters: transcript text is never trusted. */
export function cleanText(s: unknown): string {
  if (typeof s !== "string") return "";
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]?/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u061c\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
      .trim()
  );
}

/** Newlines in bytes [0, end) of the open file, streamed in bounded chunks (never buffers the prefix). */
function countNewlines(fd: number, end: number): number {
  const chunk = Buffer.alloc(1024 * 1024);
  let pos = 0;
  let n = 0;
  while (pos < end) {
    const got = readSync(fd, chunk, 0, Math.min(chunk.length, end - pos), pos);
    if (got <= 0) break;
    for (let i = 0; i < got; i++) if (chunk[i] === 0x0a) n++;
    pos += got;
  }
  return n;
}

/** `firstLine` is the 1-based absolute line number (in the whole file) of the first line of `text`. */
export function readTail(path: string, tailBytes: number = STATS_TAIL_BYTES): { text: string; truncated: boolean; bytes: number; firstLine: number } | undefined {
  if (!statSync(path).isFile()) return undefined; // a FIFO or device would hang
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, size - len + got);
      if (n <= 0) break;
      got += n;
    }
    const text = buf.subarray(0, got).toString("utf8");
    if (size <= len) return { text, truncated: false, bytes: got, firstLine: 1 };
    // A tail read can start mid-line: drop the partial first line.
    const nl = text.indexOf("\n");
    const firstLine = countNewlines(fd, size - len) + (nl >= 0 ? 2 : 1);
    return { text: text.slice(nl + 1), truncated: true, bytes: got, firstLine };
  } finally {
    closeSync(fd);
  }
}
