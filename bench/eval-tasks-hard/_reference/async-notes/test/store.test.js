import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, applyOps } from "../src/index.js";

test("get, set, has and delete", async () => {
  const store = new MemoryStore();
  assert.equal(await store.get("a"), undefined);
  await store.set("a", { n: 1 });
  assert.deepEqual(await store.get("a"), { n: 1 });
  assert.equal(await store.has("a"), true);
  assert.equal(await store.delete("a"), true);
  assert.equal(await store.delete("a"), false);
  assert.equal(await store.has("a"), false);
});

test("values are copied", async () => {
  const store = new MemoryStore();
  const value = { n: 1 };
  await store.set("a", value);
  value.n = 2;
  assert.deepEqual(await store.get("a"), { n: 1 });
});

test("keys filters by prefix", async () => {
  const store = new MemoryStore();
  await store.set("x:1", 1);
  await store.set("x:2", 2);
  await store.set("y:1", 3);
  assert.deepEqual(await store.keys("x:"), ["x:1", "x:2"]);
  assert.equal((await store.keys()).length, 3);
});

test("applyOps runs operations in order", async () => {
  const store = new MemoryStore();
  const results = await applyOps(store, [
    { type: "set", args: ["k", 5] },
    { type: "get", args: ["k"] },
    { type: "has", args: ["nope"] },
  ]);
  assert.deepEqual(results, [undefined, 5, false]);
  await assert.rejects(() => applyOps(store, [{ type: "clear", args: [] }]), /Unknown op: clear/);
});
