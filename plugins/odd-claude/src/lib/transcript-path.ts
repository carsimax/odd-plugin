// Recording the transcript path of a session, in a module with few dependencies so UserPromptSubmit does not load the stats collector
// (`stats.ts` re-exports `recordTranscriptPath`).
import { isAbsolute } from "node:path";
import { updateSessionState, type StateOptions } from "./state.js";

const MAX_PATH = 4096;

export function validPath(p: unknown): p is string {
  // eslint-disable-next-line no-control-regex
  return typeof p === "string" && p.length <= MAX_PATH && isAbsolute(p) && p.endsWith(".jsonl") && !/[\u0000-\u001f\u007f]/.test(p);
}

/** Persists the latest transcript path of the session (SessionStart / UserPromptSubmit). Never throws, never outputs. */
export function recordTranscriptPath(input: { session_id?: unknown; transcript_path?: unknown }, opts: StateOptions = {}): void {
  const id = input.session_id;
  if (typeof id !== "string" || id === "" || !validPath(input.transcript_path)) return;
  const path = input.transcript_path;
  try {
    updateSessionState(id, (s) => (s.transcriptPath === path ? s : { ...s, transcriptPath: path }), opts);
  } catch {
    // advisory only
  }
}
