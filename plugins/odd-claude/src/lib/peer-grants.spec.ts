import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allow, grantsDir, isAllowed, listGrants, revoke, revokeAll } from "./peer-grants.js";
import { PeersError } from "./peers.js";

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const C = "cccccccc-3333-4333-8333-cccccccccccc";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "odd-grants-"));
}

test("closed by default: no grant file means nobody is allowed", () => {
  const dir = tmp();
  try {
    assert.equal(isAllowed(A, B, { dataDir: dir }), false);
    assert.deepEqual(listGrants(A, { dataDir: dir }), []);
    assert.equal(existsSync(join(dir, "peers")), false, "reading creates nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allow grants only that sender for that recipient; revoke removes it", () => {
  const dir = tmp();
  try {
    allow(A, B, { dataDir: dir });
    assert.equal(isAllowed(A, B, { dataDir: dir }), true);
    assert.equal(isAllowed(A, C, { dataDir: dir }), false);
    assert.equal(isAllowed(B, A, { dataDir: dir }), false, "not symmetric");
    allow(A, C, { dataDir: dir });
    allow(A, C, { dataDir: dir });
    assert.deepEqual(listGrants(A, { dataDir: dir }), [B, C].sort());
    revoke(A, B, { dataDir: dir });
    assert.equal(isAllowed(A, B, { dataDir: dir }), false);
    assert.equal(isAllowed(A, C, { dataDir: dir }), true);
    revokeAll(A, { dataDir: dir });
    assert.deepEqual(listGrants(A, { dataDir: dir }), []);
    assert.equal(existsSync(join(grantsDir({ dataDir: dir }), `${A}.json`)), false, "revokeAll removes the file");
    revokeAll(A, { dataDir: dir }); // idempotent
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid ids are refused with PeersError and nothing is written", () => {
  const dir = tmp();
  try {
    for (const bad of ["", "../x", "short", "a/b/c/d/e/f/g/h", "x".repeat(65), "-aaaaaaaaaa", "id with space", 5 as unknown as string]) {
      assert.throws(() => allow(A, bad, { dataDir: dir }), (e: unknown) => e instanceof PeersError && e.code === "invalid_session_id");
      assert.throws(() => allow(bad, A, { dataDir: dir }), (e: unknown) => e instanceof PeersError && e.code === "invalid_session_id");
      assert.equal(isAllowed(A, bad, { dataDir: dir }), false);
      assert.equal(isAllowed(bad, A, { dataDir: dir }), false);
    }
    assert.equal(existsSync(join(dir, "peers")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt, oversized or symlinked grant file is closed (nobody allowed)", () => {
  const dir = tmp();
  try {
    allow(A, B, { dataDir: dir });
    const f = join(grantsDir({ dataDir: dir }), `${A}.json`);
    writeFileSync(f, "{not json");
    assert.equal(isAllowed(A, B, { dataDir: dir }), false);
    writeFileSync(f, JSON.stringify({ v: 1, allow: [B], pad: "x".repeat(200_000) }));
    assert.equal(isAllowed(A, B, { dataDir: dir }), false);
    writeFileSync(f, JSON.stringify({ v: 1, allow: [B, "../evil"] }));
    assert.equal(isAllowed(A, B, { dataDir: dir }), true);
    assert.equal(isAllowed(A, "../evil", { dataDir: dir }), false);
    rmSync(f);
    const target = join(dir, "elsewhere.json");
    writeFileSync(target, JSON.stringify({ v: 1, allow: [B] }));
    symlinkSync(target, f);
    assert.equal(isAllowed(A, B, { dataDir: dir }), false, "symlinked grant file is never followed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confinement: a symlinked .grants or peers dir is refused, nothing is written through it", () => {
  const dir = tmp();
  const out = tmp();
  try {
    mkdirSync(join(dir, "peers"));
    symlinkSync(out, join(dir, "peers", ".grants"));
    assert.throws(() => allow(A, B, { dataDir: dir }), (e: unknown) => e instanceof PeersError && e.code === "unsafe_path");
    assert.throws(() => revoke(A, B, { dataDir: dir }), (e: unknown) => e instanceof PeersError && e.code === "unsafe_path");
    assert.equal(isAllowed(A, B, { dataDir: dir }), false);
    assert.deepEqual(readdirSync(out), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
  const d2 = tmp();
  const o2 = tmp();
  try {
    symlinkSync(o2, join(d2, "peers"));
    assert.throws(() => allow(A, B, { dataDir: d2 }), (e: unknown) => e instanceof PeersError && e.code === "unsafe_path");
    assert.deepEqual(readdirSync(o2), []);
  } finally {
    rmSync(d2, { recursive: true, force: true });
    rmSync(o2, { recursive: true, force: true });
  }
});

test("the grants dir does not show up as a mailbox", async () => {
  const dir = tmp();
  try {
    allow(A, B, { dataDir: dir });
    const { sessionIds } = await import("./peers.js");
    assert.deepEqual(sessionIds({ dataDir: dir }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the number of grants per recipient is capped", () => {
  const dir = tmp();
  try {
    for (let i = 0; i < 100; i++) allow(A, `sender-${String(i).padStart(4, "0")}`, { dataDir: dir });
    assert.throws(() => allow(A, "sender-9999", { dataDir: dir }), (e: unknown) => e instanceof PeersError);
    assert.equal(listGrants(A, { dataDir: dir }).length, 100);
    allow(A, "sender-0001", { dataDir: dir }); // an existing grant is still fine
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
