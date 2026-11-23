// Session-id validation and the peers error type, in a module with no dependencies so a hook that only needs them (UserPromptSubmit)
// does not load the mailbox module (`peers.ts` re-exports both).
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

export type PeersErrorCode =
  | "invalid_session_id"
  | "invalid_message"
  | "invalid_reason"
  | "mailbox_full"
  | "rate_limited"
  | "unsafe_path"
  | "lock_timeout";

export class PeersError extends Error {
  constructor(
    public readonly code: PeersErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PeersError";
  }
}
