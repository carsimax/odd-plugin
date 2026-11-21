import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "./run.js";
import { runHookLazy } from "./lazy.js";
import { allow, isAllowed, revoke } from "../lib/peer-grants.js";
import { count, send } from "../lib/peers.js";
import { PEER_PREAMBLE } from "../lib/peers-delivery.js";

const R = "rrrrrrrr-1111-4111-8111-rrrrrrrrrrrr";
const S = "ssssssss-2222-4222-8222-ssssssssssss";
const T = "tttttttt-3333-4333-8333-tttttttttttt";
const NOW = Date.now() - 60_000;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-hdeliv-"));
}
function put(dir: string, from: string, message: string): void {
  send(R, { from, reason: "status update", message }, { dataDir: dir, now: () => NOW });
}
const ups = (dir: string, prompt: string, session: unknown = R) => runHook("UserPromptSubmit", JSON.stringify({ session_id: session, prompt }), { dataDir: dir, env: {} });
const start = (dir: string, source: string, session: unknown = R) => runHook("SessionStart", JSON.stringify({ session_id: session, source }), { dataDir: dir, env: {} });
const ctx = (r: { stdout: string }): string => (r.stdout === "" ? "" : (JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string));

test("UserPromptSubmit delivers pending peer messages in order as additionalContext, once", () => {
  const dir = tmp();
  try {
    allow(R, S, { dataDir: dir });
    put(dir, S, "alpha message");
    put(dir, S, "beta message");
    const r = ups(dir, "hola, sigue");
    assert.equal(r.exitCode, 0);
    const c = ctx(r);
    assert.ok(c.includes(PEER_PREAMBLE));
    assert.match(c, /<peer-messages untrusted="true"/);
    assert.ok(c.indexOf("alpha message") < c.indexOf("beta message"));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(count(R, { dataDir: dir }), 0);
    // next prompt: nothing again
    assert.ok(!ctx(ups(dir, "otra cosa")).includes("peer-messages"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStart delivers on compact (grants kept); startup/resume/clear start closed: queued mail is kept, not delivered, and arrives on the next prompt once re-allowed", () => {
  const dir = tmp();
  try {
    allow(R, S, { dataDir: dir });
    put(dir, S, "after compact");
    const r = start(dir, "compact");
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, "SessionStart");
    assert.ok(ctx(r).includes("after compact"));
    assert.ok(ctx(r).includes("odd-claude")); // the normal session context is still there
    assert.equal(count(R, { dataDir: dir }), 0);
    assert.equal(ctx(start(dir, "compact")).includes("peer-messages"), false); // no duplicate
    for (const source of ["startup", "resume", "clear"]) {
      allow(R, S, { dataDir: dir });
      put(dir, S, `queued while away (${source})`);
      const out = start(dir, source);
      assert.ok(!ctx(out).includes("queued while away"), source);
      assert.equal(isAllowed(R, S, { dataDir: dir }), false); // SessionStart A1 revoked it
      assert.equal(count(R, { dataDir: dir }), 1, source); // kept, not dropped
      assert.ok(!ctx(ups(dir, "hola otra vez")).includes("queued while away"), source); // still closed: not delivered
      assert.equal(count(R, { dataDir: dir }), 1, source);
      const c = ctx(ups(dir, `/odd-claude:peers allow ${S}`)); // human re-allows: delivered with the confirmation
      assert.match(c, /Peer grant recorded/);
      assert.ok(c.includes(`queued while away (${source})`), source);
      assert.equal(count(R, { dataDir: dir }), 0, source);
      assert.ok(!ctx(ups(dir, "siguiente")).includes("queued while away")); // once
      revoke(R, S, { dataDir: dir });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coexists with the language anchor and with the grant confirmation in ONE additionalContext; the grant is still recorded", () => {
  const dir = tmp();
  try {
    allow(R, T, { dataDir: dir });
    put(dir, T, "from granted T");
    const anchored = ctx(ups(dir, "Por favor revisa el estado del repositorio ahora mismo"));
    assert.ok(anchored.includes("from granted T"));
    assert.ok(anchored.length > anchored.indexOf("<peer-messages")); // delivery appended, anchor (if any) kept before it
    // grant command + pending mail of the sender being granted: both in one block, grant recorded
    put(dir, S, "queued by S");
    put(dir, T, "from T again");
    const r = ups(dir, `/odd-claude:peers allow ${S}`);
    const c = ctx(r);
    assert.match(c, new RegExp(`Peer grant recorded: session ${R} accepts messages from ${S}`));
    assert.ok(c.indexOf("Peer grant recorded") < c.indexOf("<peer-messages"));
    assert.ok(c.includes("queued by S") && c.includes("from T again"));
    assert.equal(isAllowed(R, S, { dataDir: dir }), true);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, c);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no mailbox: output is exactly what it was without the feature (no peer text, same bytes as an unrelated fresh data dir)", () => {
  const a = tmp();
  const b = tmp();
  try {
    const input = "Por favor revisa el estado del repositorio ahora mismo";
    assert.equal(ups(a, input).stdout, ups(b, input).stdout);
    assert.ok(!ups(a, input).stdout.includes("peer-messages"));
    assert.equal(ups(a, "hola").exitCode, 0);
    assert.ok(!start(a, "compact").stdout.includes("peer-messages"));
    // someone else's mailbox does not touch this session
    send(S, { from: T, reason: "status update", message: "not for R" }, { dataDir: a });
    assert.ok(!ups(a, input).stdout.includes("peer-messages"));
    assert.equal(count(S, { dataDir: a }), 1);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("lazy dispatch gives the same bytes as the eager handlers (UserPromptSubmit and SessionStart)", async () => {
  const a = tmp();
  const b = tmp();
  try {
    for (const dir of [a, b]) {
      allow(R, S, { dataDir: dir });
      put(dir, S, "parity message");
    }
    const eager = ups(a, "hola");
    const lazy = await runHookLazy("UserPromptSubmit", JSON.stringify({ session_id: R, prompt: "hola" }), { dataDir: b, env: {} });
    assert.ok(ctx(eager).includes("parity message"));
    assert.equal(lazy.stdout.split(b).join(a), eager.stdout);
    for (const dir of [a, b]) {
      allow(R, S, { dataDir: dir });
      put(dir, S, "parity start");
    }
    const e2 = start(a, "compact");
    const l2 = await runHookLazy("SessionStart", JSON.stringify({ session_id: R, source: "compact" }), { dataDir: b, env: {} });
    assert.ok(ctx(e2).includes("parity start"));
    assert.equal(ctx(l2).split(b).join(a), ctx(e2)); // only the per-dir scratch path differs
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("a corrupt or symlinked mailbox never fails the hook", async () => {
  const dir = tmp();
  const other = tmp();
  try {
    allow(R, S, { dataDir: dir });
    put(dir, S, "ok");
    writeFileSync(join(dir, "peers", R, "0000000050.json"), "\u0000garbage");
    writeFileSync(join(dir, "peers", R, "0000000051.json"), "x".repeat(300_000));
    const r = ups(dir, "hola");
    assert.equal(r.exitCode, 0);
    assert.ok(ctx(r).includes("ok"));
    rmSync(join(dir, "peers", R), { recursive: true, force: true });
    mkdirSync(join(other, "m"));
    writeFileSync(join(other, "m", "0000000001.json"), "{}");
    symlinkSync(join(other, "m"), join(dir, "peers", R));
    for (const run of [
      ups(dir, "hola"),
      start(dir, "compact"),
      await runHookLazy("UserPromptSubmit", JSON.stringify({ session_id: R, prompt: "hola" }), { dataDir: dir, env: {} }),
      await runHookLazy("SessionStart", JSON.stringify({ session_id: R, source: "compact" }), { dataDir: dir, env: {} }),
    ]) {
      assert.equal(run.exitCode, 0);
      assert.ok(!run.stdout.includes("peer-messages"));
    }
    // invalid session id / garbage prompt: still fine
    assert.equal(ups(dir, "hola", "../x").exitCode, 0);
    assert.equal(ups(dir, "hola", 42).exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
