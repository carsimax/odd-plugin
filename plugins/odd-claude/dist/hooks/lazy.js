// Lazy dispatch of the hook process (T9): each event imports only the handler it needs, on demand, so a cheap event never loads the
// review engine or another event's handler. Same contract as `runHook` (run.ts): fail safe, exit 0, same output bytes.
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { logError, resolveDataDir } from "../lib/state.js";
/**
 * R07 P4: cheap pre-check (same rule as `hasPendingMail`, duplicated here so that a session without queued mail never loads the peers
 * delivery module): a plain mailbox directory for the session id holding at least one message file. Never throws.
 */
export function mailboxHasMail(input, opts) {
    try {
        const sid = input !== null && typeof input === "object" ? input.session_id : undefined;
        if (typeof sid !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/.test(sid))
            return false;
        const dir = join(resolveDataDir(opts), "peers", sid);
        const st = lstatSync(dir);
        if (st.isSymbolicLink() || !st.isDirectory())
            return false;
        return readdirSync(dir).some((n) => /^\d{10}\.json$/.test(n));
    }
    catch {
        return false;
    }
}
async function withPeerMail(event, i, out, o) {
    if (!mailboxHasMail(i, o))
        return out;
    try {
        return (await import("../lib/peers-delivery.js")).mergePeerDelivery(event, i, out, o);
    }
    catch {
        return out; // delivery never fails the hook
    }
}
/**
 * One loader per registered event (the same set as `handlers.ts`; a test pins it against hooks.json).
 *
 * PreToolUse and Stop are guarded by the global RDD switch: a clone override can only disable, so with the global switch not on
 * (unset, off, unreadable, corrupt) the gate allows and Stop stays silent whatever the command or the repository (T6). Those two
 * answer without loading the gate, the settle engine and its risk/status/start dependencies; with the switch on, the full handler runs.
 */
export const lazyHandlers = {
    SessionStart: async (i, o) => withPeerMail("SessionStart", i, (await import("./session-start.js")).sessionStart(i, o), o),
    UserPromptSubmit: async (i, o) => withPeerMail("UserPromptSubmit", i, (await import("./user-prompt-submit.js")).userPromptSubmit(i, o), o),
    PostToolUse: async (i, o) => (await import("./post-tool-use.js")).postToolUse(i, o),
    StopFailure: async (i, o) => (await import("./stop-failure.js")).stopFailure(i, o),
    SubagentStart: async (i, o) => (await import("./subagents.js")).subagentStart(i, o),
    SubagentStop: async (i, o) => (await import("./subagents.js")).subagentStop(i, o),
    SessionEnd: async (i, o) => (await import("./session-end.js")).sessionEnd(i, o),
    // PreToolUse is registered only for the Bash matcher (hooks.json) and `preToolUse` acts only on the Bash delivery gate (it returns
    // undefined for any other tool), so skipping it while the global RDD switch is not on drops nothing. Pinned by lazy.spec.ts.
    PreToolUse: async (i, o) => {
        // A non-object input is not a hook payload: let the full handler run so it fails (and logs) exactly as `runHook` does.
        if (i === null || typeof i !== "object")
            return (await import("./pre-tool-use.js")).preToolUse(i, o);
        try {
            const { isGlobalModeOn } = await import("../review/mode.js");
            if (!isGlobalModeOn(o))
                return undefined;
        }
        catch {
            // the guard is only an optimization: if it cannot run, the full handler decides
        }
        return (await import("./pre-tool-use.js")).preToolUse(i, o);
    },
    Stop: async (i, o) => {
        // Same order as `stop()`: the status write first (a failure there is the dispatcher's), then the guarded settle reminder.
        (await import("../lib/agent-status.js")).recordAgentStatus(i, "idle", o);
        try {
            const { isGlobalModeOn } = await import("../review/mode.js");
            if (!isGlobalModeOn(o))
                return undefined;
            return (await import("./stop.js")).settleReminder(i, o);
        }
        catch (err) {
            logError(`Stop settle: ${err instanceof Error ? err.message : String(err)}`, o);
            return undefined;
        }
    },
};
/** `runHook` with lazily loaded handlers: unknown event or any error is silent with exit 0; errors are logged under the data dir. */
export async function runHookLazy(event, stdin, opts = {}) {
    const handler = Object.hasOwn(lazyHandlers, event) ? lazyHandlers[event] : undefined;
    if (!handler)
        return { exitCode: 0, stdout: "" };
    try {
        const input = (stdin.trim() === "" ? {} : JSON.parse(stdin));
        const out = await handler(input, opts);
        return { exitCode: 0, stdout: out === undefined ? "" : JSON.stringify(out) };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`${event}: ${msg}`, opts);
        return { exitCode: 0, stdout: "" };
    }
}
