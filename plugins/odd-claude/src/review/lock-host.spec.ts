import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { acquireStoreLock, StoreLockContended, storeLockPath } from "./lock.js";

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const B1 = "boot-one/pid:[4026531836]";
const B2 = "boot-one/pid:[4026532999]"; // same boot, another pid namespace (a container)

function tmp(): { root: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "odd-lock-host-"));
  return { root: join(dir, "v2"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function deadPid(): number {
  for (let i = 0; i < 20; i++) {
    const pid = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not obtain a dead pid");
}

function seed(root: string, owner: Record<string, unknown>): string {
  const lock = storeLockPath(root);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ ownerId: "deadbeef", startedAt: 1, ...owner }));
  return lock;
}

const quick = { timeoutMs: 300, pollMs: 10 };

test("same machine id, dead owner, DIFFERENT hostname: taken over", async () => {
  const t = tmp();
  try {
    seed(t.root, { pid: deadPid(), host: "192.168.168.105", machine: M1, boot: B1 });
    const h = await acquireStoreLock(t.root, { ...quick, host: "192.168.1.89", machineId: M1, bootId: B1 });
    const rec = JSON.parse(readFileSync(join(storeLockPath(t.root), "owner.json"), "utf8"));
    assert.equal(rec.host, "192.168.1.89");
    assert.equal(rec.machine, M1);
    assert.equal(rec.boot, B1);
    assert.equal(rec.pid, process.pid);
    assert.deepEqual(h.release(), { status: "released" });
  } finally {
    t.done();
  }
});

test("same machine id, LIVE owner, different hostname: contended, record untouched", async () => {
  const t = tmp();
  try {
    const lock = seed(t.root, { pid: process.pid, host: "elsewhere", machine: M1, boot: B1 });
    const before = readFileSync(join(lock, "owner.json"), "utf8");
    await assert.rejects(
      acquireStoreLock(t.root, { ...quick, host: "other-name", machineId: M1, bootId: B1 }),
      (e: unknown) => e instanceof StoreLockContended && e.owner?.pid === process.pid && /pid \d+ on elsewhere/.test(e.message) && e.message.includes(M1.slice(0, 8)),
    );
    assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), before);
  } finally {
    t.done();
  }
});

test("(d) different machine ids + same hostname + dead pid: hostname rule, taken over", async () => {
  const t = tmp();
  try {
    seed(t.root, { pid: deadPid(), host: "same-host", machine: M2, boot: B1 });
    const h = await acquireStoreLock(t.root, { ...quick, host: "same-host", machineId: M1, bootId: B1 });
    assert.deepEqual(h.release(), { status: "released" });
  } finally {
    t.done();
  }
});

test("different machine ids AND different hostnames: never local, record untouched", async () => {
  const t = tmp();
  try {
    const lock = seed(t.root, { pid: deadPid(), host: "host-a", machine: M2, boot: B1 });
    const before = readFileSync(join(lock, "owner.json"), "utf8");
    await assert.rejects(acquireStoreLock(t.root, { ...quick, host: "host-b", machineId: M1, bootId: B1 }), StoreLockContended);
    assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), before);
  } finally {
    t.done();
  }
});

test("(a) same machine id, DIFFERENT boot identity (other pid namespace), pid in our namespace, other hostname: contended, record byte-identical", async () => {
  for (const pid of [process.pid, deadPid()]) {
    const t = tmp();
    try {
      const lock = seed(t.root, { pid, host: "host-container", machine: M1, boot: B2 });
      const before = readFileSync(join(lock, "owner.json"), "utf8");
      await assert.rejects(acquireStoreLock(t.root, { ...quick, host: "host-mac", machineId: M1, bootId: B1 }), StoreLockContended);
      assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), before);
    } finally {
      t.done();
    }
  }
});

test("(c) same machine id, boot missing on the record or here: hostname rule", async () => {
  const t = tmp();
  try {
    const lock = seed(t.root, { pid: deadPid(), host: "old-host", machine: M1 });
    await assert.rejects(acquireStoreLock(t.root, { ...quick, host: "new-host", machineId: M1, bootId: B1 }), StoreLockContended);
    assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).host, "old-host");
    await assert.rejects(acquireStoreLock(t.root, { ...quick, host: "new-host", machineId: M1, bootId: null }), StoreLockContended);
    const h = await acquireStoreLock(t.root, { ...quick, host: "old-host", machineId: M1, bootId: B1 });
    assert.deepEqual(h.release(), { status: "released" });
    seed(t.root, { pid: deadPid(), host: "old-host", machine: M1, boot: B1 });
    const h2 = await acquireStoreLock(t.root, { ...quick, host: "old-host", machineId: M1, bootId: null });
    assert.deepEqual(h2.release(), { status: "released" });
  } finally {
    t.done();
  }
});

