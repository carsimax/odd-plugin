// Terminal title (R62). Claude Code accepts a top-level `terminalSequence` hook output limited to OSC 0/1/2/9/99/777 and BEL,
// so the title is a plain OSC 0. The project name comes from the session cwd and is stripped of control characters.
import { basename } from "node:path";

const MAX_NAME = 60;

function cleanName(cwd: string | undefined): string {
  if (typeof cwd !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return basename(cwd).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, MAX_NAME).trim();
}

export function titleSequence(cwd: string | undefined): string {
  const name = cleanName(cwd);
  return `\u001b]0;odd-claude${name === "" ? "" : ` · ${name}`}\u0007`;
}

/** Empty title: the terminal falls back to its own. */
export const CLEAR_TITLE = "\u001b]0;\u0007";
