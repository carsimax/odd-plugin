import test from "node:test";
import assert from "node:assert/strict";
import { displayWidth, padCell, TableError, renderTable } from "../src/index.js";

test("displayWidth counts code points", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("héllo"), 5);
  assert.equal(displayWidth("a😀b"), 3);
  assert.equal(displayWidth(""), 0);
});

test("padCell pads on the requested side", () => {
  assert.equal(padCell("ab", 5), "ab   ");
  assert.equal(padCell("ab", 5, "right"), "   ab");
  assert.equal(padCell("abcdef", 3), "abcdef");
});

test("TableError is an Error with its own name", () => {
  const err = new TableError("boom");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "TableError");
  assert.equal(err.message, "boom");
});

test("renderTable is exported", () => {
  assert.equal(typeof renderTable, "function");
});
