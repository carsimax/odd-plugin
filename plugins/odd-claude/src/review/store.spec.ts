import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs, { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./canonical.js";
import { burn, admitLensResult, approve, start, stateRevision, type StateRecord } from "./state.js";
import {
  MAX_STATE_BYTES,
  StoreAlreadyExistsError,
  StoreConcurrentUpdateError,
  StoreCorruptError,
  StoreInvalidLineageError,
  StoreIoError,
  StoreInvalidRecordError,
  StoreNotFoundError,
  StoreTransitionRefusedError,
  createState,
  listLineages,
  readReceipt,
  readState,
  storeRootFor,
  updateState,
  writeAtomic,
  writeReceipt,
} from "./store.js";
import { bump, counterOf, patchRename } from "./store-child.testkit.js";

const KIT = fileURLToPath(new URL("./store-child.testkit.js", import.meta.url));
const CRASH_KIT = fileURLToPath(new URL("./store-crash.testkit.js", import.meta.url));
const T0 = "2026-11-19T10:00:00.000Z";
const T1 = "2026-11-19T10:05:00.000Z";
const hex = (c: string, n: number) => c.repeat(n).slice(0, n);
const LINEAGE = `review-${hex("a", 16)}`;
const ZERO_ID = `sha256:${hex("0", 64)}`;

function mkRecord(lineage = LINEAGE, targetIdentity = ZERO_ID): StateRecord {
  const out = start({
    lineageId: lineage,
    targetIdentity,
    projection: "workspace",
    baseTree: hex("b", 40),
    candidateTree: hex("c", 40),
    riskLevel: "medium",
    selectedLenses: ["reliability"],
    originalChangedLines: 8,
    now: T0,
  });
  assert.equal(out.ok, true);
  return (out as { ok: true; record: StateRecord }).record;
}

function tmp(): { commonDir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "odd-store-"));
  const commonDir = join(dir, "common.git");
  mkdirSync(commonDir);
  return { commonDir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const mode = (p: string) => lstatSync(p).mode & 0o777;
const stateFile = (commonDir: string, lineage = LINEAGE) => join(storeRootFor(commonDir), lineage, "review-state.json");
const bytes = (p: string) => readFileSync(p);
const noTemps = (commonDir: string, lineage = LINEAGE) => readdirSync(join(storeRootFor(commonDir), lineage)).filter((n) => n.startsWith(".atomic-"));

async function rejects<T extends Error>(p: Promise<unknown>, cls: new (...a: never[]) => T): Promise<T> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof cls, `expected ${cls.name}, got ${(e as Error)?.name}: ${(e as Error)?.message}`);
    return e as T;
  }
  assert.fail(`expected ${cls.name}`);
}
function throws<T extends Error>(fn: () => unknown, cls: new (...a: never[]) => T): T {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof cls, `expected ${cls.name}, got ${(e as Error)?.name}: ${(e as Error)?.message}`);
    return e as T;
  }
  assert.fail(`expected ${cls.name}`);
}

test("layout under <common-dir>/odd-plugin/review-transactions/v2, root 0700, files 0600, create/read/update round-trip", async () => {
  const t = tmp();
  try {
    const rec = mkRecord();
    const created = await createState(t.commonDir, rec);
    assert.deepEqual(created, rec);
    const root = join(t.commonDir, "odd-plugin", "review-transactions", "v2");
    assert.equal(storeRootFor(t.commonDir), root);
    assert.equal(mode(root), 0o700);
    assert.equal(mode(join(root, LINEAGE)), 0o700);
    assert.equal(mode(stateFile(t.commonDir)), 0o600);
    assert.equal(bytes(stateFile(t.commonDir)).toString("utf8"), `${canonicalJson(rec)}\n`);
    assert.deepEqual(readState(t.commonDir, LINEAGE), rec);

    const next = await updateState(t.commonDir, LINEAGE, rec.revision, (r) => admitLensResult(r, { lens: "reliability", findings: [], resultHash: `sha256:${hex("1", 64)}`, now: T1 }));
    assert.equal(next.ok, true);
    assert.notEqual(next.record.revision, rec.revision);
    assert.deepEqual(readState(t.commonDir, LINEAGE), next.record);
    assert.equal(mode(stateFile(t.commonDir)), 0o600);
    assert.deepEqual(noTemps(t.commonDir), []);
  } finally {
    t.done();
  }
});

