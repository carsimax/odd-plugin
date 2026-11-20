// Review MCP server (U15): the plugin's stdio MCP server, `node dist/mcp/review-server.js` (registered as server `review` in
// `.mcp.json`). Minimal JSON-RPC 2.0 / MCP over stdio, newline-delimited, no SDK dependency:
//   initialize, notifications/initialized, ping, tools/list, tools/call, notifications/cancelled.
// stdout carries protocol messages only; nothing is written to stderr or sent anywhere else.
//
// Error model: protocol problems are JSON-RPC errors (-32700 parse, -32600 invalid request, -32601 unknown method, -32602 invalid
// params / unknown tool); a tool that runs and refuses, or whose arguments violate its schema, is a normal result with
// `isError: true` and a typed body `{error:{code,message,...}}` so the model can read and correct it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { pluginRootDir } from "../review/consent.js";
import { callTool, fail, TOOL_BY_NAME, TOOLS } from "./tools.js";
export const SERVER_NAME = "odd-claude-review";
export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
/** Longest accepted input line (bytes); a longer line is dropped with an invalid-request error. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
const INSTRUCTIONS = "Review tools of the odd-claude plugin. Start with review_status and follow only the next_transition it returns. Consent is the human's: review_start relays the question, review_answer_consent records only their explicit answer. Reviewers cost money: acknowledge a forecast before they run.";
const rpcError = (id, code, message, data) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
function serverVersion() {
    try {
        const v = JSON.parse(readFileSync(join(pluginRootDir(), "package.json"), "utf8")).version;
        return typeof v === "string" ? v : "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
/** JSON-RPC ids 6 and "6" are different ids. */
const inflightKey = (id) => `${typeof id}:${String(id)}`;
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
export class ReviewServer {
    opts;
    inflight = new Map();
    constructor(opts = {}) {
        this.opts = opts;
    }
    /** Handles one decoded JSON message; undefined for notifications (nothing to answer). */
    async handle(message) {
        if (Array.isArray(message))
            return rpcError(null, -32600, "batch requests are not supported");
        if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
            const id = isObject(message) && (typeof message.id === "string" || typeof message.id === "number") ? message.id : null;
            return rpcError(id, -32600, "invalid request");
        }
        const hasId = Object.prototype.hasOwnProperty.call(message, "id");
        const id = message.id;
        if (hasId && typeof id !== "string" && typeof id !== "number")
            return rpcError(null, -32600, "request id must be a string or a number");
        const req = message;
        if (!hasId) {
            this.notification(req);
            return undefined;
        }
        const reqId = id;
        switch (req.method) {
            case "initialize": {
                const asked = isObject(req.params) && typeof req.params.protocolVersion === "string" ? req.params.protocolVersion : undefined;
                const version = asked !== undefined && SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
                return { jsonrpc: "2.0", id: reqId, result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: serverVersion() }, instructions: INSTRUCTIONS } };
            }
            case "ping":
                return { jsonrpc: "2.0", id: reqId, result: {} };
            case "tools/list":
                return {
                    jsonrpc: "2.0", id: reqId,
                    result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) },
                };
            case "tools/call":
                return this.callTool(reqId, req.params);
            default:
                return rpcError(reqId, -32601, `method not found: ${req.method.slice(0, 100)}`);
        }
    }
    notification(req) {
        if (req.method === "notifications/cancelled" && isObject(req.params) && (typeof req.params.requestId === "string" || typeof req.params.requestId === "number")) {
            this.inflight.get(inflightKey(req.params.requestId))?.abort();
        }
    }
    async callTool(id, params) {
        if (!isObject(params) || typeof params.name !== "string")
            return rpcError(id, -32602, "tools/call needs params.name");
        if (params.arguments !== undefined && !isObject(params.arguments))
            return rpcError(id, -32602, "params.arguments must be an object");
        const tool = TOOL_BY_NAME.get(params.name);
        if (tool === undefined)
            return rpcError(id, -32602, `unknown tool: ${params.name.slice(0, 100)}`);
        const controller = new AbortController();
        const key = inflightKey(id);
        if (this.inflight.has(key))
            return rpcError(id, -32600, "a request with this id is already in flight");
        this.inflight.set(key, controller);
        try {
            const result = await callTool(tool, params.arguments ?? {}, { deps: this.opts.deps ?? {}, signal: controller.signal, defaultCwd: this.opts.cwd ?? process.cwd() });
            return { jsonrpc: "2.0", id, result };
        }
        catch (e) {
            return { jsonrpc: "2.0", id, result: fail("internal_error", e instanceof Error ? e.message : String(e)) };
        }
        finally {
            this.inflight.delete(key);
        }
    }
}
/** Reads newline-delimited JSON from `input` and writes responses to `output` until `input` ends and every call settled. */
export function serve(input, output, opts = {}) {
    const server = new ReviewServer(opts);
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
        const p = server.handle(message).then((r) => { if (r !== undefined)
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
function isMain() {
    const entry = process.argv[1];
    if (entry === undefined)
        return false;
    try {
        return import.meta.url === pathToFileURL(realpathSync(entry)).href;
    }
    catch {
        return false;
    }
}
if (isMain()) {
    // Exit only once stdout has flushed what was written: process.exit would cut a large pending reply on a pipe.
    void serve(process.stdin, process.stdout).then(() => {
        process.stdout.write("", () => process.exit(0));
    });
}
