// Single hook entrypoint: `node dist/hooks/run.js <event>`. Reads the hook JSON on stdin,
// dispatches to the handler registered for <event>, prints the handler's JSON output.
// Fails safe: any error is logged under the data dir and the process exits 0 with no output.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { logError } from "../lib/state.js";
import { postToolUse } from "./post-tool-use.js";
import { sessionEnd } from "./session-end.js";
import { sessionStart } from "./session-start.js";
import { stop } from "./stop.js";
import { stopFailure } from "./stop-failure.js";
import { userPromptSubmit } from "./user-prompt-submit.js";
/** Registered events. Keep minimal: hooks/hooks.json must list exactly these. */
export const defaultHandlers = {
    SessionStart: sessionStart,
    UserPromptSubmit: userPromptSubmit,
    PostToolUse: postToolUse,
    StopFailure: stopFailure,
    Stop: stop,
    SessionEnd: sessionEnd,
};
export function runHook(event, stdin, opts = {}) {
    const handlers = opts.handlers ?? defaultHandlers;
    const handler = Object.hasOwn(handlers, event) ? handlers[event] : undefined;
    if (!handler)
        return { exitCode: 0, stdout: "" };
    try {
        const input = (stdin.trim() === "" ? {} : JSON.parse(stdin));
        const out = handler(input, opts);
        return { exitCode: 0, stdout: out === undefined ? "" : JSON.stringify(out) };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`${event}: ${msg}`, opts);
        return { exitCode: 0, stdout: "" };
    }
}
function main() {
    const event = process.argv[2] ?? "";
    let stdin = "";
    try {
        stdin = readFileSync(0, "utf8");
    }
    catch {
        // no stdin: treat as empty
    }
    const result = runHook(event, stdin);
    if (result.stdout !== "")
        process.stdout.write(result.stdout + "\n");
    process.exitCode = result.exitCode;
}
try {
    if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
        main();
}
catch {
    // fail safe
}