test("createState refuses an existing lineage and leaves the file untouched", async () => {
  const t = tmp();
  try {
    const rec = mkRecord();
    await createState(t.commonDir, rec);
    const before = bytes(stateFile(t.commonDir));
    const other = mkRecord(LINEAGE, `sha256:${hex("7", 64)}`);
    await rejects(createState(t.commonDir, other), StoreAlreadyExistsError);
    assert.deepEqual(bytes(stateFile(t.commonDir)), before);
  } finally {
    t.done();
  }
});

test("createState refuses an invalid record or a bad revision and writes nothing", async () => {
  const t = tmp();
  try {
    const rec = mkRecord();
    await rejects(createState(t.commonDir, { ...rec, revision: `sha256:${hex("9", 64)}` }), StoreInvalidRecordError);
    await rejects(createState(t.commonDir, { ...rec, extra: 1 } as unknown as StateRecord), StoreInvalidRecordError);
    assert.deepEqual(listLineages(t.commonDir), { lineages: [], truncated: false });
    assert.equal(existsSync(join(storeRootFor(t.commonDir), LINEAGE)), false);
  } finally {
    t.done();
  }
});

test("CAS mismatch: ConcurrentUpdate carries the current revision and the file is unchanged", async () => {
  const t = tmp();
  try {
    const rec = mkRecord();
    await createState(t.commonDir, rec);
    const one = await updateState(t.commonDir, LINEAGE, rec.revision, bump);
    assert.equal(one.ok, true);
    const before = bytes(stateFile(t.commonDir));
    let called = false;
    const err = await rejects(
      updateState(t.commonDir, LINEAGE, rec.revision, (r) => {
        called = true;
        return bump(r);
      }),
      StoreConcurrentUpdateError,
    );
    assert.equal(err.code, "STORE_CONCURRENT_UPDATE");
    assert.equal(err.expectedRevision, rec.revision);
    assert.equal(err.currentRevision, one.record.revision);
    assert.equal(called, false, "transition must not run on a CAS mismatch");
    assert.deepEqual(bytes(stateFile(t.commonDir)), before);
    assert.deepEqual(noTemps(t.commonDir), []);
  } finally {
    t.done();
  }
});

test("a refused transition and an invalid transition result leave the file unchanged", async () => {
  const t = tmp();
  try {
    const rec = mkRecord();
    await createState(t.commonDir, rec);
    const before = bytes(stateFile(t.commonDir));
    const refused = await rejects(updateState(t.commonDir, LINEAGE, rec.revision, (r) => burn(r, { now: T1, receipt: `sha256:${hex("2", 64)}` } as never)), StoreTransitionRefusedError);
    assert.ok(refused.refusal.code.length > 0);
    await rejects(updateState(t.commonDir, LINEAGE, rec.revision, (r) => ({ ok: true, record: { ...r, state: "approved" } as StateRecord })), StoreInvalidRecordError);
    await rejects(updateState(t.commonDir, LINEAGE, rec.revision, (r) => {
      const moved = { ...r, lineage_id: `review-${hex("b", 16)}` };
      moved.revision = stateRevision(moved);
      return { ok: true, record: moved };
    }), StoreInvalidRecordError);
    assert.deepEqual(bytes(stateFile(t.commonDir)), before);
    assert.deepEqual(noTemps(t.commonDir), []);
    void approve;
  } finally {
    t.done();
  }
});

test("readState/updateState on a missing lineage or store: NotFound, and nothing is created", async () => {
  const t = tmp();
  try {
    throws(() => readState(t.commonDir, LINEAGE), StoreNotFoundError);
    await rejects(updateState(t.commonDir, LINEAGE, `sha256:${hex("1", 64)}`, bump), StoreNotFoundError);
    assert.equal(existsSync(join(t.commonDir, "odd-plugin")), false);
    assert.deepEqual(listLineages(t.commonDir), { lineages: [], truncated: false });
  } finally {
    t.done();
  }
});

