import test from "node:test";
import assert from "node:assert/strict";
import { createApp, MemoryStore } from "../../src/index.js";
import { SlowStore } from "../support/slow-store.js";

test("every MemoryStore method returns a promise", async () => {
  const store = new MemoryStore();
  const set = store.set("a", { n: 1 });
  assert.ok(set instanceof Promise);
  await set;
  const calls = [store.get("a"), store.has("a"), store.keys("a"), store.delete("a")];
  for (const call of calls) assert.ok(call instanceof Promise);
  assert.deepEqual(await Promise.all(calls), [{ n: 1 }, true, ["a"], true]);
});

test("MemoryStore still copies values and filters keys", async () => {
  const store = new MemoryStore();
  const value = { n: 1 };
  await store.set("x:1", value);
  await store.set("y:1", 2);
  value.n = 9;
  assert.deepEqual(await store.get("x:1"), { n: 1 });
  assert.equal(await store.get("zzz"), undefined);
  assert.deepEqual(await store.keys("x:"), ["x:1"]);
  assert.equal(await store.delete("zzz"), false);
});

test("notes service works on an async store", async () => {
  const { notes } = createApp(new SlowStore());
  const a = await notes.create({ title: "first" });
  const b = await notes.create({ title: "second", body: "text", tags: ["x"] });
  assert.deepEqual([a.id, b.id], [1, 2]);
  assert.deepEqual(await notes.get(2), { id: 2, title: "second", body: "text", tags: ["x"] });
  assert.equal(await notes.get(9), null);
  assert.deepEqual((await notes.list()).map((n) => n.id), [1, 2]);
  assert.equal(await notes.remove(1), true);
  assert.equal(await notes.remove(1), false);
  assert.equal((await notes.addTag(2, "y")).tags.join(), "x,y");
  assert.equal(await notes.addTag(99, "y"), null);
});

test("tags and stats work on an async store", async () => {
  const { notes, tags, stats } = createApp(new SlowStore());
  await notes.create({ title: "hello world", body: "one two three", tags: ["red"] });
  await notes.create({ title: "b", tags: ["blue", "red"] });
  await notes.create({ title: "c" });
  assert.deepEqual((await tags.notesByTag("red")).map((n) => n.id), [1, 2]);
  assert.deepEqual((await tags.notesByTag("none")), []);
  assert.deepEqual(await tags.allTags(), ["blue", "red"]);
  assert.deepEqual(await stats.summary(), { notes: 3, tags: 2, words: 7 });
});

test("the cli commands work on an async store", async () => {
  const app = createApp(new SlowStore());
  assert.equal(await app.run(["add", "Groceries", "milk", "eggs"]), "Added note 1");
  assert.equal(await app.run(["show", "1"]), "#1 Groceries\nmilk eggs");
  assert.equal(await app.run(["tag", "1", "home"]), "Tagged note 1 with home");
  assert.equal(await app.run(["list"]), "#1 Groceries [home]");
  assert.equal(await app.run(["tags"]), "home");
  assert.equal(await app.run(["stats"]), "Notes: 1\nTags: 1\nWords: 3");
  assert.equal(await app.run(["rm", "1"]), "Removed note 1");
  assert.equal(await app.run(["list"]), "No notes.");
  assert.equal(await app.run(["rm", "1"]), "Note 1 not found");
});

test("unknown commands still reject with the same message", async () => {
  const app = createApp(new SlowStore());
  await assert.rejects(async () => app.run(["nope"]), /Unknown command: nope/);
});
