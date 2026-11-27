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
import type { Readable, Writable } from "node:stream";
import { pluginRootDir } from "../review/consent.js";
import { killLiveReviewers } from "../review/runner.js";
import { callTool, fail, TOOL_BY_NAME, TOOLS, type ToolDeps } from "./tools.js";
import { inflightKey, isMain, isObject, MAX_LINE_BYTES, rpcError, runMain, serveLines, SUPPORTED_PROTOCOLS, type Id, type Request, type Response } from "./server-core.js";

export { MAX_LINE_BYTES, SUPPORTED_PROTOCOLS };
export type { Response };

export const SERVER_NAME = "odd-review";

const INSTRUCTIONS =
  "Review tools of odd-claude. Start with review_status and follow only the next_transition it returns. Consent is the human's: review_start relays the question, review_answer_consent records only their explicit answer. Reviewers cost money: acknowledge a forecast before they run. Exception: only a standing consent recorded in the feature document `## Log` (asked once per tracked feature, covering only that feature branch's work-unit commit candidates) lets the parent answer consent and acknowledge forecasts for them, never on your own judgment; otherwise the human answers.";

export interface ServerOptions {
  deps?: ToolDeps;
  /** Directory used when a tool call gives no cwd (default: process.cwd()). */
  cwd?: string;
}

function serverVersion(): string {
  try {
    const v = (JSON.parse(readFileSync(join(pluginRootDir(), "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export class ReviewServer {
  private readonly inflight = new Map<string, AbortController>();
  constructor(private readonly opts: ServerOptions = {}) {}

  /** Handles one decoded JSON message; undefined for notifications (nothing to answer). */
  async handle(message: unknown): Promise<Response | undefined> {
    if (Array.isArray(message)) return rpcError(null, -32600, "batch requests are not supported");
    if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      const id = isObject(message) && (typeof message.id === "string" || typeof message.id === "number") ? message.id : null;
      return rpcError(id, -32600, "invalid request");
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const id = message.id;
    if (hasId && typeof id !== "string" && typeof id !== "number") return rpcError(null, -32600, "request id must be a string or a number");
    const req = message as unknown as Request;
    if (!hasId) {
      this.notification(req);
      return undefined;
    }
    const reqId = id as Id;
    switch (req.method) {
      case "initialize": {
        const asked = isObject(req.params) && typeof req.params.protocolVersion === "string" ? req.params.protocolVersion : undefined;
        const version = asked !== undefined && (SUPPORTED_PROTOCOLS as readonly string[]).includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
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

  private notification(req: Request): void {
    if (req.method === "notifications/cancelled" && isObject(req.params) && (typeof req.params.requestId === "string" || typeof req.params.requestId === "number")) {
      this.inflight.get(inflightKey(req.params.requestId))?.abort();
    }
  }

  private async callTool(id: Id, params: unknown): Promise<Response> {
    if (!isObject(params) || typeof params.name !== "string") return rpcError(id, -32602, "tools/call needs params.name");
    if (params.arguments !== undefined && !isObject(params.arguments)) return rpcError(id, -32602, "params.arguments must be an object");
    const tool = TOOL_BY_NAME.get(params.name);
    if (tool === undefined) return rpcError(id, -32602, `unknown tool: ${params.name.slice(0, 100)}`);
    const controller = new AbortController();
    const key = inflightKey(id);
    if (this.inflight.has(key)) return rpcError(id, -32600, "a request with this id is already in flight");
    this.inflight.set(key, controller);
    try {
      const result = await callTool(tool, params.arguments ?? {}, { deps: this.opts.deps ?? {}, signal: controller.signal, defaultCwd: this.opts.cwd ?? process.cwd() });
      return { jsonrpc: "2.0", id, result };
    } catch (e) {
      return { jsonrpc: "2.0", id, result: fail("internal_error", e instanceof Error ? e.message : String(e)) };
    } finally {
      this.inflight.delete(key);
    }
  }
}

/** Reads newline-delimited JSON from `input` and writes responses to `output` until `input` ends and every call settled. */
export function serve(input: Readable, output: Writable, opts: ServerOptions = {}): Promise<void> {
  const server = new ReviewServer(opts);
  return serveLines(input, output, (m) => server.handle(m));
}

if (isMain(import.meta.url)) {
  // Reviewer children are detached process groups: without this they would outlive a stopped server.
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => { killLiveReviewers(); process.exit(0); });
  runMain(() => serve(process.stdin, process.stdout));
}