test("corrupt or unsafe state files raise typed errors, are never repaired, and update refuses them", async () => {
  const t = tmp();
  try {
    const rec = mkRecord();
    await createState(t.commonDir, rec);
    const file = stateFile(t.commonDir);
    const good = readFileSync(file, "utf8");
    const parsed = JSON.parse(good) as Record<string, unknown>;
    const other = join(t.commonDir, "elsewhere.json");
    writeFileSync(other, good);

    const cases: Array<[string, (f: string) => void, string]> = [
      ["empty", (f) => writeFileSync(f, ""), "invalid-json"],
      ["truncated", (f) => writeFileSync(f, good.slice(0, Math.floor(good.length / 2))), "invalid-json"],
      ["not json", (f) => writeFileSync(f, "garbage"), "invalid-json"],
      ["array", (f) => writeFileSync(f, "[]"), "invalid-record"],
      ["bad revision", (f) => writeFileSync(f, JSON.stringify({ ...parsed, revision: `sha256:${hex("9", 64)}` })), "revision-mismatch"],
      ["content edited, revision kept", (f) => writeFileSync(f, JSON.stringify({ ...parsed, updated_at: T1 })), "revision-mismatch"],
      ["unknown field", (f) => writeFileSync(f, JSON.stringify({ ...parsed, sneaky: true })), "invalid-record"],
      ["missing field", (f) => writeFileSync(f, JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== "findings")))), "invalid-record"],
      ["lineage mismatch", (f) => writeFileSync(f, canonicalJson(mkRecord(`review-${hex("b", 16)}`))), "lineage-mismatch"],
      ["symlink", (f) => symlinkSync(other, f), "not-regular"],
      ["directory", (f) => mkdirSync(f), "not-regular"],
      ["fifo", (f) => assert.equal(spawnSync("mkfifo", [f]).status, 0), "not-regular"],
      ["oversized", (f) => writeFileSync(f, Buffer.alloc(MAX_STATE_BYTES + 1, 0x20)), "oversized"],
    ];
    for (const [name, corrupt, kind] of cases) {
      rmSync(file, { recursive: true, force: true });
      corrupt(file);
      const snapshot = lstatSync(file).isFile() ? bytes(file) : undefined;
      const e = throws(() => readState(t.commonDir, LINEAGE), StoreCorruptError);
      assert.equal(e.kind, kind, `${name}: ${e.message}`);
      assert.equal(e.code, "STORE_CORRUPT");
      assert.ok(e.path.endsWith("review-state.json"));
      await rejects(updateState(t.commonDir, LINEAGE, rec.revision, bump), StoreCorruptError);
      await rejects(createState(t.commonDir, rec), StoreAlreadyExistsError);
      if (snapshot) assert.deepEqual(bytes(file), snapshot, `${name}: file must not be repaired`);
      assert.deepEqual(noTemps(t.commonDir), [], name);
    }
    assert.equal(bytes(other).toString(), good, "symlink target untouched");
  } finally {
    t.done();
  }
});

test("a symlinked lineage directory or store root is refused", async () => {
  const t = tmp();
  try {
    const rec = mkRecord();
    await createState(t.commonDir, rec);
    const root = storeRootFor(t.commonDir);
    const real = join(root, LINEAGE);
    const link = `review-${hex("c", 16)}`;
    symlinkSync(real, join(root, link));
    throws(() => readState(t.commonDir, link), StoreCorruptError);
    await rejects(createState(t.commonDir, mkRecord(link)), StoreAlreadyExistsError);
    assert.deepEqual(listLineages(t.commonDir).lineages, [LINEAGE], "symlinked lineage ignored by the listing");

    const t2 = tmp();
    try {
      mkdirSync(join(t2.commonDir, "odd-plugin"), { recursive: true });
      const target = join(t2.commonDir, "real-root");
      mkdirSync(target);
      mkdirSync(join(t2.commonDir, "odd-plugin", "review-transactions"));
      symlinkSync(target, join(t2.commonDir, "odd-plugin", "review-transactions", "v2"));
      await rejects(createState(t2.commonDir, rec), StoreCorruptError);
      assert.deepEqual(readdirSync(target), []);
    } finally {
      t2.done();
    }
  } finally {
    t.done();
  }
});

