import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { allow } from "../lib/peer-grants.js";
import { count, peek, RATE_LIMIT, MAX_QUEUED, send } from "../lib/peers.js";
import { recordCurrentSession } from "../lib/peers-session.js";
import { writeSessionState } from "../lib/state.js";
import { writeAgentStatus } from "../lib/agent-status.js";
import { coerceArguments, MAX_LISTED, PEERS_TOOLS } from "./peers-tools.js";
import { PeersServer, servePeers } from "./peers-server.js";
import { MAX_LINE_BYTES, SUPPORTED_PROTOCOLS } from "./server-core.js";

const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PEER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const OTHER = "cccccccc-3333-4333-8333-cccccccccccc";

interface Fx {
  dir: string;
  server: PeersServer;
  call: (name: string, args?: unknown) => Promise<{ result?: any; error?: any }>;
}

async function withFx(fn: (f: Fx) => Promise<void>, o: { session?: string | null; now?: () => number } = {}): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "odd-peers-mcp-"));
  try {
    const pid = process.pid;
    const session = o.session === undefined ? ME : o.session;
    if (session !== null) recordCurrentSession(session, pid, { dataDir: dir });
    const server = new PeersServer({ opts: { dataDir: dir, env: {}, ...(o.now ? { now: o.now } : {}) }, pid });
    let n = 0;
    const call = async (name: string, args?: unknown) => {
      const r = await server.handle({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: args === undefined ? { name } : { name, arguments: args } });
      return r as { result?: any; error?: any };
    };
    await fn({ dir, server, call });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const body = (r: { result?: any }): any => JSON.parse(r.result.content[0].text);
const mailboxFiles = (dir: string, id: string): string[] => {
  try { return readdirSync(join(dir, "peers", id)); } catch { return []; }
};

// ---- protocol ----

test("initialize negotiates a supported version, ping answers, notifications get no answer", async () => {
  await withFx(async ({ server }) => {
    const r = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    assert.equal((r?.result as any).protocolVersion, "2024-11-05");
    assert.equal((r?.result as any).serverInfo.name, "odd-claude-peers");
    assert.match((r?.result as any).serverInfo.version, /^\d+\.\d+\.\d+/);
    const r2 = await server.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    assert.equal((r2?.result as any).protocolVersion, SUPPORTED_PROTOCOLS[0]);
    assert.deepEqual((await server.handle({ jsonrpc: "2.0", id: 3, method: "ping" }))?.result, {});
    assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  });
});

test("tools/list exposes exactly the three tools with object schemas and no review/gentle wording", async () => {
  await withFx(async ({ server }) => {
    const r = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (r?.result as any).tools as { name: string; inputSchema: any; description: string }[];
    assert.deepEqual(tools.map((t) => t.name), ["odd_orchestrator_session_id", "odd_orchestrator_list", "odd_orchestrator_send_message"]);
    for (const t of tools) {
      assert.equal(t.inputSchema.type, "object");
      assert.equal(t.inputSchema.additionalProperties, false);
      assert.doesNotMatch(JSON.stringify(t), new RegExp(["tele" + "metry", "analytics", "gen" + "tle", "review"].join("|"), "i"));
    }
    assert.deepEqual(tools[2].inputSchema.required, ["recipient_session_id", "message", "reason"]);
  });
});

test("protocol errors: unknown tool, invalid params, unknown method, invalid request, batch, bad id", async () => {
  await withFx(async ({ server, call }) => {
    assert.equal((await call("nope")).error.code, -32602);
    assert.equal((await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }))?.error?.code, -32602);
    assert.equal((await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "odd_orchestrator_list", arguments: [] } }))?.error?.code, -32602);
    assert.equal((await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call" }))?.error?.code, -32602);
    assert.equal((await server.handle({ jsonrpc: "2.0", id: 1, method: "nope" }))?.error?.code, -32601);
    assert.equal((await server.handle({ method: "ping" }))?.error?.code, -32600);
    assert.equal((await server.handle([]))?.error?.code, -32600);
    assert.equal((await server.handle({ jsonrpc: "2.0", id: {}, method: "ping" }))?.error?.code, -32600);
  });
});

