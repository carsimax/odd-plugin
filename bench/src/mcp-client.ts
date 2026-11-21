// Minimal stdio MCP client: ONE fresh server process per operation (so latency includes process start), newline-delimited JSON-RPC.
import { spawn } from "node:child_process";

export interface McpOperation { method: "tools/list" | "tools/call"; params?: unknown }
export interface McpOptions {
  serverPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Per-operation deadline (one server process, spawn to answer). Not the journey's deadline (see `Journey.deadlineMs`). */
  deadlineMs: number;
  /** Aborting kills the server and rejects (the journey ended; nobody waits for this operation any more). */
  signal?: AbortSignal;
}

/** The server broke the protocol (a line that is not JSON): a failure of the product under test, not a crash of the bench. */
export class McpProtocolError extends Error {}
export interface McpResult {
  /** Concatenated text content of a tool result (what the agent sees); empty for tools/list. */
  text: string;
  isError: boolean;
  /** Raw JSON-RPC result. */
  result: unknown;
  /** Wall-clock ms from spawn to the result. */
  ms: number;
}

export function mcpOperation(opts: McpOptions, op: McpOperation): Promise<McpResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error(`mcp ${op.method} aborted before it started`));
    const t0 = performance.now();
    const child = spawn(process.execPath, [opts.serverPath], { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "ignore"] });
    let buf = "", settled = false;
    const finish = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); child.kill("SIGKILL"); fn(); };
    const onAbort = (): void => finish(() => reject(new Error(`mcp ${op.method} aborted`)));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish(() => reject(new Error(`mcp ${op.method} deadline exceeded after ${opts.deadlineMs}ms`))), opts.deadlineMs);
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", () => finish(() => reject(new Error("mcp server exited before answering"))));
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: { id?: number; result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message: string } };
        try { msg = JSON.parse(line); } catch { msg = null as never; }
        if (msg === null || typeof msg !== "object") return finish(() => reject(new McpProtocolError(`mcp server wrote a non-JSON line: ${line.slice(0, 200)}`)));
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: op.method, ...(op.params !== undefined ? { params: op.params } : {}) });
        }
        if (msg.id === 2) {
          const ms = performance.now() - t0;
          if (msg.error) return finish(() => reject(new Error(`mcp error: ${msg.error!.message}`)));
          const text = (msg.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
          finish(() => resolve({ text, isError: msg.result?.isError === true, result: msg.result, ms }));
        }
      }
    });
    const send = (m: unknown): void => void child.stdin.write(JSON.stringify(m) + "\n");
    child.stdin.on("error", () => {});
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "odd-bench", version: "0" } } });
  });
}