test("lineage ids are validated: traversal and malformed ids are refused everywhere", async () => {
  const t = tmp();
  try {
    const rec = mkRecord();
    await createState(t.commonDir, rec);
    const bad = ["../x", "..", ".", "", "review-../../etc", "review-AAAAAAAAAAAAAAAA", "review-aaaaaaaaaaaaaaa", "review-aaaaaaaaaaaaaaaaa", `${LINEAGE}/..`, `${LINEAGE}\0`, "/abs/path", "review-aaaaaaaaaaaaaaaa/../review-aaaaaaaaaaaaaaaa"];
    for (const id of bad) {
      throws(() => readState(t.commonDir, id), StoreInvalidLineageError);
      await rejects(updateState(t.commonDir, id, rec.revision, bump), StoreInvalidLineageError);
      await rejects(createState(t.commonDir, { ...rec, lineage_id: id }), StoreInvalidLineageError);
      await rejects(writeReceipt(t.commonDir, id, { a: 1 }), StoreInvalidLineageError);
      throws(() => readReceipt(t.commonDir, id), StoreInvalidLineageError);
    }
    assert.deepEqual(readdirSync(t.commonDir).sort(), ["odd-plugin"]);
    assert.deepEqual(readdirSync(storeRootFor(t.commonDir)).filter((n) => n !== "LOCK"), [LINEAGE]);
  } finally {
    t.done();
  }
});

test("writeReceipt is atomic and create-only, mode 0600; readReceipt round-trips", async () => {
  const t = tmp();
  try {
    const rec = mkRecord();
    await createState(t.commonDir, rec);
    const receipt = { schema: "odd-claude.review-receipt/v1", lineage_id: LINEAGE, z: 1, a: [1, 2] };
    await writeReceipt(t.commonDir, LINEAGE, receipt);
    const file = join(storeRootFor(t.commonDir), LINEAGE, "review-receipt.json");
    assert.equal(mode(file), 0o600);
    assert.equal(bytes(file).toString("utf8"), `${canonicalJson(receipt)}\n`);
    assert.deepEqual(readReceipt(t.commonDir, LINEAGE), receipt);
    const before = bytes(file);
    await rejects(writeReceipt(t.commonDir, LINEAGE, { other: true }), StoreAlreadyExistsError);
    assert.deepEqual(bytes(file), before);
    assert.deepEqual(noTemps(t.commonDir), []);
    await rejects(writeReceipt(t.commonDir, `review-${hex("d", 16)}`, { a: 1 }), StoreNotFoundError);
    await rejects(writeReceipt(t.commonDir, LINEAGE, [1] as never), StoreInvalidRecordError);
  } finally {
    t.done();
  }
});

test("listLineages is bounded and ignores junk", async () => {
  const t = tmp();
  try {
    assert.deepEqual(listLineages(t.commonDir), { lineages: [], truncated: false });
    const a = `review-${hex("a", 16)}`;
    const b = `review-${hex("b", 16)}`;
    await createState(t.commonDir, mkRecord(b));
    await createState(t.commonDir, mkRecord(a));
    const root = storeRootFor(t.commonDir);
    mkdirSync(join(root, "review-short"));
    mkdirSync(join(root, "junk"));
    writeFileSync(join(root, `review-${hex("c", 16)}`), "a file, not a lineage dir");
    writeFileSync(join(root, ".DS_Store"), "x");
    assert.deepEqual(listLineages(t.commonDir), { lineages: [a, b], truncated: false });
    assert.deepEqual(listLineages(t.commonDir, { limit: 2 }), { lineages: [a, b], truncated: false }, "junk never counts against the limit");
    assert.deepEqual(listLineages(t.commonDir, { limit: 1 }), { lineages: [a], truncated: true });
  } finally {
    t.done();
  }
});

test("writeAtomic: a failure before rename cleans the temp and keeps the previous file", () => {
  const t = tmp();
  try {
    const dir = join(t.commonDir, "d");
    mkdirSync(dir);
    const file = join(dir, "f.json");
    writeAtomic(file, Buffer.from("old"));
    assert.equal(mode(file), 0o600);
    const restore = patchRename(() => {
      throw new Error("boom");
    });
    try {
      assert.throws(() => writeAtomic(file, Buffer.from("new")), /boom/);
    } finally {
      restore();
    }
    assert.equal(readFileSync(file, "utf8"), "old");
    assert.deepEqual(readdirSync(dir), ["f.json"]);
    assert.equal(typeof (fs.renameSync as unknown), "function");
  } finally {
    t.done();
  }
});

interface ChildResult { code: number | null; stderr: string }
function runChild(args: string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [KIT, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    c.stderr.on("data", (d: Buffer) => (stderr += d));
    c.on("error", reject);
    c.on("close", (code) => resolve({ code, stderr }));
  });
}