test("serve loop: newline-delimited, parse error, oversize line, replies flushed before the loop ends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-peers-mcp-"));
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c) => chunks.push(String(c)));
    const done = servePeers(input, output, { opts: { dataDir: dir, env: {} }, pid: process.pid });
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{oops\n');
    input.write(`${"x".repeat(MAX_LINE_BYTES + 10)}\n`);
    input.end('{"jsonrpc":"2.0","id":2,"method":"tools/list"}');
    await done;
    const lines = chunks.join("").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 4);
    assert.ok(lines.some((l) => l.id === 1 && l.result !== undefined));
    assert.ok(lines.some((l) => l.error?.code === -32700));
    assert.ok(lines.some((l) => l.error?.code === -32600));
    assert.ok(lines.some((l) => l.id === 2 && l.result.tools.length === 3));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- session id ----

test("odd_orchestrator_session_id: returns the recorded id, or a typed unknown with guidance", async () => {
  await withFx(async ({ call }) => {
    assert.deepEqual(body(await call("odd_orchestrator_session_id")), { session_id: ME, source: "hook" });
  });
  await withFx(async ({ call }) => {
    const r = await call("odd_orchestrator_session_id", {});
    assert.equal(r.result.isError, undefined);
    const b = body(r);
    assert.equal(b.session_id, null);
    assert.equal(b.source, "unknown");
    assert.match(b.guidance, /\/odd-claude:peers/);
  }, { session: null });
});

test("odd_orchestrator_session_id rejects unexpected arguments", async () => {
  await withFx(async ({ call }) => {
    const r = await call("odd_orchestrator_session_id", { extra: 1 });
    assert.equal(r.result.isError, true);
    assert.equal(body(r).error.code, "invalid_input");
  });
});

// ---- list ----

test("odd_orchestrator_list: other sessions with id, cwd, last seen and whether they accept messages from me; self excluded", async () => {
  await withFx(async ({ dir, call }) => {
    writeSessionState(ME, { x: 1 }, { dataDir: dir });
    writeSessionState(PEER, { x: 1 }, { dataDir: dir });
    writeSessionState(OTHER, { x: 1 }, { dataDir: dir });
    writeSessionState("short", { x: 1 }, { dataDir: dir }); // not addressable
    writeAgentStatus(PEER, "idle", "/work/peer", { dataDir: dir });
    allow(PEER, ME, { dataDir: dir }); // PEER accepts messages from ME
    allow(OTHER, PEER, { dataDir: dir }); // OTHER accepts from PEER only
    const b = body(await call("odd_orchestrator_list"));
    assert.equal(b.self, ME);
    assert.equal(b.truncated, false);
    const byId = Object.fromEntries(b.sessions.map((s: any) => [s.session_id, s]));
    assert.deepEqual(Object.keys(byId).sort(), [OTHER, PEER].sort());
    assert.equal(byId[PEER].accepts_messages_from_you, true);
    assert.equal(byId[PEER].cwd, "/work/peer");
    assert.ok(!Number.isNaN(Date.parse(byId[PEER].last_seen)));
    assert.equal(byId[OTHER].accepts_messages_from_you, false);
    assert.ok(!Number.isNaN(Date.parse(byId[OTHER].last_seen)), "falls back to the state file mtime");
    assert.equal(byId[OTHER].cwd, null);
  });
});

test("odd_orchestrator_list: closed by default, bounded, and without my id nobody accepts", async () => {
  await withFx(async ({ dir, call }) => {
    for (let i = 0; i < MAX_LISTED + 5; i++) writeSessionState(`dddddddd-${String(i).padStart(4, "0")}-4111-8111-dddddddddddd`, {}, { dataDir: dir });
    const b = body(await call("odd_orchestrator_list"));
    assert.equal(b.sessions.length, MAX_LISTED);
    assert.equal(b.truncated, true);
    assert.ok(b.sessions.every((s: any) => s.accepts_messages_from_you === false));
  });
  await withFx(async ({ dir, call }) => {
    writeSessionState(PEER, {}, { dataDir: dir });
    allow(PEER, ME, { dataDir: dir });
    const b = body(await call("odd_orchestrator_list"));
    assert.equal(b.self, null);
    assert.equal(b.sessions[0].accepts_messages_from_you, false);
    assert.match(b.note, /peers/);
  }, { session: null });
});

