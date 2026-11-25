import test from "node:test";
import assert from "node:assert/strict";
import { createApp, applyOps, MemoryStore } from "../../src/index.js";
import { SlowStore } from "../support/slow-store.js";

for (const [name, make] of [["MemoryStore", () => new MemoryStore()], ["a remote-like store", () => new SlowStore()]]) {
  test(`applyOps returns the results in order (${name})`, async () => {
    const store = make();
    const results = await applyOps(store, [
      { type: "set", args: ["k", 5] },
      { type: "get", args: ["k"] },
      { type: "has", args: ["nope"] },
      { type: "has", args: ["k"] },
      { type: "delete", args: ["k"] },
      { type: "get", args: ["k"] },
    ]);
    assert.deepEqual(results, [undefined, 5, false, true, true, undefined]);
  });

  test(`applyOps rejects unknown operations (${name})`, async () => {
    await assert.rejects(async () => applyOps(make(), [{ type: "clear", args: [] }]), /Unknown op: clear/);
  });

  test(`the import command skips taken ids and keeps the counter (${name})`, async () => {
    const app = createApp(make());
    await app.run(["add", "mine"]);
    const json = JSON.stringify([
      { id: 1, title: "clash", body: "", tags: [] },
      { id: 5, title: "new", body: "", tags: ["i"] },
      { id: 6, title: "newer", body: "", tags: [] },
    ]);
    assert.equal(await app.run(["import", json]), "Imported 2 notes, skipped 1");
    assert.equal(await app.run(["show", "1"]), "#1 mine\n");
    assert.equal(await app.run(["show", "5"]), "#5 new [i]\n");
    assert.equal(await app.run(["show", "6"]), "#6 newer\n");
    assert.equal(await app.run(["add", "next"]), "Added note 7");
  });
}

test("importing into an empty app stores everything", async () => {
  const app = createApp(new SlowStore());
  const json = JSON.stringify([{ id: 3, title: "t", body: "b", tags: [] }]);
  assert.equal(await app.run(["import", json]), "Imported 1 notes, skipped 0");
  assert.equal(await app.run(["list"]), "#3 t");
});