test("a test-supplied host without machineId records no machine and no boot", async () => {
  const t = tmp();
  try {
    const h = await acquireStoreLock(t.root, { ...quick, host: "fake-host" });
    const rec = JSON.parse(readFileSync(join(storeLockPath(t.root), "owner.json"), "utf8"));
    assert.equal(rec.host, "fake-host");
    assert.equal("machine" in rec, false);
    assert.equal("boot" in rec, false);
    assert.deepEqual(h.release(), { status: "released" });
  } finally {
    t.done();
  }
});

test("old record without machine: different hostname stays fail-closed, same hostname is taken over as before", async () => {
  const t = tmp();
  try {
    const lock = seed(t.root, { pid: deadPid(), host: "old-host" });
    const before = readFileSync(join(lock, "owner.json"), "utf8");
    await assert.rejects(acquireStoreLock(t.root, { ...quick, host: "new-host", machineId: M1 }), StoreLockContended);
    assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), before);
    const h = await acquireStoreLock(t.root, { ...quick, host: "old-host", machineId: M1 });
    assert.deepEqual(h.release(), { status: "released" });
  } finally {
    t.done();
  }
});

test("no machine id available (hostname-only): behaves as before, record has no machine", async () => {
  const t = tmp();
  try {
    seed(t.root, { pid: deadPid(), host: hostname(), machine: M1 });
    const h = await acquireStoreLock(t.root, { ...quick, machineId: null });
    const rec = JSON.parse(readFileSync(join(storeLockPath(t.root), "owner.json"), "utf8"));
    assert.equal(rec.machine, undefined);
    assert.equal(rec.host, hostname());
    assert.deepEqual(h.release(), { status: "released" });
  } finally {
    t.done();
  }
});

test("a malformed machine field is ignored (hostname rule applies)", async () => {
  const t = tmp();
  try {
    seed(t.root, { pid: deadPid(), host: "old-host", machine: "not-a-uuid" });
    await assert.rejects(acquireStoreLock(t.root, { ...quick, host: "new-host", machineId: M1 }), StoreLockContended);
  } finally {
    t.done();
  }
});

test("a real process crash (kill -9) after a hostname change is taken over using the persisted id", async () => {
  const t = tmp();
  const state = mkdtempSync(join(tmpdir(), "odd-lock-host-state-"));
  try {
    const ready = join(state, "ready");
    const script = `Promise.all([import("${new URL("./lock.js", import.meta.url).href}"), import("${new URL("./machine-id.js", import.meta.url).href}")]).then(async ([m, id]) => { await m.acquireStoreLock(process.argv[1], { host: "old-name", machineId: id.machineId(), bootId: (await import("${new URL("./boot-id.js", import.meta.url).href}")).bootId() ?? null }); require("node:fs").writeFileSync(process.argv[2], "r"); setInterval(() => {}, 1000); });`;
    const child = spawn(process.execPath, ["-e", script, t.root, ready], { env: { ...process.env, XDG_STATE_HOME: state }, stdio: "ignore" });
    const t0 = Date.now();
    while (!(await import("node:fs")).existsSync(ready)) {
      if (Date.now() - t0 > 10_000) throw new Error("child never acquired");
      await new Promise((r) => setTimeout(r, 20));
    }
    const rec = JSON.parse(readFileSync(join(storeLockPath(t.root), "owner.json"), "utf8"));
    assert.equal(rec.host, "old-name");
    assert.match(rec.machine, /^[0-9a-f-]{36}$/);
    child.kill("SIGKILL");
    await new Promise((r) => child.once("close", r));
    const h = await acquireStoreLock(t.root, { ...quick, host: "new-name", machineId: rec.machine, bootId: rec.boot });
    assert.deepEqual(h.release(), { status: "released" });
  } finally {
    t.done();
    rmSync(state, { recursive: true, force: true });
  }
});
