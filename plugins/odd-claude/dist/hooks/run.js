// Single hook entrypoint: `node dist/hooks/run.js <event>`. Reads the hook JSON on stdin,
// dispatches to the handler registered for <event>, prints the handler's JSON output.
// Fails safe: any error is logged under the data dir and the process exits 0 with no output.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { logError } from "../lib/state.js";
/**
 * Registered events with every handler loaded eagerly (see `handlers.ts`), for callers that import this module (tests, tools): populated
 * on import. When this module is the hook entrypoint (`node dist/hooks/run.js <event>`) nothing eager is loaded: the process dispatches
 * through `lazy.ts`, which imports only the handler its event needs.
 */
export const defaultHandlers = {};
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
async function main() {
    const event = process.argv[2] ?? "";
    let stdin = "";
    try {
        stdin = readFileSync(0, "utf8");
    }
    catch {
        // no stdin: treat as empty
    }
    const { runHookLazy } = await import("./lazy.js");
    const result = await runHookLazy(event, stdin);
    if (result.stdout !== "")
        process.stdout.write(result.stdout + "\n");
    process.exitCode = result.exitCode;
}
let isEntrypoint = false;
try {
    isEntrypoint = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}
catch {
    // fail safe
}
if (isEntrypoint) {
    try {
        await main();
    }
    catch {
        // fail safe
    }
}
else {
    Object.assign(defaultHandlers, (await import("./handlers.js")).handlers);
}