// ---- send ----

const SEND = (over: Record<string, unknown> = {}) => ({ recipient_session_id: PEER, message: "hello peer", reason: "coordinating a refactor", ...over });

test("send: refused without the recipient's grant (typed error, mailbox untouched)", async () => {
  await withFx(async ({ dir, call }) => {
    const r = await call("odd_orchestrator_send_message", SEND());
    assert.equal(r.result.isError, true);
    assert.equal(body(r).error.code, "not_granted");
    assert.equal(existsSync(join(dir, "peers", PEER)), false);
    allow(PEER, OTHER, { dataDir: dir }); // a grant for somebody else is not mine
    assert.equal(body(await call("odd_orchestrator_send_message", SEND())).error.code, "not_granted");
    assert.deepEqual(mailboxFiles(dir, PEER), []);
  });
});

test("send: with a grant it is delivered and answers accepted, not a read receipt", async () => {
  await withFx(async ({ dir, call }) => {
    allow(PEER, ME, { dataDir: dir });
    const r = await call("odd_orchestrator_send_message", SEND());
    assert.equal(r.result.isError, undefined);
    assert.deepEqual(body(r), { accepted: true, seq: 1, note: "accepted, not a read receipt" });
    const msgs = peek(PEER, { dataDir: dir });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].from, ME);
    assert.equal(msgs[0].message, "hello peer");
    assert.equal(body(await call("odd_orchestrator_send_message", SEND())).seq, 2);
  });
});

test("send: unknown own session or sending to myself is refused, nothing written", async () => {
  await withFx(async ({ dir, call }) => {
    allow(PEER, ME, { dataDir: dir });
    const e = body(await call("odd_orchestrator_send_message", SEND()));
    assert.equal(e.error.code, "session_unknown");
    assert.match(e.error.guidance, /\/odd-claude:peers/);
    assert.deepEqual(mailboxFiles(dir, PEER), []);
  }, { session: null });
  await withFx(async ({ dir, call }) => {
    allow(ME, ME, { dataDir: dir });
    assert.equal(body(await call("odd_orchestrator_send_message", SEND({ recipient_session_id: ME }))).error.code, "self_recipient");
    assert.deepEqual(mailboxFiles(dir, ME), []);
  });
});

test("send: rate limit and full mailbox are typed errors and add nothing", async () => {
  await withFx(async ({ dir, call }) => {
    allow(PEER, ME, { dataDir: dir });
    for (let i = 0; i < RATE_LIMIT; i++) assert.equal(body(await call("odd_orchestrator_send_message", SEND({ message: `m${i}` }))).accepted, true);
    const r = await call("odd_orchestrator_send_message", SEND({ message: "one too many" }));
    assert.equal(r.result.isError, true);
    assert.equal(body(r).error.code, "rate_limited");
    assert.equal(count(PEER, { dataDir: dir }), RATE_LIMIT);
  });
  await withFx(async ({ dir, call }) => {
    allow(PEER, ME, { dataDir: dir });
    let t = Date.now() - 600_000; // recent, so the seeded messages are inside the TTL
    const now = () => t;
    for (let i = 0; i < MAX_QUEUED; i++) {
      t += 10_000; // spread over time so the rate limit never trips
      send(PEER, { from: OTHER, reason: "fill the mailbox", message: `f${i}` }, { dataDir: dir, now });
    }
    const r = await call("odd_orchestrator_send_message", SEND());
    assert.equal(body(r).error.code, "mailbox_full");
    assert.equal(count(PEER, { dataDir: dir }), MAX_QUEUED);
  }, { now: () => Date.now() });
});

