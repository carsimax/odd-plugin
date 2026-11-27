// The black-box half of mcp/review-server.spec.ts: the server entry (resolved by impl.testkit.ts) run as a real process over stdio.
// The in-process protocol and tool tests stay in mcp/review-server.spec.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, REVIEW_TOOL_NAMES } from "./harness.testkit.js";
import { entry } from "./impl.testkit.js";

const spawnServer = () => {
  const server = entry("review-server");
  assert.ok(existsSync(server.args[0]!), server.args[0]);
  return spawn(server.command, server.args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: tmpdir() } });
};

test("the compiled server speaks MCP over stdio: only protocol on stdout, nothing on stderr, exits when stdin closes", async () => {
  const child = spawnServer();
  let out = "";
  let err = "";
  child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
  child.stderr.on("data", (c: Buffer) => { err += c.toString(); });
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  child.stdin.end();
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.equal(err, "");
  const msgs = out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].result.protocolVersion, "2025-06-18");
  assert.deepEqual(msgs[1].result.tools.map((t: { name: string }) => t.name), [...REVIEW_TOOL_NAMES]);
});

test("m2: a large reply is complete when stdin closes right after the request", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odd-mcp-")));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(repo, "b.txt"), "bee\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\nfour\nfive\n");
    const long = (c: string): string => c.repeat(200);
    for (let i = 0; i < 200; i++) {
      const sub = join(repo, `d${i}${long("x")}`, long("y"));
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, `${long("f")}.txt`), `${i}\n`);
    }
    git(repo, "add", "-A");
    const child = spawnServer();
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "review_assess", arguments: { cwd: repo, projection: "staged" } } })}\n`);
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
    const out = Buffer.concat(chunks).toString("utf8");
    assert.ok(out.length > 65536 * 1.5, `the reply is larger than one pipe buffer (${out.length})`);
    assert.ok(out.endsWith("\n"), "the reply ends with a newline");
    const msg = JSON.parse(out) as { id: number; result: { content: { text: string }[] } };
    assert.equal(msg.id, 1);
    const body = JSON.parse(msg.result.content[0]!.text);
    assert.equal(body.outcome, "assessed");
    assert.equal(body.changed_paths_total, 201, "200 new files plus a.txt");
    assert.equal(body.changed_paths.length, 200, "bounded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the server entry exits cleanly on SIGTERM", async () => {
  const child = spawnServer();
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((res) => child.once("exit", (code, signal) => res([code, signal])));
  // Ready = the server answered initialize (a fixed sleep raced node startup under load, so the handlers were not installed yet).
  const ready = new Promise<void>((res) => child.stdout!.once("data", () => res()));
  child.stdin!.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
  await ready;
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
});
