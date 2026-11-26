import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MAX_QUEUED,
  PeersError,
  TTL_MS,
  count,
  peek,
  removeMailboxIfEmpty,
  send,
  sessionIds,
  take,
  type PeersErrorCode,
} from "./peers.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const REASON = "needs a review";
/** Distinct valid sender id per index (keeps the per-sender rate limit out of tests about other rules). */
function sender(i: number): string {
  return `7777${String(i).padStart(4, "0")}-7777-4777-8777-777777777777`;
}

function tmp(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "odd-peers-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function code(fn: () => unknown): PeersErrorCode | "no-throw" {
  try {
    fn();
    return "no-throw";
  } catch (err) {
    assert.ok(err instanceof PeersError, String(err));
    return err.code;
  }
}

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      if (n.name.endsWith(".lock")) continue;
      const p = join(d, n.name);
      out.push(p);
      if (n.isDirectory()) walk(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

test("send/take: round trip, trims text, take removes, empty afterwards", () => {
  const t = tmp();
  try {
    const o = { dataDir: t.dir, now: () => 1_000_000 };
    const r = send(B, { from: A, reason: `  ${REASON}  `, message: "  hola  " }, o);
    assert.equal(r.seq, 1);
    assert.equal(r.accepted_at, new Date(1_000_000).toISOString());
    assert.equal(peek(B, o).length, 1);
    assert.equal(count(B, o), 1);
    const got = take(B, o);
    assert.equal(got.length, 1);
    assert.equal(got[0].message, "hola");
    assert.equal(got[0].reason, REASON);
    assert.equal(got[0].from, A);
    assert.equal(got[0].seq, 1);
    assert.equal(got[0].expires_at, new Date(1_000_000 + TTL_MS).toISOString());
    assert.deepEqual(take(B, o), []);
    assert.deepEqual(peek(B, o), []);
    assert.deepEqual(take(C, o), []); // unknown mailbox
    assert.equal(existsSync(join(t.dir, "peers", C)), false); // take never creates a mailbox
  } finally {
    t.done();
  }
});

test("ordering: seq is monotonic, never reused after take, delivered in order", () => {
  const t = tmp();
  try {
    const o = { dataDir: t.dir, now: () => 5 };
    assert.deepEqual([1, 2, 3].map((i) => send(B, { from: A, reason: REASON, message: `m${i}` }, o).seq), [1, 2, 3]);
    assert.deepEqual(take(B, o).map((m) => m.message), ["m1", "m2", "m3"]);
    assert.equal(send(B, { from: A, reason: REASON, message: "m4" }, o).seq, 4);
    // the counter file is only a hint: a lost counter is recovered from the queued files
    rmSync(join(t.dir, "peers", B, ".seq"));
    assert.equal(send(B, { from: A, reason: REASON, message: "m5" }, o).seq, 5);
  } finally {
    t.done();
  }
});

test("limits: message and reason sizes in UTF-8 bytes after trim, typed errors, nothing stored", () => {
  const t = tmp();
  try {
    const o = { dataDir: t.dir, now: () => 1 };
    const ok = (message: string, reason = REASON): unknown => send(B, { from: A, reason, message }, o);
    assert.equal(code(() => ok("x".repeat(8192))), "no-throw");
    const before = snapshot(t.dir);
    assert.equal(code(() => ok("x".repeat(8193))), "invalid_message");
    assert.equal(code(() => ok("é".repeat(4097))), "invalid_message"); // 8194 bytes
    assert.equal(code(() => ok("   ")), "invalid_message");
    assert.equal(code(() => ok("")), "invalid_message");
    assert.equal(code(() => ok("hi", "short")), "invalid_reason");
    assert.equal(code(() => ok("hi", "  1234567  ")), "invalid_reason"); // 7 after trim
    assert.equal(code(() => ok("hi", "12345678")), "no-throw");
    assert.equal(code(() => ok("hi", "é".repeat(256))), "no-throw"); // 512 bytes
    assert.equal(code(() => ok("hi", "é".repeat(257))), "invalid_reason");
    assert.equal(code(() => ok("hi", "r".repeat(513))), "invalid_reason");
    assert.equal(code(() => send(B, { from: A, reason: 5 as unknown as string, message: "m" }, o)), "invalid_reason");
    assert.equal(code(() => send(B, { from: A, reason: REASON, message: 5 as unknown as string }, o)), "invalid_message");
    // only the 3 accepted sends exist; rejected ones changed nothing
    assert.equal(peek(B, o).length, 3);
    assert.ok(before.length > 0);
  } finally {
    t.done();
  }
});

test("rejected sends leave stored data unchanged", () => {
  const t = tmp();
  try {
    const o = { dataDir: t.dir, now: () => 1 };
    send(B, { from: A, reason: REASON, message: "one" }, o);
    const before = snapshot(t.dir);
    assert.equal(code(() => send(B, { from: A, reason: "x", message: "two" }, o)), "invalid_reason");
    assert.equal(code(() => send("../evil", { from: A, reason: REASON, message: "two" }, o)), "invalid_session_id");
    assert.deepEqual(snapshot(t.dir), before);
    assert.equal(send(B, { from: A, reason: REASON, message: "three" }, o).seq, 2);
  } finally {
    t.done();
  }
});

test("TTL: expired messages are never delivered and are swept; boundary is exact", () => {
  const t = tmp();
  try {
    let now = 1_000;
    const o = { dataDir: t.dir, now: () => now };
    send(B, { from: A, reason: REASON, message: "old" }, o);
    now = 1_000 + TTL_MS - 1;
    send(B, { from: A, reason: REASON, message: "young" }, o);
    assert.equal(peek(B, o).length, 2);
    now = 1_000 + TTL_MS; // "old" expires exactly now
    assert.deepEqual(peek(B, o).map((m) => m.message), ["young"]);
    assert.deepEqual(take(B, o).map((m) => m.message), ["young"]);
    assert.deepEqual(readdirSync(join(t.dir, "peers", B)).filter((n) => n.endsWith(".json") && !n.startsWith("rate-")), []);
    // expiry also frees cap room via the sweep in send
    now = 10_000;
    for (let i = 0; i < MAX_QUEUED; i++) send(B, { from: sender(i), reason: REASON, message: `f${i}` }, o);
    assert.equal(code(() => send(B, { from: A, reason: REASON, message: "x" }, o)), "mailbox_full");
    now = 10_000 + TTL_MS;
    assert.equal(code(() => send(B, { from: A, reason: REASON, message: "x" }, o)), "no-throw");
    assert.deepEqual(peek(B, o).map((m) => m.message), ["x"]);
  } finally {
    t.done();
  }
});

test("cap: 50 queued per mailbox, then mailbox_full; other mailboxes unaffected; take frees room", () => {
  const t = tmp();
  try {
    const o = { dataDir: t.dir, now: () => 1 };
    const senders = Array.from({ length: MAX_QUEUED + 1 }, (_, i) => sender(i));
    for (let i = 0; i < MAX_QUEUED; i++) send(B, { from: senders[i], reason: REASON, message: `m${i}` }, o);
    const before = snapshot(t.dir);
    assert.equal(code(() => send(B, { from: senders[MAX_QUEUED], reason: REASON, message: "overflow" }, o)), "mailbox_full");
    assert.deepEqual(snapshot(t.dir), before);
    assert.equal(code(() => send(C, { from: senders[MAX_QUEUED], reason: REASON, message: "fine" }, o)), "no-throw");
    assert.equal(take(B, o).length, MAX_QUEUED);
    assert.equal(code(() => send(B, { from: senders[MAX_QUEUED], reason: REASON, message: "again" }, o)), "no-throw");
  } finally {
    t.done();
  }
});

test("rate limit: 10 per minute per sender->recipient; window slides; other pairs unaffected", () => {
  const t = tmp();
  try {
    let now = 100_000;
    const o = { dataDir: t.dir, now: () => now };
    const go = (to: string, from: string): unknown => send(to, { from, reason: REASON, message: "m" }, o);
    for (let i = 0; i < 10; i++) {
      now = 100_000 + i * 1000;
      go(B, A);
    }
    assert.equal(code(() => go(B, A)), "rate_limited");
    assert.equal(count(B, o), 10);
    assert.equal(code(() => go(B, C)), "no-throw"); // other sender
    assert.equal(code(() => go(C, A)), "no-throw"); // other recipient
    take(B, o); // taking does not reset the budget
    assert.equal(code(() => go(B, A)), "rate_limited");
    now = 100_000 + 60_000; // the first send (t=100_000) leaves the window
    assert.equal(code(() => go(B, A)), "no-throw");
    assert.equal(code(() => go(B, A)), "rate_limited");
  } finally {
    t.done();
  }
});

test("session ids: UUID-like only; bad recipient/sender refused; nothing created outside peers/", () => {
  const t = tmp();
  try {
    const o = { dataDir: t.dir, now: () => 1 };
    const bad = ["", "..", ".", "../x", "a/b", "short", "x".repeat(65), "has space 12345678", "ab\u0000cd1234567", "-1111111-1111", ".hidden-12345678", "é".repeat(10)];
    for (const id of bad) {
      assert.equal(code(() => send(id, { from: A, reason: REASON, message: "m" }, o)), "invalid_session_id", id);
      assert.equal(code(() => send(B, { from: id, reason: REASON, message: "m" }, o)), "invalid_session_id", id);
      assert.equal(code(() => take(id, o)), "invalid_session_id", id);
      assert.equal(code(() => peek(id, o)), "invalid_session_id", id);
    }
    assert.equal(code(() => send(undefined as unknown as string, { from: A, reason: REASON, message: "m" }, o)), "invalid_session_id");
    assert.deepEqual(snapshot(t.dir), []);
    send(B, { from: A, reason: REASON, message: "m" }, o);
    assert.deepEqual(sessionIds(o), [B]);
  } finally {
    t.done();
  }
});

test("data dir resolution: env CLAUDE_PLUGIN_DATA is used, else the home default; a relative dir throws", () => {
  const t = tmp();
  try {
    send(B, { from: A, reason: REASON, message: "m" }, { env: { CLAUDE_PLUGIN_DATA: t.dir }, now: () => 1 });
    assert.ok(existsSync(join(t.dir, "peers", B)));
    const home = join(t.dir, "home");
    send(B, { from: A, reason: REASON, message: "m" }, { env: { ODD_CLAUDE_HOME: home }, now: () => 1 });
    assert.ok(existsSync(join(home, "data", "peers", B)));
    assert.throws(() => send(B, { from: A, reason: REASON, message: "m" }, { dataDir: "rel" }), /absolute/);
  } finally {
    t.done();
  }
});

test("confinement: symlinked peers dir, mailbox dir, or message file are refused/ignored, never followed", () => {
  const t = tmp();
  const outside = tmp();
  try {
    const o = { dataDir: t.dir, now: () => 1 };
    // symlinked peers dir
    symlinkSync(outside.dir, join(t.dir, "peers"));
    assert.equal(code(() => send(B, { from: A, reason: REASON, message: "m" }, o)), "unsafe_path");
    assert.equal(code(() => take(B, o)), "unsafe_path");
    assert.equal(code(() => peek(B, o)), "unsafe_path");
    assert.deepEqual(sessionIds(o), []);
    assert.deepEqual(readdirSync(outside.dir), []);
    rmSync(join(t.dir, "peers"));

    // symlinked mailbox dir
    mkdirSync(join(t.dir, "peers"));
    symlinkSync(outside.dir, join(t.dir, "peers", B));
    assert.equal(code(() => send(B, { from: A, reason: REASON, message: "m" }, o)), "unsafe_path");
    assert.equal(code(() => take(B, o)), "unsafe_path");
    assert.equal(code(() => peek(B, o)), "unsafe_path");
    assert.deepEqual(sessionIds(o), []);
    assert.deepEqual(readdirSync(outside.dir), []);
    rmSync(join(t.dir, "peers", B));

    // symlinked .locks dir
    rmSync(join(t.dir, "peers", ".locks"), { recursive: true, force: true });
    symlinkSync(outside.dir, join(t.dir, "peers", ".locks"));
    assert.equal(code(() => send(B, { from: A, reason: REASON, message: "m" }, o)), "unsafe_path");
    assert.deepEqual(readdirSync(outside.dir), []);
    rmSync(join(t.dir, "peers", ".locks"));

    // symlinked message file pointing outside: not delivered, target untouched
    send(B, { from: A, reason: REASON, message: "real" }, o);
    const secret = join(outside.dir, "secret.json");
    writeFileSync(secret, JSON.stringify({ v: 1, seq: 2, from: A, reason: REASON, message: "leak", accepted_ms: 1 }));
    symlinkSync(secret, join(t.dir, "peers", B, "0000000002.json"));
    assert.deepEqual(take(B, o).map((m) => m.message), ["real"]);
    assert.ok(existsSync(secret));
  } finally {
    t.done();
    outside.done();
  }
});

test("robustness: corrupt, oversized, wrong-seq, directory and temp entries are skipped; real ones still delivered", () => {
  const t = tmp();
  try {
    const o = { dataDir: t.dir, now: () => 1_000 };
    send(B, { from: A, reason: REASON, message: "good" }, o); // seq 1
    const box = join(t.dir, "peers", B);
    writeFileSync(join(box, "0000000002.json"), "{not json");
    writeFileSync(join(box, "0000000003.json"), "x".repeat(200 * 1024));
    writeFileSync(join(box, "0000000004.json"), JSON.stringify({ v: 1, seq: 9, from: A, reason: REASON, message: "m", accepted_ms: 1000 }));
    writeFileSync(join(box, "0000000005.json"), JSON.stringify({ v: 1, seq: 5, from: "../x", reason: REASON, message: "m", accepted_ms: 1000 }));
    mkdirSync(join(box, "0000000006.json"));
    writeFileSync(join(box, "0000000007.json.123.1.tmp"), '{"v":1,"seq":7'); // crashed writer's partial temp
    writeFileSync(join(box, "notes.txt"), "hi");
    assert.deepEqual(peek(B, o).map((m) => m.message), ["good"]);
    assert.deepEqual(take(B, o).map((m) => m.message), ["good"]);
    assert.deepEqual(take(B, o), []);
    // junk does not break the next send and seq still moves forward past every file name seen
    assert.equal(send(B, { from: A, reason: REASON, message: "next" }, o).seq > 1, true);
    assert.deepEqual(take(B, o).map((m) => m.message), ["next"]);
    // old corrupt files and abandoned temps are swept after the TTL
    const later = { dataDir: t.dir, now: () => Date.now() };
    const old = (Date.now() - TTL_MS - 120_000) / 1000;
    for (const f of ["0000000002.json", "0000000003.json", "0000000007.json.123.1.tmp"]) utimesSync(join(box, f), old, old);
    take(B, later);
    assert.equal(existsSync(join(box, "0000000002.json")), false);
    assert.equal(existsSync(join(box, "0000000003.json")), false);
    assert.equal(existsSync(join(box, "0000000007.json.123.1.tmp")), false);
  } finally {
    t.done();
  }
});

test("crash between write and rename leaves no visible partial message", () => {
  const t = tmp();
  try {
    const o = { dataDir: t.dir, now: () => 1_000 };
    send(B, { from: A, reason: REASON, message: "first" }, o);
    const box = join(t.dir, "peers", B);
    // what atomicWriteFile leaves when the writer dies after writing the temp file and before rename
    writeFileSync(join(box, "0000000002.json.99999.1700000000000.tmp"), JSON.stringify({ v: 1, seq: 2, from: A, reason: REASON, message: "ghost", accepted_ms: 1000 }));
    assert.deepEqual(peek(B, o).map((m) => m.message), ["first"]);
    assert.equal(count(B, o), 1);
    assert.deepEqual(take(B, o).map((m) => m.message), ["first"]);
    assert.deepEqual(take(B, o), []);
  } finally {
    t.done();
  }
});

test("a lock left by a dead process does not block sends", () => {
  const t = tmp();
  try {
    const o = { dataDir: t.dir, now: () => 1 };
    send(B, { from: A, reason: REASON, message: "a" }, o);
    // pid 2147483646 is not alive: the lock is stale by proof of death
    writeFileSync(join(t.dir, "peers", ".locks", `${B}.lock`), JSON.stringify({ pid: 2147483646, startedAt: Date.now() }));
    assert.equal(send(B, { from: C, reason: REASON, message: "b" }, o).seq, 2);
    assert.equal(existsSync(join(t.dir, "peers", ".locks", `${B}.lock`)), false); // released
  } finally {
    t.done();
  }
});

const KIT = fileURLToPath(new URL("./peers-child.testkit.js", import.meta.url));

function child(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [KIT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => {
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() ?? "") as Record<string, unknown>);
      } catch {
        reject(new Error(`child exit ${c}: ${out} ${err}`));
      }
    });
  });
}

