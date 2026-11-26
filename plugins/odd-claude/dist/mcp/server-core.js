// Shared stdio JSON-RPC plumbing for the plugin's MCP servers (review): types, error builder, newline-delimited line loop
// and the "run only as entry point" check. No SDK, no I/O besides the given streams.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
/** Longest accepted input line (bytes); a longer line is dropped with an invalid-request error. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const rpcError = (id, code, message, data) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
export const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** JSON-RPC ids 6 and "6" are different ids. */
export const inflightKey = (id) => `${typeof id}:${String(id)}`;
/** Reads newline-delimited JSON from `input` and writes responses to `output` until `input` ends and every call settled. */
export function serveLines(input, output, handle) {
    const pending = new Set();
    const send = (r) => {
        output.write(`${JSON.stringify(r)}\n`);
    };
    const dispatch = (line) => {
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            send(rpcError(null, -32700, "parse error"));
            return;
        }
        const p = handle(message).then((r) => { if (r !== undefined)
            send(r); }, (e) => send(rpcError(null, -32603, e instanceof Error ? e.message : "internal error"))).finally(() => pending.delete(p));
        pending.add(p);
    };
    return new Promise((resolve) => {
        let buf = "";
        let dropping = false;
        input.setEncoding("utf8");
        input.on("data", (chunk) => {
            buf += chunk;
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).replace(/\r$/, "");
                buf = buf.slice(nl + 1);
                if (dropping)
                    dropping = false;
                else if (line.trim() !== "") {
                    if (Buffer.byteLength(line) > MAX_LINE_BYTES)
                        send(rpcError(null, -32600, "message too large"));
                    else
                        dispatch(line);
                }
            }
            if (buf.length > MAX_LINE_BYTES) {
                // An unterminated line past the cap: answer once, drop everything up to the next newline.
                send(rpcError(null, -32600, "message too large"));
                buf = "";
                dropping = true;
            }
        });
        input.on("end", () => {
            if (!dropping && buf.trim() !== "")
                dispatch(buf);
            void Promise.all([...pending]).then(() => resolve());
        });
        input.on("error", () => resolve());
    });
}
/** True when `moduleUrl` is the process entry point (symlinks resolved). */
export function isMain(moduleUrl) {
    const entry = process.argv[1];
    if (entry === undefined)
        return false;
    try {
        return moduleUrl === pathToFileURL(realpathSync(entry)).href;
    }
    catch {
        return false;
    }
}
/** Entry-point runner: exits only once stdout has flushed (process.exit would cut a large pending reply on a pipe). */
export function runMain(run) {
    void run().then(() => {
        process.stdout.write("", () => process.exit(0));
    });
}
