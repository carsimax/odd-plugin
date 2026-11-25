import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.js";

test("notes get sequential ids and can be listed and removed", () => {
  const { notes } = createApp();
  const a = notes.create({ title: "first" });
  const b = notes.create({ title: "second", body: "text", tags: ["x"] });
  assert.deepEqual([a.id, b.id], [1, 2]);
  assert.deepEqual(notes.get(2), { id: 2, title: "second", body: "text", tags: ["x"] });
  assert.equal(notes.get(9), null);
  assert.deepEqual(notes.list().map((n) => n.id), [1, 2]);
  assert.equal(notes.remove(1), true);
  assert.equal(notes.remove(1), false);
});

test("tags and tag lookups", () => {
  const { notes, tags } = createApp();
  notes.create({ title: "a", tags: ["red"] });
  notes.create({ title: "b", tags: ["blue", "red"] });
  notes.create({ title: "c" });
  assert.deepEqual(tags.notesByTag("red").map((n) => n.id), [1, 2]);
  assert.deepEqual(tags.allTags(), ["blue", "red"]);
  assert.equal(notes.addTag(3, "blue").tags[0], "blue");
  assert.equal(notes.addTag(99, "x"), null);
});

test("stats summarize the notes", () => {
  const { notes, stats } = createApp();
  notes.create({ title: "hello world", body: "one two three", tags: ["a"] });
  notes.create({ title: "x", tags: ["a", "b"] });
  assert.deepEqual(stats.summary(), { notes: 2, tags: 2, words: 6 });
});