test("concurrent updaters in several processes: no lost update, every write applied or rejected with ConcurrentUpdate", { timeout: 120_000 }, async () => {
  const t = tmp();
  try {
    const rec = mkRecord();
    await createState(t.commonDir, rec);
    const N = 4;
    const M = 15;
    const logs = Array.from({ length: N }, (_, i) => join(t.commonDir, `log-${i}.txt`));
    const results = await Promise.all(logs.map((log) => runChild(["loop", t.commonDir, LINEAGE, String(M), log, "3"])));
    for (const r of results) assert.deepEqual(r, { code: 0, stderr: "" });

    const lines = logs.flatMap((l) => readFileSync(l, "utf8").split("\n").filter(Boolean));
    assert.ok(!lines.some((l) => l.startsWith("fatal")), lines.filter((l) => l.startsWith("fatal")).join("\n"));
    const oks = lines.filter((l) => l.startsWith("ok ")).map((l) => l.split(" ") as [string, string, string]);
    const conflicts = lines.filter((l) => l.startsWith("conflict ")).map((l) => l.split(" ") as [string, string, string]);
    assert.equal(oks.length, N * M);
    assert.ok(conflicts.length > 0, "stale attempts must be rejected");
    for (const [, expected, current] of conflicts) assert.notEqual(expected, current);

    const fromTo = new Map<string, string>();
    for (const [, from, to] of oks) {
      assert.equal(fromTo.has(from), false, "two writes applied from the same predecessor revision (lost update)");
      fromTo.set(from, to);
    }
    let cur = rec.revision;
    for (let i = 0; i < N * M; i++) {
      const nx = fromTo.get(cur);
      assert.ok(nx, `broken chain at step ${i}`);
      cur = nx;
    }
    assert.equal(fromTo.has(cur), false);
    const final = readState(t.commonDir, LINEAGE);
    assert.equal(final.revision, cur);
    assert.equal(counterOf(final), N * M);
    assert.equal(final.revision, stateRevision(final));
    assert.deepEqual(noTemps(t.commonDir), []);
    assert.equal(mode(stateFile(t.commonDir)), 0o600);
  } finally {
    t.done();
  }
});

