import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.js";

test("notes get sequential ids and can be listed and removed", async () => {
  const { notes } = createApp();
  const a = await notes.create({ title: "first" });
  const b = await notes.create({ title: "second", body: "text", tags: ["x"] });
  assert.deepEqual([a.id, b.id], [1, 2]);
  assert.deepEqual(await notes.get(2), { id: 2, title: "second", body: "text", tags: ["x"] });
  assert.equal(await notes.get(9), null);
  assert.deepEqual((await notes.list()).map((n) => n.id), [1, 2]);
  assert.equal(await notes.remove(1), true);
  assert.equal(await notes.remove(1), false);
});

test("tags and tag lookups", async () => {
  const { notes, tags } = createApp();
  await notes.create({ title: "a", tags: ["red"] });
  await notes.create({ title: "b", tags: ["blue", "red"] });
  await notes.create({ title: "c" });
  assert.deepEqual((await tags.notesByTag("red")).map((n) => n.id), [1, 2]);
  assert.deepEqual(await tags.allTags(), ["blue", "red"]);
  assert.equal((await notes.addTag(3, "blue")).tags[0], "blue");
  assert.equal(await notes.addTag(99, "x"), null);
});

test("stats summarize the notes", async () => {
  const { notes, stats } = createApp();
  await notes.create({ title: "hello world", body: "one two three", tags: ["a"] });
  await notes.create({ title: "x", tags: ["a", "b"] });
  assert.deepEqual(await stats.summary(), { notes: 2, tags: 2, words: 6 });
});