test("send: invalid ids, oversized message/reason and wrong types are invalid_input and write nothing", async () => {
  await withFx(async ({ dir, call }) => {
    allow(PEER, ME, { dataDir: dir });
    const bad: Record<string, unknown>[] = [
      SEND({ recipient_session_id: "../etc" }),
      SEND({ recipient_session_id: "short" }),
      SEND({ recipient_session_id: 5 }),
      SEND({ message: "" }),
      SEND({ message: "x".repeat(8193) }),
      SEND({ reason: "ab" }), // under 3 UTF-16 units can never reach 8 bytes; 3-7 unit reasons are checked by lib/peers (invalid_reason)
      SEND({ reason: "r".repeat(513) }),
      SEND({ message: 5 }),
      SEND({ extra: true }),
      { message: "hello peer", reason: "coordinating a refactor" },
    ];
    for (const args of bad) {
      const r = await call("odd_orchestrator_send_message", args);
      assert.equal(r.result.isError, true, JSON.stringify(args).slice(0, 60));
      assert.equal(body(r).error.code, "invalid_input");
    }
    assert.deepEqual(mailboxFiles(dir, PEER), []);
  });
});

test("send: byte limits count UTF-8 bytes (multi-byte message over 8192 bytes is refused, nothing written)", async () => {
  await withFx(async ({ dir, call }) => {
    allow(PEER, ME, { dataDir: dir });
    const r = await call("odd_orchestrator_send_message", SEND({ message: "é".repeat(4097) })); // 4097 chars, 8194 bytes
    assert.equal(r.result.isError, true);
    assert.equal(body(r).error.code, "invalid_message");
    assert.deepEqual(mailboxFiles(dir, PEER), []);
    assert.equal(body(await call("odd_orchestrator_send_message", SEND({ message: "é".repeat(4096) }))).accepted, true);
  });
});

test("prototype-safe arguments: __proto__/constructor/prototype keys are rejected for every tool, nothing written", async () => {
  await withFx(async ({ dir, call }) => {
    allow(PEER, ME, { dataDir: dir });
    for (const key of ["__proto__", "constructor", "prototype"]) {
      for (const tool of PEERS_TOOLS) {
        const args = JSON.parse(`{"${key}":{"polluted":true}}`);
        const r = await call(tool.name, args);
        assert.equal(r.result.isError, true, `${tool.name} ${key}`);
        assert.match(body(r).error.message, new RegExp(key));
      }
      const withValid = JSON.parse(`{"recipient_session_id":"${PEER}","message":"hello peer","reason":"coordinating a refactor","${key}":1}`);
      assert.equal((await call("odd_orchestrator_send_message", withValid)).result.isError, true);
    }
    assert.deepEqual(mailboxFiles(dir, PEER), []);
    assert.equal(({} as any).polluted, undefined);
  });
  const c = coerceArguments(JSON.parse('{"a":1}'));
  assert.equal("args" in c && Object.getPrototypeOf(c.args), null);
});

test("outputs never echo message contents and the server writes nothing to stderr or the data dir besides the mailbox", async () => {
  await withFx(async ({ dir, call }) => {
    allow(PEER, ME, { dataDir: dir });
    const secret = "TOPSECRET-CONTENT-123";
    const ok = await call("odd_orchestrator_send_message", SEND({ message: secret }));
    assert.doesNotMatch(JSON.stringify(ok), /TOPSECRET/);
    const bad = await call("odd_orchestrator_send_message", SEND({ message: secret, reason: "no" }));
    assert.doesNotMatch(JSON.stringify(bad), /TOPSECRET/);
    assert.doesNotMatch(JSON.stringify(await call("odd_orchestrator_list")), /TOPSECRET/);
    assert.equal(existsSync(join(dir, "logs")), false);
  });
});

// ---- registration + real process with a fake parent ----

