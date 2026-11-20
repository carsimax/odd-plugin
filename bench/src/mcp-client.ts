// Minimal stdio MCP client: ONE fresh server process per operation (so latency includes process start), newline-delimited JSON-RPC.
import { spawn } from "node:child_process";

export interface McpOperation { method: "tools/list" | "tools/call"; params?: unknown }
export interface McpOptions { serverPath: string; cwd: string; env: NodeJS.ProcessEnv; deadlineMs: number }
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
    const t0 = performance.now();
    const child = spawn(process.execPath, [opts.serverPath], { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "ignore"] });
    let buf = "", settled = false;
    const finish = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); child.kill("SIGKILL"); fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error(`mcp ${op.method} deadline exceeded after ${opts.deadlineMs}ms`))), opts.deadlineMs);
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", () => finish(() => reject(new Error("mcp server exited before answering"))));
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number; result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message: string } };
        if (msg.id === 1) send({ jsonrpc: "2.0", method: "notifications/initialized" }), send({ jsonrpc: "2.0", id: 2, method: op.method, ...(op.params !== undefined ? { params: op.params } : {}) });
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
