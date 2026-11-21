import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpProtocolError, mcpOperation } from "./mcp-client.js";

/** A stand-in MCP server: `body` runs in node and speaks (or garbles) the newline-delimited protocol on stdout. */
async function withServer<T>(body: string, fn: (serverPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "odd-bench-mcp-"));
  const file = join(dir, "server.js");
  writeFileSync(file, body);
  try { return await fn(file); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const opts = (serverPath: string) => ({ serverPath, cwd: tmpdir(), env: { PATH: process.env.PATH }, deadlineMs: 5_000 });

test("a server line that is not JSON is a typed protocol failure naming the line, not a crash", async () => {
  await withServer(`process.stdout.write("this is not json\\n"); setTimeout(() => {}, 10000);`, async (serverPath) => {
    await assert.rejects(mcpOperation(opts(serverPath), { method: "tools/list" }), (e: unknown) => {
      assert.ok(e instanceof McpProtocolError, String(e));
      assert.match((e as Error).message, /non-JSON line.*this is not json/);
      return true;
    });
  });
});

test("a well-behaved server still resolves with the tool text, the raw result and the elapsed time", async () => {
  const server = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d; let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    if (m.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\\n");
    if (m.id === 2) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "hello" }], isError: false } }) + "\\n");
  }
});`;
  await withServer(server, async (serverPath) => {
    const r = await mcpOperation(opts(serverPath), { method: "tools/call", params: { name: "x", arguments: {} } });
    assert.equal(r.text, "hello");
    assert.equal(r.isError, false);
    assert.ok(r.ms > 0);
  });
});

test("an aborted operation kills its server and rejects", async () => {
  const ac = new AbortController();
  await withServer(`setTimeout(() => {}, 30000);`, async (serverPath) => {
    const p = mcpOperation({ ...opts(serverPath), signal: ac.signal }, { method: "tools/list" });
    setTimeout(() => ac.abort(), 50);
    const t0 = Date.now();
    await assert.rejects(p, /aborted/);
    assert.ok(Date.now() - t0 < 3_000);
  });
});