test(".mcp.json registers the `peers` server separately from `review`", () => {
  const raw = JSON.parse(readFileSync(new URL("../../.mcp.json", import.meta.url), "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
  assert.deepEqual(raw.mcpServers.peers, { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/peers-server.js"] });
  assert.ok(raw.mcpServers.review);
});

test("real server process under a fake Claude Code parent: finds the id the SessionStart-style entry recorded and sends with a grant", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-peers-mcp-"));
  try {
    allow(PEER, ME, { dataDir: dir });
    const sessionMod = new URL("../lib/peers-session.js", import.meta.url).href;
    const serverFile = new URL("./peers-server.js", import.meta.url).pathname;
    const hook = `import(${JSON.stringify(sessionMod)}).then(m => m.recordCurrentSession(${JSON.stringify(ME)}, process.ppid, { dataDir: ${JSON.stringify(dir)} }))`;
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "odd_orchestrator_session_id" } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "odd_orchestrator_send_message", arguments: SEND() } },
    ].map((m) => JSON.stringify(m)).join("\n") + "\n";
    const parent = `
      const { spawnSync } = require("node:child_process");
      const env = { PATH: process.env.PATH, CLAUDE_PLUGIN_DATA: ${JSON.stringify(dir)} };
      const h = spawnSync(process.execPath, ["-e", ${JSON.stringify(hook)}], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });
      const s = spawnSync(process.execPath, [${JSON.stringify(serverFile)}], { encoding: "utf8", input: ${JSON.stringify(requests)}, env, timeout: 20000 });
      process.stdout.write(JSON.stringify({ h: h.status, s: s.status, out: s.stdout, err: s.stderr }));
    `;
    const r = spawnSync(process.execPath, ["-e", parent], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout) as { h: number; s: number; out: string; err: string };
    assert.equal(o.h, 0);
    assert.equal(o.s, 0, o.err);
    assert.equal(o.err, "", "nothing on stderr");
    const lines = o.out.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.deepEqual(JSON.parse(lines[1].result.content[0].text), { session_id: ME, source: "hook" });
    assert.deepEqual(JSON.parse(lines[2].result.content[0].text), { accepted: true, seq: 1, note: "accepted, not a read receipt" });
    assert.equal(peek(PEER, { dataDir: dir })[0].from, ME);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("send: reason limit counts UTF-8 bytes, not characters (S4)", async () => {
  await withFx(async ({ dir, call }) => {
    allow(PEER, ME, { dataDir: dir });
    for (const reason of ["éééé", "añadido"]) { // 4 chars / 8 bytes, 7 chars / 8 bytes
      const r = await call("odd_orchestrator_send_message", SEND({ reason }));
      assert.equal(r.result.isError, undefined, reason);
      assert.equal(body(r).accepted, true);
    }
    assert.equal(count(PEER, { dataDir: dir }), 2);
    for (const reason of ["ééé", "abcdefg", "ñandú", "short"]) { // 6, 7, 7 and 5 bytes
      const r = await call("odd_orchestrator_send_message", SEND({ reason }));
      assert.equal(r.result.isError, true, reason);
      assert.equal(body(r).error.code, "invalid_reason", reason);
    }
    assert.equal(count(PEER, { dataDir: dir }), 2);
  });
});

test("send: a `sender`-like argument cannot spoof the sender (S3/S4, risk 2)", async () => {
  await withFx(async ({ dir, call }) => {
    allow(PEER, ME, { dataDir: dir });
    allow(PEER, OTHER, { dataDir: dir });
    for (const key of ["sender", "from", "sender_session_id"]) {
      const r = await call("odd_orchestrator_send_message", SEND({ [key]: OTHER }));
      assert.equal(r.result.isError, true, key);
      assert.equal(body(r).error.code, "invalid_input", key);
      assert.deepEqual(mailboxFiles(dir, PEER), [], key);
    }
    assert.equal(body(await call("odd_orchestrator_send_message", SEND())).accepted, true);
    assert.equal(peek(PEER, { dataDir: dir })[0].from, ME);
  });
});

test("send: refusal order is session_unknown > self > not_granted (risk 2)", async () => {
  await withFx(async ({ call }) => {
    assert.equal(body(await call("odd_orchestrator_send_message", SEND({ recipient_session_id: ME }))).error.code, "session_unknown");
    assert.equal(body(await call("odd_orchestrator_send_message", SEND())).error.code, "session_unknown");
  }, { session: null });
  await withFx(async ({ call }) => {
    assert.equal(body(await call("odd_orchestrator_send_message", SEND({ recipient_session_id: ME }))).error.code, "self_recipient");
    assert.equal(body(await call("odd_orchestrator_send_message", SEND())).error.code, "not_granted");
  });
});
