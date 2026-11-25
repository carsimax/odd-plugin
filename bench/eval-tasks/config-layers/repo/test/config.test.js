import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/index.js";

test("file values override defaults", () => {
  assert.deepEqual(loadConfig({ a: 1, b: 2 }, { b: 3 }), { a: 1, b: 3 });
});

test("missing arguments are treated as empty", () => {
  assert.deepEqual(loadConfig(), {});
});