test("kill -9 during writeAtomic: previous state intact, temp is never visible as state, the next update recovers and sweeps it", { timeout: 60_000 }, async () => {
  const t = tmp();
  try {
    const rec = mkRecord();
    await createState(t.commonDir, rec);
    const before = bytes(stateFile(t.commonDir));
    const ready = join(t.commonDir, "ready");
    const child = spawn(process.execPath, [KIT, "crash", t.commonDir, LINEAGE, ready], { stdio: "ignore" });
    const exited = new Promise<string | null>((res) => child.on("close", (_c, sig) => res(sig)));
    const deadline = Date.now() + 20_000;
    while (!existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.ok(existsSync(ready), "child never reached the pre-rename point");
    child.kill("SIGKILL");
    assert.equal(await exited, "SIGKILL");

    assert.deepEqual(bytes(stateFile(t.commonDir)), before);
    assert.deepEqual(readState(t.commonDir, LINEAGE), rec);
    assert.ok(noTemps(t.commonDir).length >= 1, "the orphaned temp proves the kill landed mid-write");
    assert.deepEqual(listLineages(t.commonDir).lineages, [LINEAGE]);

    const next = await updateState(t.commonDir, LINEAGE, rec.revision, bump, { lock: { timeoutMs: 10_000, pollMs: 10 } });
    assert.equal(counterOf(next.record), 1);
    assert.deepEqual(noTemps(t.commonDir), []);
    assert.deepEqual(readState(t.commonDir, LINEAGE), next.record);
  } finally {
    t.done();
  }
});

test("a read-only (0400) state file is still readable", async () => {
  const t = tmp();
  try {
    const rec = mkRecord();
    await createState(t.commonDir, rec);
    chmodSync(stateFile(t.commonDir), 0o400);
    assert.deepEqual(readState(t.commonDir, LINEAGE), rec);
    chmodSync(stateFile(t.commonDir), 0o600);
    truncateSync(stateFile(t.commonDir), bytes(stateFile(t.commonDir)).length);
    assert.deepEqual(readState(t.commonDir, LINEAGE), rec);
  } finally {
    t.done();
  }
});

test("m1: a hardlinked state file (nlink 2) is refused as not-regular and never rewritten", async () => {
  const t = tmp();
  try {
    const rec = mkRecord();
    await createState(t.commonDir, rec);
    const file = stateFile(t.commonDir);
    const outside = join(t.commonDir, "outside.json");
    linkSync(file, outside);
    const before = bytes(outside);
    const e = throws(() => readState(t.commonDir, LINEAGE), StoreCorruptError);
    assert.equal(e.kind, "not-regular");
    await rejects(updateState(t.commonDir, LINEAGE, rec.revision, bump), StoreCorruptError);
    assert.deepEqual(bytes(outside), before);
    assert.deepEqual(bytes(file), before);
    assert.equal(lstatSync(file).nlink, 2);
  } finally {
    t.done();
  }
});

test("m2: listLineages reports truncation when the scan cap is hit; limit counts only lineages", async () => {
  const t = tmp();
  try {
    await createState(t.commonDir, mkRecord(`review-${hex("a", 16)}`));
    await createState(t.commonDir, mkRecord(`review-${hex("b", 16)}`));
    const root = storeRootFor(t.commonDir);
    for (let i = 0; i < 20; i++) writeFileSync(join(root, `junk-${i}`), "x");
    const full = listLineages(t.commonDir);
    assert.deepEqual(full, { lineages: [`review-${hex("a", 16)}`, `review-${hex("b", 16)}`], truncated: false });
    const capped = listLineages(t.commonDir, { maxScan: 5 });
    assert.equal(capped.truncated, true);
    assert.ok(capped.lineages.length <= 2);
    assert.equal(listLineages(t.commonDir, { maxScan: 1000 }).truncated, false);
  } finally {
    t.done();
  }
});

test("m3: filesystem failures surface as typed StoreIoError (missing common dir, unreadable root)", async () => {
  const t = tmp();
  try {
    const e = await rejects(createState(join(t.commonDir, "nope"), mkRecord()), StoreIoError);
    assert.equal(e.code, "STORE_IO");
    assert.equal(e.errno, "ENOENT");
    assert.equal(existsSync(join(t.commonDir, "nope")), false);
    if (process.getuid?.() === 0) return;
    await createState(t.commonDir, mkRecord());
    const root = storeRootFor(t.commonDir);
    chmodSync(root, 0);
    try {
      const l = throws(() => listLineages(t.commonDir), StoreIoError);
      assert.equal(l.errno, "EACCES");
      const r = throws(() => readState(t.commonDir, LINEAGE), StoreIoError);
      assert.equal(r.errno, "EACCES");
    } finally {
      chmodSync(root, 0o700);
    }
  } finally {
    t.done();
  }
});

test("m5: writeReceipt requires a valid state for the lineage", async () => {
  const t = tmp();
  try {
    await createState(t.commonDir, mkRecord());
    const empty = `review-${hex("e", 16)}`;
    mkdirSync(join(storeRootFor(t.commonDir), empty), { mode: 0o700 });
    await rejects(writeReceipt(t.commonDir, empty, { a: 1 }), StoreNotFoundError);
    assert.equal(existsSync(join(storeRootFor(t.commonDir), empty, "review-receipt.json")), false);
    writeFileSync(stateFile(t.commonDir), "garbage");
    await rejects(writeReceipt(t.commonDir, LINEAGE, { a: 1 }), StoreCorruptError);
    assert.equal(existsSync(join(storeRootFor(t.commonDir), LINEAGE, "review-receipt.json")), false);
    assert.deepEqual(noTemps(t.commonDir), []);
  } finally {
    t.done();
  }
});

function treeSnapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    const st = lstatSync(p);
    out.push(`${p.slice(root.length)}:${st.mode.toString(8)}:${st.isFile() ? readFileSync(p, "latin1") : ""}`);
    if (st.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n));
  };
  walk(root);
  return out;
}