test("concurrency: 20 sends from 20 processes: distinct seqs 1..20, none lost or duplicated", async () => {
  const t = tmp();
  try {
    const go = join(t.dir, "go");
    mkdirSync(join(t.dir, "data"));
    const data = join(t.dir, "data");
    const runs = Array.from({ length: 20 }, (_, i) =>
      child(["send", data, B, go, `5555${String(i).padStart(4, "0")}-5555-4555-8555-555555555555`, `msg-${i}`]),
    );
    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(go, "");
    const res = await Promise.all(runs);
    assert.ok(res.every((r) => r.ok === true), JSON.stringify(res));
    assert.deepEqual(res.map((r) => r.seq as number).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
    const got = take(B, { dataDir: data });
    assert.deepEqual(got.map((m) => m.seq), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.deepEqual(got.map((m) => m.message).sort(), Array.from({ length: 20 }, (_, i) => `msg-${i}`).sort());
  } finally {
    t.done();
  }
});

test("concurrency: concurrent takes deliver each message exactly once", async () => {
  const t = tmp();
  try {
    const data = join(t.dir, "data");
    mkdirSync(data);
    const o = { dataDir: data };
    for (let i = 0; i < 30; i++) {
      send(B, { from: sender(i), reason: REASON, message: `m${i}` }, o);
    }
    const go = join(t.dir, "go");
    const runs = [0, 1, 2].map(() => child(["take", data, B, go]));
    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(go, "");
    const res = await Promise.all(runs);
    assert.ok(res.every((r) => r.ok === true), JSON.stringify(res));
    const all = res.flatMap((r) => r.texts as string[]);
    assert.equal(all.length, 30);
    assert.equal(new Set(all).size, 30);
    assert.deepEqual(take(B, o), []);
  } finally {
    t.done();
  }
});

test("concurrency: sends racing a take lose nothing and duplicate nothing", async () => {
  const t = tmp();
  try {
    const data = join(t.dir, "data");
    mkdirSync(data);
    send(B, { from: A, reason: REASON, message: "seed" }, { dataDir: data });
    const go = join(t.dir, "go");
    const runs = [
      ...Array.from({ length: 8 }, (_, i) => child(["send", data, B, go, `6666${String(i).padStart(4, "0")}-6666-4666-8666-666666666666`, `r${i}`])),
      child(["take", data, B, go]),
    ];
    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(go, "");
    const res = await Promise.all(runs);
    const taken = res.filter((r) => Array.isArray(r.texts)).flatMap((r) => r.texts as string[]);
    const rest = take(B, { dataDir: data }).map((m) => m.message);
    const all = [...taken, ...rest];
    assert.equal(new Set(all).size, all.length);
    assert.deepEqual(all.sort(), ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "seed"]);
  } finally {
    t.done();
  }
});

test("removeMailboxIfEmpty: a mailbox holding only .seq/rate-* bookkeeping is removed; others stay", () => {
  const t = tmp();
  try {
    const o = { dataDir: t.dir, now: () => 1_000_000 };
    send(B, { from: A, reason: REASON, message: "x" }, o);
    send(C, { from: A, reason: REASON, message: "y" }, o);
    take(B, o);
    assert.deepEqual(readdirSync(join(t.dir, "peers", B)).sort(), [".seq", `rate-${A}.json`]);
    assert.equal(removeMailboxIfEmpty(B, o), true);
    assert.equal(existsSync(join(t.dir, "peers", B)), false);
    assert.equal(existsSync(join(t.dir, "peers", C)), true);
    assert.equal(removeMailboxIfEmpty(B, o), false, "already absent");
    assert.equal(removeMailboxIfEmpty("not a valid id", o), false);
  } finally {
    t.done();
  }
});

test("removeMailboxIfEmpty: a pending message keeps the directory and its files", () => {
  const t = tmp();
  try {
    const o = { dataDir: t.dir, now: () => 1_000_000 };
    send(B, { from: A, reason: REASON, message: "x" }, o);
    const before = readdirSync(join(t.dir, "peers", B)).sort();
    assert.equal(removeMailboxIfEmpty(B, o), false);
    assert.deepEqual(readdirSync(join(t.dir, "peers", B)).sort(), before);
    assert.equal(peek(B, o).length, 1);
  } finally {
    t.done();
  }
});

test("removeMailboxIfEmpty: a foreign file or subdirectory keeps the directory and the bookkeeping", () => {
  const t = tmp();
  try {
    const o = { dataDir: t.dir, now: () => 1_000_000 };
    send(B, { from: A, reason: REASON, message: "x" }, o);
    take(B, o);
    const dir = join(t.dir, "peers", B);
    writeFileSync(join(dir, "notes.txt"), "mine");
    assert.equal(removeMailboxIfEmpty(B, o), false);
    assert.deepEqual(readdirSync(dir).sort(), [".seq", "notes.txt", `rate-${A}.json`]);
    rmSync(join(dir, "notes.txt"));
    mkdirSync(join(dir, "sub"));
    assert.equal(removeMailboxIfEmpty(B, o), false);
    assert.ok(existsSync(join(dir, "sub")));
    assert.ok(existsSync(join(dir, ".seq")));
  } finally {
    t.done();
  }
});

test("removeMailboxIfEmpty: a symlinked mailbox directory is never touched", () => {
  const t = tmp();
  try {
    const o = { dataDir: t.dir, now: () => 1_000_000 };
    mkdirSync(join(t.dir, "peers"), { recursive: true });
    const target = join(t.dir, "elsewhere");
    mkdirSync(target);
    writeFileSync(join(target, ".seq"), "3\n");
    symlinkSync(target, join(t.dir, "peers", B));
    assert.equal(removeMailboxIfEmpty(B, o), false);
    assert.deepEqual(readdirSync(target), [".seq"]);
    assert.ok(existsSync(join(t.dir, "peers", B)));
  } finally {
    t.done();
  }
});
