import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.js";

test("add, show, list, tag, rm", () => {
  const app = createApp();
  assert.equal(app.run(["add", "Groceries", "milk", "eggs"]), "Added note 1");
  assert.equal(app.run(["show", "1"]), "#1 Groceries\nmilk eggs");
  assert.equal(app.run(["tag", "1", "home"]), "Tagged note 1 with home");
  assert.equal(app.run(["list"]), "#1 Groceries [home]");
  assert.equal(app.run(["tags"]), "home");
  assert.equal(app.run(["rm", "1"]), "Removed note 1");
  assert.equal(app.run(["list"]), "No notes.");
  assert.equal(app.run(["rm", "1"]), "Note 1 not found");
});

test("stats and unknown commands", () => {
  const app = createApp();
  app.run(["add", "a", "b c"]);
  assert.equal(app.run(["stats"]), "Notes: 1\nTags: 0\nWords: 3");
  assert.throws(() => app.run(["nope"]), /Unknown command: nope/);
});

test("import skips ids that already exist", () => {
  const app = createApp();
  app.run(["add", "mine"]);
  const json = JSON.stringify([
    { id: 1, title: "clash", body: "", tags: [] },
    { id: 5, title: "new", body: "", tags: ["i"] },
  ]);
  assert.equal(app.run(["import", json]), "Imported 1 notes, skipped 1");
  assert.equal(app.run(["show", "1"]), "#1 mine\n");
  assert.equal(app.run(["show", "5"]), "#5 new [i]\n");
  assert.equal(app.run(["add", "next"]), "Added note 6");
});