test("hostile namespace segments (symlink or file) make all 6 APIs throw StoreCorruptError and leave the real tree unchanged", async () => {
  const rec = mkRecord();
  for (const seg of ["odd-plugin", "odd-plugin/review-transactions", "odd-plugin/review-transactions/v2"]) {
    for (const kind of ["symlink", "file"]) {
      const t = tmp();
      try {
        await createState(t.commonDir, rec);
        const p = join(t.commonDir, seg);
        const moved = join(t.commonDir, "moved-real");
        fs.renameSync(p, moved);
        if (kind === "symlink") symlinkSync(moved, p);
        else writeFileSync(p, "x");
        const before = treeSnapshot(moved);
        const tag = `${kind}:${seg}`;
        assert.ok((() => { try { readState(t.commonDir, LINEAGE); } catch (e) { return e instanceof StoreCorruptError; } return false; })(), `readState ${tag}`);
        await rejects(updateState(t.commonDir, LINEAGE, rec.revision, bump), StoreCorruptError);
        await rejects(createState(t.commonDir, rec), StoreCorruptError);
        await rejects(writeReceipt(t.commonDir, LINEAGE, { a: 1 }), StoreCorruptError);
        throws(() => readReceipt(t.commonDir, LINEAGE), StoreCorruptError);
        throws(() => listLineages(t.commonDir), StoreCorruptError);
        assert.deepEqual(treeSnapshot(moved), before, `real tree changed for ${tag}`);
      } finally {
        t.done();
      }
    }
  }
});

interface Spawned { code: number | null; out: string; err: string }
function spawnKit(file: string, args: string[]): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [file, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.on("data", (d: Buffer) => (out += d));
    c.stderr.on("data", (d: Buffer) => (err += d));
    c.on("error", reject);
    c.on("close", (code) => resolve({ code, out, err }));
  });
}

test("8 concurrent createState and 8 concurrent writeReceipt for one lineage: exactly one wins", { timeout: 60_000 }, async () => {
  const K = 8;
  const t = tmp();
  try {
    const rs = await Promise.all(Array.from({ length: K }, (_, i) => spawnKit(KIT, ["create", t.commonDir, LINEAGE, String(i + 1)])));
    const out = rs.map((r) => {
      assert.equal(r.code, 0, r.err);
      return JSON.parse(r.out) as { ok: boolean; name?: string };
    });
    const wins = out.map((r, i) => [r, i + 1] as const).filter(([r]) => r.ok);
    assert.equal(wins.length, 1);
    for (const r of out.filter((x) => !x.ok)) assert.equal(r.name, "StoreAlreadyExistsError");
    assert.equal(counterOf(readState(t.commonDir, LINEAGE)), wins[0]![1]);
    assert.deepEqual(noTemps(t.commonDir), []);
  } finally {
    t.done();
  }
  const t2 = tmp();
  try {
    await createState(t2.commonDir, mkRecord());
    const rs = await Promise.all(Array.from({ length: K }, (_, i) => spawnKit(KIT, ["receipt", t2.commonDir, LINEAGE, String(i + 1)])));
    const out = rs.map((r) => {
      assert.equal(r.code, 0, r.err);
      return JSON.parse(r.out) as { ok: boolean; name?: string };
    });
    const wins = out.map((r, i) => [r, i + 1] as const).filter(([r]) => r.ok);
    assert.equal(wins.length, 1);
    for (const r of out.filter((x) => !x.ok)) assert.equal(r.name, "StoreAlreadyExistsError");
    assert.equal(readReceipt(t2.commonDir, LINEAGE).writer, String(wins[0]![1]));
    assert.deepEqual(noTemps(t2.commonDir), []);
  } finally {
    t2.done();
  }
});

