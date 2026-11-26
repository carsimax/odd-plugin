// Shared stdio JSON-RPC plumbing for the plugin's MCP servers (review): types, error builder, newline-delimited line loop
// and the "run only as entry point" check. No SDK, no I/O besides the given streams.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";

export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
/** Longest accepted input line (bytes); a longer line is dropped with an invalid-request error. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export type Id = string | number | null;
export interface Request {
  jsonrpc: "2.0";
  id?: Id;
  method: string;
  params?: unknown;
}
export interface Response {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const rpcError = (id: Id, code: number, message: string, data?: unknown): Response => ({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON-RPC ids 6 and "6" are different ids. */
export const inflightKey = (id: Id | undefined): string => `${typeof id}:${String(id)}`;

/** Reads newline-delimited JSON from `input` and writes responses to `output` until `input` ends and every call settled. */
export function serveLines(input: Readable, output: Writable, handle: (message: unknown) => Promise<Response | undefined>): Promise<void> {
  const pending = new Set<Promise<void>>();
  const send = (r: Response): void => {
    output.write(`${JSON.stringify(r)}\n`);
  };
  const dispatch = (line: string): void => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send(rpcError(null, -32700, "parse error"));
      return;
    }
    const p = handle(message).then(
      (r) => { if (r !== undefined) send(r); },
      (e) => send(rpcError(null, -32603, e instanceof Error ? e.message : "internal error")),
    ).finally(() => pending.delete(p));
    pending.add(p);
  };
  return new Promise<void>((resolve) => {
    let buf = "";
    let dropping = false;
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (dropping) dropping = false;
        else if (line.trim() !== "") {
          if (Buffer.byteLength(line) > MAX_LINE_BYTES) send(rpcError(null, -32600, "message too large"));
          else dispatch(line);
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
      if (!dropping && buf.trim() !== "") dispatch(buf);
      void Promise.all([...pending]).then(() => resolve());
    });
    input.on("error", () => resolve());
  });
}

/** True when `moduleUrl` is the process entry point (symlinks resolved). */
export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

/** Entry-point runner: exits only once stdout has flushed (process.exit would cut a large pending reply on a pipe). */
export function runMain(run: () => Promise<void>): void {
  void run().then(() => {
    process.stdout.write("", () => process.exit(0));
  });
}
