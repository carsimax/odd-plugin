import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, applyOps } from "../src/index.js";

test("get, set, has and delete", () => {
  const store = new MemoryStore();
  assert.equal(store.get("a"), undefined);
  store.set("a", { n: 1 });
  assert.deepEqual(store.get("a"), { n: 1 });
  assert.equal(store.has("a"), true);
  assert.equal(store.delete("a"), true);
  assert.equal(store.delete("a"), false);
  assert.equal(store.has("a"), false);
});

test("values are copied", () => {
  const store = new MemoryStore();
  const value = { n: 1 };
  store.set("a", value);
  value.n = 2;
  assert.deepEqual(store.get("a"), { n: 1 });
});

test("keys filters by prefix", () => {
  const store = new MemoryStore();
  store.set("x:1", 1);
  store.set("x:2", 2);
  store.set("y:1", 3);
  assert.deepEqual(store.keys("x:"), ["x:1", "x:2"]);
  assert.equal(store.keys().length, 3);
});

test("applyOps runs operations in order", () => {
  const store = new MemoryStore();
  const results = applyOps(store, [
    { type: "set", args: ["k", 5] },
    { type: "get", args: ["k"] },
    { type: "has", args: ["nope"] },
  ]);
  assert.deepEqual(results, [undefined, 5, false]);
  assert.throws(() => applyOps(store, [{ type: "clear", args: [] }]), /Unknown op: clear/);
});