test("kill -9 at every fs call of create/update/receipt (before and after): old, new or NotFound, next mutation succeeds, no temps left", { timeout: 150_000 }, async () => {
  const setup = async (op: string): Promise<string> => {
    const t = tmp();
    cleanups.push(t.done);
    if (op !== "create") await createState(t.commonDir, mkRecord());
    return t.commonDir;
  };
  const cleanups: Array<() => void> = [];
  const L = { lock: { timeoutMs: 10_000, pollMs: 5 } };
  const temps = (cd: string): string[] => {
    try {
      return readdirSync(join(storeRootFor(cd), LINEAGE)).filter((n) => n.startsWith(".atomic-"));
    } catch {
      return [];
    }
  };
  const settle = async <T>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: Error }> => p.then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, e }));
  const trySync = <T>(f: () => T): { ok: true; v: T } | { ok: false; e: Error } => {
    try {
      return { ok: true, v: f() };
    } catch (e) {
      return { ok: false, e: e as Error };
    }
  };
  async function check(op: string, cd: string): Promise<string | undefined> {
    if (op === "create") {
      const rs = trySync(() => readState(cd, LINEAGE));
      if (!rs.ok && !(rs.e instanceof StoreNotFoundError)) return `read ${rs.e.name}`;
      const ls = trySync(() => listLineages(cd));
      if (!ls.ok) return `list ${ls.e.name}`;
      const nx = rs.ok ? await settle(updateState(cd, LINEAGE, rs.v.revision, bump, L)) : await settle(createState(cd, mkRecord(), L));
      if (!nx.ok) return `next ${nx.e.name}: ${nx.e.message}`;
      if (temps(cd).length) return "temps not swept";
      return counterOf(readState(cd, LINEAGE)) === (rs.ok ? 1 : 0) ? undefined : "counter";
    }
    if (op === "update") {
      const rs = trySync(() => readState(cd, LINEAGE));
      if (!rs.ok) return `read ${rs.e.name}`;
      const c0 = counterOf(rs.v);
      if (c0 !== 0 && c0 !== 1) return `counter ${c0}`;
      const nx = await settle(updateState(cd, LINEAGE, rs.v.revision, bump, L));
      if (!nx.ok) return `next ${nx.e.name}: ${nx.e.message}`;
      if (temps(cd).length) return "temps not swept";
      return counterOf(readState(cd, LINEAGE)) === c0 + 1 ? undefined : "counter after";
    }
    const rr = trySync(() => readReceipt(cd, LINEAGE));
    if (!rr.ok && !(rr.e instanceof StoreNotFoundError)) return `readReceipt ${rr.e.name}`;
    if (rr.ok && String(rr.v.r).length !== 5000) return "partial receipt";
    const nx = await settle(writeReceipt(cd, LINEAGE, { r: "x".repeat(5000) }, L));
    if (rr.ok && (nx.ok || !(nx.e instanceof StoreAlreadyExistsError))) return "rewrite of an existing receipt was not refused";
    if (!rr.ok && !nx.ok) return `next ${nx.e.name}: ${nx.e.message}`;
    const up = await settle(updateState(cd, LINEAGE, readState(cd, LINEAGE).revision, bump, L));
    if (!up.ok) return `update after ${up.e.name}: ${up.e.message}`;
    return temps(cd).length ? "temps not swept after update" : undefined;
  }
  try {
    const failures: string[] = [];
    let cases = 0;
    for (const op of ["create", "update", "receipt"]) {
      const probe = await spawnKit(CRASH_KIT, [op, await setup(op), LINEAGE, "0", "none"]);
      assert.equal(probe.code, 0, probe.err);
      const { n, labels } = JSON.parse(probe.out) as { n: number; labels: string[] };
      assert.ok(n >= 8, `${op}: only ${n} fs events counted`);
      assert.ok(labels.some((l) => l.startsWith("rename")), `${op}: no rename counted`);
      if (op === "create") assert.ok(labels.filter((l) => l === "fsyncSync").length >= 6, `create must fsync the 3 namespace dirs, the lineage dir, the file and its dir: ${labels.join(",")}`);
      const jobs: Array<[number, string]> = [];
      for (let k = 1; k <= n; k++) for (const phase of ["before", "after"]) jobs.push([k, phase]);
      for (let i = 0; i < jobs.length; i += 8) {
        await Promise.all(
          jobs.slice(i, i + 8).map(async ([k, phase]) => {
            cases++;
            const cd = await setup(op);
            const r = await new Promise<string | null>((res, rej) => {
              const c = spawn(process.execPath, [CRASH_KIT, op, cd, LINEAGE, String(k), phase], { stdio: "ignore" });
              c.on("error", rej);
              c.on("close", (_code, sig) => res(sig));
            });
            const tag = `${op} k=${k}(${labels[k - 1]}) ${phase}`;
            if (r !== "SIGKILL") return void failures.push(`NOKILL ${tag}`);
            const problem = await check(op, cd);
            if (problem) failures.push(`${tag}: ${problem}`);
          }),
        );
      }
    }
    assert.ok(cases >= 60, `only ${cases} crash cases`);
    assert.deepEqual(failures, []);
  } finally {
    for (const done of cleanups) done();
  }
});
