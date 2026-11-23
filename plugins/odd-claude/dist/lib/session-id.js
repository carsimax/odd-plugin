// Session-id validation and the peers error type, in a module with no dependencies so a hook that only needs them (UserPromptSubmit)
// does not load the mailbox module (`peers.ts` re-exports both).
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
export function isValidSessionId(id) {
    return typeof id === "string" && SESSION_ID_RE.test(id);
}
export class PeersError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "PeersError";
    }
}
